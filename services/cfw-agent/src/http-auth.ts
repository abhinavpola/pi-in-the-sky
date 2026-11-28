import { LOCAL_DEV_AUTH_TOKEN } from "@pi-in-the-sky/client/protocol";

import type { Env } from "../env";
import { ACCESS_TOKEN_EXP_HEADER } from "./sockets";

const LOCAL_DEV_HOSTS = new Set(["127.0.0.1", "agent.test"]);

function timingSafeEqualText(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  return crypto.subtle.timingSafeEqual(left, right);
}

function isLocalDevHost(request: Request): boolean {
  try {
    return LOCAL_DEV_HOSTS.has(new URL(request.url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function hasWorkerBearerAuth(request: Request, env: Env): boolean {
  if (env.CF_ACCESS_TEAM_DOMAIN || env.CF_ACCESS_AUD) {
    return false;
  }
  const provided = request.headers.get("Authorization");
  if (!provided) {
    return false;
  }
  const configuredToken = env.AGENT_AUTH_TOKEN?.trim();
  if (configuredToken && configuredToken.length > 0) {
    return timingSafeEqualText(provided, `Bearer ${configuredToken}`);
  }
  if (!isLocalDevHost(request)) {
    return false;
  }
  return timingSafeEqualText(provided, `Bearer ${LOCAL_DEV_AUTH_TOKEN}`);
}

export function forwardToDurableObject(
  stub: Fetcher,
  request: Request,
  tokenExpSec: number | null,
): Promise<Response> {
  const headers = new Headers(request.headers);
  headers.delete(ACCESS_TOKEN_EXP_HEADER);
  if (tokenExpSec !== null) {
    headers.set(ACCESS_TOKEN_EXP_HEADER, String(tokenExpSec));
  }
  return stub.fetch(new Request(request, { headers }));
}

function allowedCorsOrigin(request: Request): string | null {
  const origin = request.headers.get("Origin");
  if (!origin) {
    return null;
  }
  try {
    const parsed = new URL(origin);
    if (origin === new URL(request.url).origin) {
      return origin;
    }
    if (
      parsed.protocol === "http:" &&
      (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")
    ) {
      return origin;
    }
    return null;
  } catch {
    return null;
  }
}

export function withCors(request: Request, response: Response): Response {
  if (response.webSocket) {
    return response;
  }
  const origin = allowedCorsOrigin(request);
  if (!origin) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Vary", "Origin");
  headers.set(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, DELETE, OPTIONS",
  );
  headers.set(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Cf-Access-Jwt-Assertion",
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
