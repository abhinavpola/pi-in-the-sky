import { z } from "zod";

import {
  type CloudflareAccount,
  encodeFormBody,
  listCloudflareAccounts,
} from "./cloudflare-device-auth";
import {
  DEFAULT_WORKER_NAME,
  type DeployedWorker,
} from "./cloudflare-worker-api";
import { randomBase64Url, sha256Base64Url } from "./pkce";
import { AuthConfigResponseSchema } from "./protocol";

const ACCESS_REDIRECT_URI = "piinthesky://auth/callback";

const SubdomainResponseSchema = z.object({
  result: z.object({
    subdomain: z.string().min(1),
  }),
});

const OAuthTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
});

type WorkerStatus =
  | { readonly kind: "offline"; readonly reason: string }
  | { readonly kind: "live_no_oauth"; readonly baseUrl: string }
  | {
      readonly kind: "live_oauth_ready";
      readonly baseUrl: string;
      readonly teamDomain: string;
      readonly clientId: string;
    };

export type DiscoveredWorker = DeployedWorker;

type WorkerDiscoveryResult =
  | {
      readonly kind: "found";
      readonly matches: readonly DiscoveredWorker[];
      readonly accountCount: number;
    }
  | {
      readonly kind: "not_deployed";
      readonly deployableAccounts: readonly CloudflareAccount[];
    }
  | { readonly kind: "error"; readonly message: string };

type OAuthTokenResult =
  | {
      readonly ok: true;
      readonly accessToken: string;
      readonly refreshToken?: string;
    }
  | { readonly ok: false; readonly error: string };

type OAuthCallbackResult =
  | {
      readonly kind: "code";
      readonly code: string;
      readonly state: string | null;
    }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ignore" };

function normalizeTeamOrigin(teamDomain: string): string {
  const trimmed = teamDomain.trim().replace(/\/$/, "");
  return trimmed.startsWith("https://") ? trimmed : `https://${trimmed}`;
}

function parseQueryParams(url: string): Map<string, string> {
  const queryStart = url.indexOf("?");
  const params = new Map<string, string>();
  if (queryStart === -1) {
    return params;
  }
  const hashStart = url.indexOf("#", queryStart);
  const query =
    hashStart === -1
      ? url.slice(queryStart + 1)
      : url.slice(queryStart + 1, hashStart);
  for (const part of query.split("&")) {
    if (!part) {
      continue;
    }
    const eqIdx = part.indexOf("=");
    if (eqIdx === -1) {
      params.set(decodeURIComponent(part), "");
    } else {
      params.set(
        decodeURIComponent(part.slice(0, eqIdx)),
        decodeURIComponent(part.slice(eqIdx + 1)),
      );
    }
  }
  return params;
}

export type PkceSession = {
  readonly state: string;
  readonly codeVerifier: string;
  readonly codeChallenge: string;
};

export function createPkceSession(): PkceSession {
  const state = randomBase64Url(32);
  const codeVerifier = randomBase64Url(32);
  return {
    state,
    codeVerifier,
    codeChallenge: sha256Base64Url(codeVerifier),
  };
}

export function buildAccessAuthorizeUrl(
  teamDomain: string,
  clientId: string,
  pkce: PkceSession,
): string {
  const origin = normalizeTeamOrigin(teamDomain);
  const params: Record<string, string> = {
    client_id: clientId,
    response_type: "code",
    redirect_uri: ACCESS_REDIRECT_URI,
    scope: "openid email profile offline_access",
    state: pkce.state,
    code_challenge: pkce.codeChallenge,
    code_challenge_method: "S256",
  };
  return `${origin}/cdn-cgi/access/sso/oauth2/auth?${encodeFormBody(params)}`;
}

function parseOAuthCallbackUrl(url: string): OAuthCallbackResult {
  if (!url.startsWith(ACCESS_REDIRECT_URI)) {
    return { kind: "ignore" };
  }
  try {
    const params = parseQueryParams(url);
    const error = params.get("error");
    if (error) {
      const desc = params.get("error_description") ?? error;
      return { kind: "error", message: desc };
    }
    const code = params.get("code");
    if (!code) {
      return {
        kind: "error",
        message: "Missing authorization code in callback.",
      };
    }
    return {
      kind: "code",
      code,
      state: params.get("state") ?? null,
    };
  } catch {
    return { kind: "error", message: "Malformed OAuth callback URL." };
  }
}

