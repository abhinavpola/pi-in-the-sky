import { isRecord } from "./protocol-parsers";

const REPO_URL = "https://github.com/abhinavpola/pi-in-the-sky";
const DEFAULT_WORKER_NAME = "pi-in-the-sky";

export const DEPLOY_TO_CLOUDFLARE_URL = `https://deploy.workers.cloudflare.com/?url=${encodeURIComponent(REPO_URL)}`;
const ACCESS_REDIRECT_URI = "piinthesky://auth/callback";

type WorkerStatus =
  | { readonly kind: "offline"; readonly reason: string }
  | { readonly kind: "live_no_oauth"; readonly baseUrl: string }
  | {
      readonly kind: "live_oauth_ready";
      readonly baseUrl: string;
      readonly teamDomain: string;
      readonly clientId: string;
    };

type WorkerDiscoveryResult =
  | { readonly kind: "found"; readonly baseUrl: string }
  | { readonly kind: "not_deployed" }
  | { readonly kind: "error"; readonly message: string };

type TokenRefreshResult =
  | {
      readonly ok: true;
      readonly accessToken: string;
      readonly refreshToken: string;
    }
  | { readonly ok: false; readonly error: string };

function normalizeTeamOrigin(teamDomain: string): string {
  const trimmed = teamDomain.trim().replace(/\/$/, "");
  return trimmed.startsWith("https://") ? trimmed : `https://${trimmed}`;
}

export function buildAccessAuthorizeUrl(
  teamDomain: string,
  clientId: string,
): string {
  const origin = normalizeTeamOrigin(teamDomain);
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: ACCESS_REDIRECT_URI,
    scope: "openid email profile offline_access",
  });
  return `${origin}/cdn-cgi/access/sso/oauth2/auth?${params.toString()}`;
}

export async function fetchWorkerStatus(
  baseUrl: string,
): Promise<WorkerStatus> {
  const cleanUrl = baseUrl.replace(/\/$/, "");
  try {
    const health = await fetch(`${cleanUrl}/health`);
    if (!health.ok) {
      return {
        kind: "offline",
        reason: `Health check returned HTTP ${health.status}`,
      };
    }
    const authRes = await fetch(`${cleanUrl}/auth/config`);
    if (!authRes.ok) {
      return { kind: "live_no_oauth", baseUrl: cleanUrl };
    }
    const data: unknown = await authRes.json();
    if (
      isRecord(data) &&
      data.provider === "cloudflare_access_oauth" &&
      typeof data.teamDomain === "string" &&
      typeof data.clientId === "string"
    ) {
      return {
        kind: "live_oauth_ready",
        baseUrl: cleanUrl,
        teamDomain: data.teamDomain,
        clientId: data.clientId,
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
  accountId: string,
): Promise<WorkerDiscoveryResult> {
  const headers = { Authorization: `Bearer ${cfApiToken.trim()}` };
  const cleanAccount = accountId.trim();
  try {
    const scriptRes = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(cleanAccount)}/workers/scripts/${DEFAULT_WORKER_NAME}`,
      { headers },
    );
    if (scriptRes.status === 404) {
      return { kind: "not_deployed" };
    }
    if (!scriptRes.ok) {
      return {
        kind: "error",
        message: `Cloudflare API returned HTTP ${scriptRes.status}`,
      };
    }
    const subRes = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(cleanAccount)}/workers/subdomain`,
      { headers },
    );
    if (!subRes.ok) {
      return {
        kind: "error",
        message: `Could not read workers.dev subdomain (HTTP ${subRes.status})`,
      };
    }
    const subData: unknown = await subRes.json();
    if (
      isRecord(subData) &&
      isRecord(subData.result) &&
      typeof subData.result.subdomain === "string"
    ) {
      return {
        kind: "found",
        baseUrl: `https://${DEFAULT_WORKER_NAME}.${subData.result.subdomain}.workers.dev`,
      };
    }
    return { kind: "error", message: "Unexpected Cloudflare subdomain shape." };
  } catch (thrown) {
    return {
      kind: "error",
      message: thrown instanceof Error ? thrown.message : String(thrown),
    };
  }
}

export async function refreshAccessToken(
  teamDomain: string,
  clientId: string,
  refreshToken: string,
): Promise<TokenRefreshResult> {
  const origin = normalizeTeamOrigin(teamDomain);
  try {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: refreshToken,
    });
    const response = await fetch(`${origin}/cdn-cgi/access/sso/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!response.ok) {
      return { ok: false, error: `Token refresh failed (${response.status})` };
    }
    const data: unknown = await response.json();
    if (!isRecord(data) || typeof data.access_token !== "string") {
      return { ok: false, error: "Invalid refresh token response." };
    }
    const nextRefresh =
      typeof data.refresh_token === "string"
        ? data.refresh_token
        : refreshToken;
    return {
      ok: true,
      accessToken: data.access_token,
      refreshToken: nextRefresh,
    };
  } catch (thrown) {
    return {
      ok: false,
      error: thrown instanceof Error ? thrown.message : String(thrown),
    };
  }
}
