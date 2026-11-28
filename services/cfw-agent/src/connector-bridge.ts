import {
  type ConnectorProvider,
  ConnectorProviderSchema,
} from "@pi-in-the-sky/client/protocol";
import { RpcTarget } from "cloudflare:workers";

import { fetchJsonWithBearer, type HttpFetcher } from "./http-tool";
import type { SecretsFacetStore } from "./secrets-facet";

const CONNECTOR_CONFIG: Record<
  ConnectorProvider,
  { readonly baseUrl: string; readonly label: string }
> = {
  gmail: {
    baseUrl: "https://gmail.googleapis.com/gmail/v1",
    label: "Gmail",
  },
  google_calendar: {
    baseUrl: "https://www.googleapis.com/calendar/v3",
    label: "Google Calendar",
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
          method: init?.method ?? "GET",
          ...(init?.body !== undefined ? { body: init.body } : {}),
        },
      },
    );
    return result.ok
      ? { ok: true, data: result.value }
      : { ok: false, error: result.error };
  }
}
