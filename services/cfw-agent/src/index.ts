import type { Env } from "../env";

export { PersonalAgent } from "./agent";

function isAuthorized(request: Request, env: Env): boolean {
  if (!env.AUTH_TOKEN) {
    return false;
  }
  const auth = request.headers.get("Authorization");
  return auth === `Bearer ${env.AUTH_TOKEN}`;
}

function withCors(response: Response): Response {
  if (response.webSocket) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, DELETE, OPTIONS",
  );
  headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }));
    }

    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return withCors(Response.json({ ok: true }));
    }

    if (!isAuthorized(request, env)) {
      return withCors(
        Response.json({ error: "Unauthorized" }, { status: 401 }),
      );
    }

    const agentMatch = url.pathname.match(/^\/api\/agents\/([^/]+)(\/.*)?$/);
    if (agentMatch?.[1]) {
      const agentId = decodeURIComponent(agentMatch[1]);
      const stub = env.PersonalAgent.getByName(agentId);
      const response = await stub.fetch(request);
      return withCors(response);
    }

    return withCors(Response.json({ error: "Not found" }, { status: 404 }));
  },
};
