import { z } from "zod";

const CF_OAUTH_CLIENT_ID = "cbca97e7-c331-4cdd-8fd8-e25a451b98bf";
const CF_DEVICE_AUTH_ENDPOINT =
  "https://dash.cloudflare.com/oauth2/device/auth";
const CF_TOKEN_ENDPOINT = "https://dash.cloudflare.com/oauth2/token";
const CF_DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const CF_OAUTH_HOST = "dash.cloudflare.com";
const CF_REQUIRED_SCOPES = [
  "memberships.read",
  "account-settings.read",
  "workers-scripts.read",
  "workers-scripts.write",
];

const DeviceAuthResponseSchema = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.string().min(1),
  verification_uri_complete: z.string().min(1).optional(),
  expires_in: z.number().positive(),
  interval: z.number().positive().optional(),
});

const DeviceTokenSuccessSchema = z.object({
  access_token: z.string().min(1),
});

const DeviceTokenErrorSchema = z.object({
  error: z.string().min(1),
  error_description: z.string().optional(),
});

const MembershipsResponseSchema = z.object({
  result: z.array(
    z.object({
      account: z.object({
        id: z.string().min(1),
      }),
    }),
  ),
});

const AccountsResponseSchema = z.object({
  result: z.array(
    z.object({
      id: z.string().min(1),
    }),
  ),
});

export type CloudflareDeviceAuth = {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUriComplete: string;
  readonly expiresIn: number;
  readonly interval: number;
};

type DeviceAuthStartResult =
  | { readonly ok: true; readonly value: CloudflareDeviceAuth }
  | { readonly ok: false; readonly error: string };

type DeviceTokenPollResult =
  | { readonly ok: true; readonly accessToken: string }
  | { readonly ok: false; readonly error: string };

export function encodeFormBody(entries: Record<string, string>): string {
  return Object.entries(entries)
    .map(
      ([key, value]) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
    )
    .join("&");
}

export async function listCloudflareAccountIds(
  headers: Record<string, string>,
): Promise<
  | { readonly ok: true; readonly accountIds: readonly string[] }
  | { readonly ok: false; readonly message: string }
> {
  const seen = new Set<string>();
  const membershipsRes = await fetch(
    "https://api.cloudflare.com/client/v4/memberships",
    { headers },
  );
  if (membershipsRes.ok) {
    const parsed = MembershipsResponseSchema.safeParse(
      await membershipsRes.json(),
    );
    if (parsed.success) {
      for (const item of parsed.data.result) {
        seen.add(item.account.id);
      }
    }
  }
  if (seen.size > 0) {
    return { ok: true, accountIds: [...seen] };
  }
  const accountsRes = await fetch(
    "https://api.cloudflare.com/client/v4/accounts",
    { headers },
  );
  if (!accountsRes.ok) {
    return {
      ok: false,
      message: `Could not read Cloudflare accounts (HTTP ${accountsRes.status})`,
    };
  }
  const accountsParsed = AccountsResponseSchema.safeParse(
    await accountsRes.json(),
  );
  const accounts = accountsParsed.success ? accountsParsed.data.result : [];
  for (const account of accounts) {
    seen.add(account.id);
  }
  if (seen.size === 0) {
    return {
      ok: false,
      message: "No Cloudflare account found for this session.",
    };
  }
  return { ok: true, accountIds: [...seen] };
}

function isTrustedVerificationUrl(raw: string): boolean {
  const prefix = `https://${CF_OAUTH_HOST}`;
  if (!raw.startsWith(prefix)) {
    return false;
  }
  const rest = raw.slice(prefix.length);
  return rest.length === 0 || rest.startsWith("/") || rest.startsWith("?");
}

function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function startCloudflareDeviceAuth(): Promise<DeviceAuthStartResult> {
  try {
    const body = encodeFormBody({
      client_id: CF_OAUTH_CLIENT_ID,
      scope: CF_REQUIRED_SCOPES.join(" "),
    });
    const res = await fetch(CF_DEVICE_AUTH_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
    });
    if (!res.ok) {
      return {
        ok: false,
        error: `Cloudflare sign-in failed to start (HTTP ${res.status}).`,
      };
    }
    const parsed = DeviceAuthResponseSchema.safeParse(await res.json());
    if (!parsed.success) {
      return {
        ok: false,
        error: "Unexpected response from Cloudflare sign-in.",
      };
    }
    const candidateUrl =
      parsed.data.verification_uri_complete ??
      `${parsed.data.verification_uri}?user_code=${encodeURIComponent(parsed.data.user_code)}`;
    if (!isTrustedVerificationUrl(candidateUrl)) {
      return {
        ok: false,
        error: "Untrusted verification URL returned by Cloudflare.",
      };
    }
    return {
      ok: true,
      value: {
        deviceCode: parsed.data.device_code,
        userCode: parsed.data.user_code,
        verificationUriComplete: candidateUrl,
        expiresIn: parsed.data.expires_in,
        interval: Math.max(parsed.data.interval ?? 5, 1),
      },
    };
  } catch (thrown) {
    return {
      ok: false,
      error: thrown instanceof Error ? thrown.message : String(thrown),
    };
  }
}

export async function pollCloudflareDeviceToken(
  auth: CloudflareDeviceAuth,
  signal?: AbortSignal,
): Promise<DeviceTokenPollResult> {
  const deadline = Date.now() + Math.min(auth.expiresIn, 300) * 1000;
  let intervalSec = Math.max(auth.interval, 1);

  while (Date.now() < deadline) {
    await sleepAbortable(intervalSec * 1000, signal);
    if (signal?.aborted) {
      return { ok: false, error: "Cloudflare sign-in cancelled." };
    }
    try {
      const body = encodeFormBody({
        grant_type: CF_DEVICE_GRANT_TYPE,
        device_code: auth.deviceCode,
        client_id: CF_OAUTH_CLIENT_ID,
      });
      const res = await fetch(CF_TOKEN_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body,
        signal,
      });
      const payload: unknown = await res.json().catch(() => null);
      if (res.ok) {
        const parsed = DeviceTokenSuccessSchema.safeParse(payload);
        if (!parsed.success) {
          return {
            ok: false,
            error: "Unexpected token response from Cloudflare.",
          };
        }
        return { ok: true, accessToken: parsed.data.access_token };
      }
      const errParsed = DeviceTokenErrorSchema.safeParse(payload);
      if (errParsed.success) {
        switch (errParsed.data.error) {
          case "authorization_pending":
          case "temporarily_unavailable":
            continue;
          case "slow_down":
            intervalSec += 5;
            continue;
          case "access_denied":
            return { ok: false, error: "Cloudflare sign-in was cancelled." };
          case "expired_token":
            return {
              ok: false,
              error: "Cloudflare sign-in expired. Try again.",
            };
          default:
            return {
              ok: false,
              error:
                errParsed.data.error_description ??
                `Cloudflare sign-in error: ${errParsed.data.error}`,
            };
        }
      }
      if (res.status === 429 || res.status >= 500) {
        continue;
      }
      return {
        ok: false,
        error: `Cloudflare token request failed (HTTP ${res.status}).`,
      };
    } catch (thrown) {
      if (signal?.aborted) {
        return { ok: false, error: "Cloudflare sign-in cancelled." };
      }
      if (Date.now() >= deadline) {
        return {
          ok: false,
          error: thrown instanceof Error ? thrown.message : String(thrown),
        };
      }
    }
  }
  return { ok: false, error: "Cloudflare sign-in expired. Try again." };
}
