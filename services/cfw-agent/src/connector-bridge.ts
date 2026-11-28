import {
  type ConnectorProvider,
  ConnectorProviderSchema,
} from "@pi-in-the-sky/client/protocol";
import { RpcTarget } from "cloudflare:workers";

import { fetchJsonWithBearer, type HttpFetcher } from "./http-tool";
import type { SecretsFacetStore } from "./secrets-facet";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

const CONNECTOR_CONFIG: Record<
  ConnectorProvider,
  {
    readonly baseUrl: string;
    readonly label: string;
    readonly allowedOperations: readonly {
      readonly method: HttpMethod;
      readonly pathnamePattern: RegExp;
    }[];
  }
> = {
  gmail: {
    baseUrl: "https://gmail.googleapis.com/gmail/v1",
    label: "Gmail",
    allowedOperations: [
      { method: "GET", pathnamePattern: /^\/gmail\/v1\/users\/me\/messages$/ },
      {
        method: "GET",
        pathnamePattern: /^\/gmail\/v1\/users\/me\/messages\/[^/]+$/,
      },
      { method: "POST", pathnamePattern: /^\/gmail\/v1\/users\/me\/drafts$/ },
    ],
  },
  google_calendar: {
    baseUrl: "https://www.googleapis.com/calendar/v3",
    label: "Google Calendar",
    allowedOperations: [
      {
        method: "GET",
        pathnamePattern: /^\/calendar\/v3\/calendars\/primary\/events$/,
      },
    ],
  },
};

type ConnectorBridgeResponse =
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: false; readonly error: string };

export class ConnectorBridge extends RpcTarget {
  readonly #secrets: SecretsFacetStore;
  readonly #fetcher: HttpFetcher;

  constructor(secrets: SecretsFacetStore, fetcher: HttpFetcher) {
    super();
    this.#secrets = secrets;
    this.#fetcher = fetcher;
  }

  async request(
    rawProvider: string,
    apiPath: string,
    init?: {
      readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
      readonly body?: string;
    },
  ): Promise<ConnectorBridgeResponse> {
    const parsedProvider = ConnectorProviderSchema.safeParse(rawProvider);
    if (!parsedProvider.success) {
      return { ok: false, error: `Unsupported connector: "${rawProvider}".` };
    }
    const provider = parsedProvider.data;
    const config = CONNECTOR_CONFIG[provider];
    if (!apiPath.startsWith("/") || apiPath.startsWith("//")) {
      return {
        ok: false,
        error: "Connector apiPath must be a relative path starting with '/'.",
      };
    }
    const base = new URL(`${config.baseUrl}/`);
    const resolved = new URL(`${config.baseUrl}${apiPath}`);
    if (
      resolved.origin !== base.origin ||
      !resolved.pathname.startsWith(base.pathname)
    ) {
      return {
        ok: false,
        error: "Connector apiPath escaped the allowed provider API prefix.",
      };
    }
    const method: HttpMethod = init?.method ?? "GET";
    const allowed = config.allowedOperations.some(
      (op) =>
        op.method === method && op.pathnamePattern.test(resolved.pathname),
    );
    if (!allowed) {
      return {
        ok: false,
        error: `Operation ${method} ${resolved.pathname} is not permitted for ${config.label}.`,
      };
    }
    const token = await this.#secrets.getConnectorAccessToken(provider);
    if (!token) {
      return {
        ok: false,
        error: `${config.label} connector is not authorized.`,
      };
    }
    const result = await fetchJsonWithBearer(
      resolved.toString(),
      this.#fetcher,
      {
        token,
        init: {
          method,
          ...(init?.body !== undefined ? { body: init.body } : {}),
        },
      },
    );
    return result.ok
      ? { ok: true, data: result.value }
      : { ok: false, error: result.error };
  }
}