async function postTokenEndpoint(
  teamDomain: string,
  params: Record<string, string>,
  fallbackRefreshToken?: string,
): Promise<OAuthTokenResult> {
  const origin = normalizeTeamOrigin(teamDomain);
  try {
    const response = await fetch(`${origin}/cdn-cgi/access/sso/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: encodeFormBody(params),
    });
    if (!response.ok) {
      return {
        ok: false,
        error: `OAuth token request failed (${response.status})`,
      };
    }
    const parsed = OAuthTokenResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      return { ok: false, error: "Invalid OAuth token response." };
    }
    return {
      ok: true,
      accessToken: parsed.data.access_token,
      refreshToken: parsed.data.refresh_token ?? fallbackRefreshToken,
    };
  } catch (thrown) {
    return {
      ok: false,
      error: thrown instanceof Error ? thrown.message : String(thrown),
    };
  }
}

function exchangeAuthorizationCode(
  teamDomain: string,
  clientId: string,
  code: string,
  codeVerifier: string,
): Promise<OAuthTokenResult> {
  return postTokenEndpoint(teamDomain, {
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    code_verifier: codeVerifier,
    redirect_uri: ACCESS_REDIRECT_URI,
  });
}

type OAuthCallbackExchangeResult =
  | { readonly kind: "ignore" }
  | { readonly kind: "error"; readonly message: string }
  | {
      readonly kind: "exchanged";
      readonly accessToken: string;
      readonly refreshToken?: string;
    };

export async function handleOAuthCallbackUrl(
  url: string,
  teamDomain: string,
  clientId: string,
  pkce: PkceSession,
): Promise<OAuthCallbackExchangeResult> {
  const parsed = parseOAuthCallbackUrl(url);
  switch (parsed.kind) {
    case "ignore":
      return { kind: "ignore" };
    case "error":
      return { kind: "error", message: parsed.message };
    case "code": {
      if (parsed.state !== pkce.state) {
        return {
          kind: "error",
          message: "OAuth state mismatch; please try signing in again.",
        };
      }
      const tokenResult = await exchangeAuthorizationCode(
        teamDomain,
        clientId,
        parsed.code,
        pkce.codeVerifier,
      );
      if (!tokenResult.ok) {
        return { kind: "error", message: tokenResult.error };
      }
      return {
        kind: "exchanged",
        accessToken: tokenResult.accessToken,
        refreshToken: tokenResult.refreshToken,
      };
    }
    default: {
      parsed satisfies never;
      return { kind: "ignore" };
    }
  }
}

export function refreshAccessToken(
  teamDomain: string,
  clientId: string,
  refreshToken: string,
): Promise<OAuthTokenResult> {
  return postTokenEndpoint(
    teamDomain,
    {
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: refreshToken,
    },
    refreshToken,
  );
}

export async function fetchWorkerStatus(
  baseUrl: string,
): Promise<WorkerStatus> {
  const cleanUrl = baseUrl.replace(/\/$/, "");
  try {
    const [health, authRes] = await Promise.all([
      fetch(`${cleanUrl}/health`),
      fetch(`${cleanUrl}/auth/config`),
    ]);
    if (!health.ok) {
      return {
        kind: "offline",
        reason: `Health check returned HTTP ${health.status}`,
      };
    }
    if (!authRes.ok) {
      return { kind: "live_no_oauth", baseUrl: cleanUrl };
    }
    const parsed = AuthConfigResponseSchema.safeParse(await authRes.json());
    if (
      parsed.success &&
      parsed.data.provider === "cloudflare_access_oauth" &&
      parsed.data.teamDomain &&
      parsed.data.clientId
    ) {
      return {
        kind: "live_oauth_ready",
        baseUrl: cleanUrl,
        teamDomain: parsed.data.teamDomain,
        clientId: parsed.data.clientId,
      };
    }
    return { kind: "live_no_oauth", baseUrl: cleanUrl };
  } catch (thrown) {
    return {
      kind: "offline",
      reason: thrown instanceof Error ? thrown.message : String(thrown),
    };
  }
}

export async function discoverCloudflareWorker(
  cfApiToken: string,
): Promise<WorkerDiscoveryResult> {
  const headers = { Authorization: `Bearer ${cfApiToken.trim()}` };
  try {
    const listed = await listCloudflareAccounts(headers);
    if (!listed.ok) {
      return { kind: "error", message: listed.message };
    }
    const accounts = listed.accounts;
    const checks = await Promise.all(
      accounts.map(async (account) => {
        const cleanAccount = encodeURIComponent(account.id);
        const scriptRes = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${cleanAccount}/workers/scripts/${DEFAULT_WORKER_NAME}`,
          { headers },
        );
        if (scriptRes.status === 404) {
          return {
            kind: "not_deployed" as const,
            account,
          };
        }
        if (scriptRes.status === 403) {
          return { kind: "forbidden" as const };
        }
        if (!scriptRes.ok) {
          return {
            kind: "error" as const,
            message: `Cloudflare API returned HTTP ${scriptRes.status}`,
          };
        }
        const subRes = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${cleanAccount}/workers/subdomain`,
          { headers },
        );
        if (subRes.status === 403) {
          return { kind: "forbidden" as const };
        }
        if (!subRes.ok) {
          return {
            kind: "error" as const,
            message: `Could not read workers.dev subdomain (HTTP ${subRes.status})`,
          };
        }
        const parsed = SubdomainResponseSchema.safeParse(await subRes.json());
        if (!parsed.success) {
          return {
            kind: "error" as const,
            message: "Unexpected Cloudflare subdomain shape.",
          };
        }
        return {
          kind: "found" as const,
          accountId: account.id,
          accountName: account.name,
          baseUrl: `https://${DEFAULT_WORKER_NAME}.${parsed.data.result.subdomain}.workers.dev`,
        };
      }),
    );
    const matches: DiscoveredWorker[] = [];
    for (const item of checks) {
      if (item.kind === "found") {
        matches.push({
          accountId: item.accountId,
          accountName: item.accountName,
          baseUrl: item.baseUrl,
        });
      }
    }
    if (matches.length > 0) {
      return { kind: "found", matches, accountCount: accounts.length };
    }
    const firstError = checks.find((item) => item.kind === "error");
    if (firstError) {
      return firstError;
    }
    const deployableAccounts: CloudflareAccount[] = [];
    for (const item of checks) {
      if (item.kind === "not_deployed") {
        deployableAccounts.push(item.account);
      }
    }
    if (deployableAccounts.length > 0) {
      return { kind: "not_deployed", deployableAccounts };
    }
    return {
      kind: "error",
      message: "No accessible Cloudflare account found for Workers.",
    };
  } catch (thrown) {
    return {
      kind: "error",
      message: thrown instanceof Error ? thrown.message : String(thrown),
    };
  }
}

