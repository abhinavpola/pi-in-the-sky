import {
  type ConnectionConfig,
  ConnectionConfigSchema,
} from "@pi-in-the-sky/client/agent-client";
import {
  buildAccessAuthorizeUrl,
  createPkceSession,
  handleOAuthCallbackUrl,
} from "@pi-in-the-sky/client/onboarding";
import { err, ok, type Result } from "@pi-in-the-sky/result-monad";
import { NativeModules } from "react-native";

const CALLBACK_SCHEME = "piinthesky";

type PiInTheSkyNativeBridge = {
  readonly authenticate: (
    authorizeUrl: string,
    callbackScheme: string,
  ) => Promise<unknown>;
  readonly loadConnectionConfig: () => Promise<unknown>;
  readonly saveConnectionConfig: (payload: string) => Promise<unknown>;
  readonly clearConnectionConfig: () => Promise<unknown>;
  readonly randomBase64Url: (byteLength: number) => Promise<unknown>;
};

function isNativeBridge(value: unknown): value is PiInTheSkyNativeBridge {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return (
    "authenticate" in value &&
    typeof value.authenticate === "function" &&
    "loadConnectionConfig" in value &&
    typeof value.loadConnectionConfig === "function" &&
    "saveConnectionConfig" in value &&
    typeof value.saveConnectionConfig === "function" &&
    "clearConnectionConfig" in value &&
    typeof value.clearConnectionConfig === "function" &&
    "randomBase64Url" in value &&
    typeof value.randomBase64Url === "function"
  );
}

function getNativeBridge(): Result<PiInTheSkyNativeBridge, string> {
  const candidate: unknown = NativeModules.PiInTheSkyNative;
  if (!isNativeBridge(candidate)) {
    return err("Native macOS module PiInTheSkyNative is not available.");
  }
  return ok(candidate);
}

function formatError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string" &&
    error.message.length > 0
  ) {
    return error.message;
  }
  return fallback;
}

export async function signInWithCloudflareAccess(params: {
  readonly baseUrl: string;
  readonly teamDomain: string;
  readonly clientId: string;
  readonly onStatus?: (message: string) => void;
}): Promise<Result<ConnectionConfig, string>> {
  const bridge = getNativeBridge();
  if (!bridge.ok) {
    return bridge;
  }

  const pkce = createPkceSession();
  const authorizeUrl = buildAccessAuthorizeUrl(
    params.teamDomain,
    params.clientId,
    pkce,
  );
  params.onStatus?.("Opening Cloudflare Access sign-in...");

  let callbackUrl: unknown;
  try {
    callbackUrl = await bridge.value.authenticate(
      authorizeUrl,
      CALLBACK_SCHEME,
    );
  } catch (error) {
    return err(formatError(error, "Cloudflare Access sign-in failed."));
  }

  if (typeof callbackUrl !== "string") {
    return err("Native sign-in returned an invalid callback URL.");
  }

  params.onStatus?.("Exchanging Cloudflare Access authorization code...");
  const exchanged = await handleOAuthCallbackUrl(
    callbackUrl,
    params.teamDomain,
    params.clientId,
    pkce,
  );

  switch (exchanged.kind) {
    case "exchanged":
      return ok({
        baseUrl: params.baseUrl,
        authToken: exchanged.accessToken,
        refreshToken: exchanged.refreshToken,
        accessTeamDomain: params.teamDomain,
        accessClientId: params.clientId,
      });
    case "error":
      return err(exchanged.message);
    case "ignore":
      return err("Unexpected OAuth callback URL.");
    default: {
      exchanged satisfies never;
      return err("Unexpected OAuth callback state.");
    }
  }
}

export async function loadStoredConnectionConfig(): Promise<
  Result<ConnectionConfig | null, string>
> {
  const bridge = getNativeBridge();
  if (!bridge.ok) {
    return bridge;
  }

  let raw: unknown;
  try {
    raw = await bridge.value.loadConnectionConfig();
  } catch (error) {
    return err(
      formatError(error, "Failed to read connection config from Keychain."),
    );
  }

  if (raw === null || raw === undefined) {
    return ok(null);
  }
  if (typeof raw !== "string") {
    return err("Stored Keychain connection config has an unexpected format.");
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return err("Stored Keychain connection config is not valid JSON.");
  }

  const validated = ConnectionConfigSchema.safeParse(parsedJson);
  if (!validated.success) {
    return err("Stored Keychain connection config failed schema validation.");
  }

  return ok(validated.data);
}

export async function saveStoredConnectionConfig(
  config: ConnectionConfig,
): Promise<Result<void, string>> {
  const bridge = getNativeBridge();
  if (!bridge.ok) {
    return bridge;
  }

  try {
    await bridge.value.saveConnectionConfig(JSON.stringify(config));
    return ok(undefined);
  } catch (error) {
    return err(
      formatError(error, "Failed to save connection config to Keychain."),
    );
  }
}

export async function clearStoredConnectionConfig(): Promise<
  Result<void, string>
> {
  const bridge = getNativeBridge();
  if (!bridge.ok) {
    return bridge;
  }

  try {
    await bridge.value.clearConnectionConfig();
    return ok(undefined);
  } catch (error) {
    return err(
      formatError(error, "Failed to clear connection config from Keychain."),
    );
  }
}

export async function generateRandomToken(
  byteLength: number,
): Promise<Result<string, string>> {
  const bridge = getNativeBridge();
  if (!bridge.ok) {
    return bridge;
  }

  try {
    const token = await bridge.value.randomBase64Url(byteLength);
    if (typeof token !== "string" || token.length === 0) {
      return err("Native random token generator returned an invalid value.");
    }
    return ok(token);
  } catch (error) {
    return err(formatError(error, "Failed to generate authentication token."));
  }
}
