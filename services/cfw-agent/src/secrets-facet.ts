import type { ConnectorProvider } from "@pi-in-the-sky/client/protocol";
import { z } from "zod";

const HOST_SECRETS_FACET_NAME = "host:secrets";
const SECRETS_FACET_CLASS = "SecretsFacet";
const SECRETS_COMPAT_DATE = "2026-11-27";

const SECRETS_FACET_MODULE = `
import { DurableObject } from "cloudflare:workers";

export class ${SECRETS_FACET_CLASS} extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec(\`
      CREATE TABLE IF NOT EXISTS connector_tokens (
        provider TEXT PRIMARY KEY,
        access_token TEXT NOT NULL,
        refresh_token TEXT,
        expires_at INTEGER,
        updated_at INTEGER NOT NULL
      );
    \`);
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "PUT" && url.pathname === "/connector-token") {
      const body = await request.json();
      this.ctx.storage.sql.exec(
        \`INSERT INTO connector_tokens (provider, access_token, refresh_token, expires_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(provider) DO UPDATE SET
           access_token = excluded.access_token,
           refresh_token = excluded.refresh_token,
           expires_at = excluded.expires_at,
           updated_at = excluded.updated_at\`,
        body.provider,
        body.accessToken,
        body.refreshToken ?? null,
        body.expiresAt ?? null,
        Date.now(),
      );
      return Response.json({ ok: true });
    }
    if (request.method === "GET" && url.pathname === "/connector-token") {
      const provider = url.searchParams.get("provider") ?? "";
      const row = this.ctx.storage.sql
        .exec("SELECT access_token FROM connector_tokens WHERE provider = ?", provider)
        .toArray()[0];
      return Response.json({ accessToken: row?.access_token ?? null });
    }
    return new Response("Not found", { status: 404 });
  }
}
`;

const TokenResponseSchema = z.object({
  accessToken: z.string().nullable(),
});

export class SecretsFacetStore {
  readonly #getLoader: () => WorkerLoader | undefined;
  readonly #getFacets: () => DurableObjectFacets;

  constructor(
    getLoader: () => WorkerLoader | undefined,
    getFacets: () => DurableObjectFacets,
  ) {
    this.#getLoader = getLoader;
    this.#getFacets = getFacets;
  }

  #facet(): Fetcher | null {
    const loader = this.#getLoader();
    if (!loader) {
      return null;
    }
    return this.#getFacets().get(HOST_SECRETS_FACET_NAME, () => {
      const worker = loader.load({
        compatibilityDate: SECRETS_COMPAT_DATE,
        mainModule: "secrets-facet.js",
        modules: {
          "secrets-facet.js": SECRETS_FACET_MODULE,
        },
        globalOutbound: null,
      });
      return {
        class: worker.getDurableObjectClass(SECRETS_FACET_CLASS),
      };
    });
  }

  async setConnectorToken(
    provider: ConnectorProvider,
    accessToken: string,
    refreshToken?: string,
    expiresAt?: number,
  ): Promise<void> {
    const facet = this.#facet();
    if (!facet) {
      return;
    }
    const response = await facet.fetch(
      "https://secrets.internal/connector-token",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          accessToken,
          refreshToken,
          expiresAt,
        }),
      },
    );
    await response.text();
  }

  async getConnectorAccessToken(
    provider: ConnectorProvider,
  ): Promise<string | undefined> {
    const facet = this.#facet();
    if (!facet) {
      return undefined;
    }
    const response = await facet.fetch(
      `https://secrets.internal/connector-token?provider=${encodeURIComponent(provider)}`,
    );
    if (!response.ok) {
      return undefined;
    }
    const parsed = TokenResponseSchema.safeParse(await response.json());
    if (!parsed.success || parsed.data.accessToken === null) {
      return undefined;
    }
    return parsed.data.accessToken;
  }
}