export async function provisionWorkerSecrets(
  cfApiToken: string,
  accountId: string,
  nearAiApiKey: string,
  agentAuthToken: string,
): Promise<
  { readonly ok: true } | { readonly ok: false; readonly error: string }
> {
  const cleanAccount = encodeURIComponent(accountId.trim());
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${cleanAccount}/workers/scripts/${DEFAULT_WORKER_NAME}/secrets`;
  const headers = {
    Authorization: `Bearer ${cfApiToken.trim()}`,
    "Content-Type": "application/json",
  };
  const secrets = [
    {
      name: "NEARAI_API_KEY",
      text: nearAiApiKey.trim(),
      type: "secret_text",
    },
    {
      name: "AGENT_AUTH_TOKEN",
      text: agentAuthToken.trim(),
      type: "secret_text",
    },
  ];
  try {
    for (const secret of secrets) {
      const response = await fetch(endpoint, {
        method: "PUT",
        headers,
        body: JSON.stringify(secret),
      });
      if (!response.ok) {
        return {
          ok: false,
          error: `Cloudflare secrets API returned HTTP ${response.status} for ${secret.name}`,
        };
      }
    }
    return { ok: true };
  } catch (thrown) {
    return {
      ok: false,
      error: thrown instanceof Error ? thrown.message : String(thrown),
    };
  }
}
