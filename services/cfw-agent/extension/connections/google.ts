import type { ConnectorBridge } from "../../src/connector-bridge";

export type ConnectorBridgeEnv = {
  readonly CONNECTOR_BRIDGE?: Pick<ConnectorBridge, "request">;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readRunInput(
  request: Request,
): Promise<Record<string, unknown> | null> {
  const payload: unknown = await request.json();
  if (!isRecord(payload) || !isRecord(payload.input)) {
    return null;
  }
  return payload.input;
}

export async function callConnector(
  env: ConnectorBridgeEnv,
  provider: "gmail" | "google_calendar",
  apiPath: string,
  init?: {
    readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    readonly body?: string;
  },
): Promise<Response> {
  if (!env.CONNECTOR_BRIDGE) {
    return Response.json(
      { error: "Host CONNECTOR_BRIDGE capability is unavailable." },
      { status: 500 },
    );
  }
  const result = await env.CONNECTOR_BRIDGE.request(provider, apiPath, init);
  if (!result.ok) {
    return Response.json({ error: result.error }, { status: 400 });
  }
  return Response.json(result.data);
}
