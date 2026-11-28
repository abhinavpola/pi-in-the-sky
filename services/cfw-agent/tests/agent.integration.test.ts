import { LOCAL_DEV_AUTH_TOKEN } from "@pi-in-the-sky/client/protocol";
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { verifyCloudflareAccessJwt } from "../src/access-auth";
import type { TestPersonalAgent } from "./worker";

const AUTH_HEADERS = {
  Authorization: `Bearer ${LOCAL_DEV_AUTH_TOKEN}`,
};

const SocketMessageSchema = z
  .object({
    type: z.string(),
    id: z.string().optional(),
    result: z.unknown().optional(),
    takeover: z
      .object({
        id: z.string(),
        liveViewUrl: z.string().nullable(),
      })
      .optional(),
  })
  .passthrough();

type ParsedSocketMessage = z.infer<typeof SocketMessageSchema>;

const NotesResponseSchema = z.object({
  notes: z.array(z.object({ content: z.string() })),
});

const HealthResponseSchema = z.object({
  ok: z.boolean(),
});

const ProfileResponseSchema = z.object({
  entries: z.array(z.unknown()),
});

const TakeoverResumeResponseSchema = z.object({
  takeoverId: z.string(),
  delivered: z.string(),
});

function personalStub(): DurableObjectStub<TestPersonalAgent> {
  return env.PersonalAgent.getByName("personal");
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function signAccessJwt(
  privateKey: CryptoKey,
  kid: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const encoder = new TextEncoder();
  const headerSeg = toBase64Url(
    encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT", kid })),
  );
  const payloadSeg = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const sigBuf = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    encoder.encode(`${headerSeg}.${payloadSeg}`),
  );
  return `${headerSeg}.${payloadSeg}.${toBase64Url(new Uint8Array(sigBuf))}`;
}

function nextSocketMessage(
  ws: WebSocket,
  predicate: (message: ParsedSocketMessage) => boolean,
  label = "message",
  timeoutMs = 5_000,
): Promise<ParsedSocketMessage> {
  const seen: string[] = [];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", onMessage);
      reject(
        new Error(
          `Timed out waiting for ${label}. Seen: ${JSON.stringify(seen)}`,
        ),
      );
    }, timeoutMs);

    const onMessage = (event: MessageEvent) => {
      const raw = String(event.data);
      const parsed = SocketMessageSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        return;
      }
      seen.push(raw.slice(0, 220));
      if (predicate(parsed.data)) {
        clearTimeout(timer);
        ws.removeEventListener("message", onMessage);
        resolve(parsed.data);
      }
    };

    ws.addEventListener("message", onMessage);
  });
}

async function connectMeSocket(): Promise<WebSocket> {
  const wsResponse = await SELF.fetch("https://agent.test/api/me/ws", {
    headers: {
      ...AUTH_HEADERS,
      Upgrade: "websocket",
    },
  });
  expect(wsResponse.status).toBe(101);
  const ws = wsResponse.webSocket;
  if (!ws) {
    throw new Error("Expected WebSocket upgrade");
  }
  ws.accept();
  await nextSocketMessage(ws, (m) => m.type === "hello", "hello");
  return ws;
}

async function wsRpc(
  ws: WebSocket,
  payload: Record<string, unknown> & { readonly id: string },
): Promise<unknown> {
  const responsePromise = nextSocketMessage(
    ws,
    (m) => m.type === "result" && m.id === payload.id,
    `result:${payload.id}`,
  );
  ws.send(JSON.stringify(payload));
  const msg = await responsePromise;
  return msg.result;
}

describe("cfw-agent workerd integration", () => {
  it("enforces fail-closed auth, /auth/config discovery, /api/me/ws routing, and Cloudflare Access RS256 JWT verification", async () => {
    const health = await SELF.fetch("https://agent.test/health");
    expect(health.status).toBe(200);
    expect(HealthResponseSchema.parse(await health.json())).toEqual({
      ok: true,
    });

    const authConfig = await SELF.fetch("https://agent.test/auth/config");
    expect(authConfig.status).toBe(200);

    const unauthorized = await SELF.fetch("https://agent.test/api/me/ws", {
      headers: { Upgrade: "websocket" },
    });
    expect(unauthorized.status).toBe(401);

    const publicDevTokenRejected = await SELF.fetch(
      "https://pi-in-the-sky-agent.example.workers.dev/api/me/ws",
      {
        headers: { ...AUTH_HEADERS, Upgrade: "websocket" },
      },
    );
    expect(publicDevTokenRejected.status).toBe(401);

    const ws = await connectMeSocket();
    const profileResult = await wsRpc(ws, {
      type: "get_profile",
      id: "rpc-prof-1",
    });
    expect(ProfileResponseSchema.parse(profileResult)).toEqual({
      entries: [],
    });
    ws.close();

    const keyPair = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    );
    if (!("publicKey" in keyPair && "privateKey" in keyPair)) {
      throw new Error("Expected RSA CryptoKeyPair");
    }
    const exportedJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
    const jwksJson = JSON.stringify({
      keys: [{ ...exportedJwk, kid: "cf-access-key-1" }],
    });
    const accessConfig = {
      teamDomain: "abhinav.cloudflareaccess.com",
      aud: "aud-tag-123",
      jwksJson,
    };

    const nowSec = Math.floor(Date.now() / 1000);
    const validJwt = await signAccessJwt(
      keyPair.privateKey,
      "cf-access-key-1",
      {
        sub: "user-abhinav-1",
        email: "abhinav@example.com",
        aud: ["aud-tag-123"],
        iss: "https://abhinav.cloudflareaccess.com",
        exp: nowSec + 300,
      },
    );

    const verified = await verifyCloudflareAccessJwt(
      new Request("https://agent.test/api/me/ws", {
        headers: { "Cf-Access-Jwt-Assertion": validJwt },
      }),
      accessConfig,
    );
    expect(verified).toEqual({
      sub: "user-abhinav-1",
      email: "abhinav@example.com",
      exp: expect.any(Number),
    });

    const wrongAudJwt = await signAccessJwt(
      keyPair.privateKey,
      "cf-access-key-1",
      {
        sub: "user-abhinav-1",
        aud: ["other-aud"],
        iss: "https://abhinav.cloudflareaccess.com",
        exp: nowSec + 300,
      },
    );
    expect(
      await verifyCloudflareAccessJwt(
        new Request("https://agent.test/api/me/ws", {
          headers: { Authorization: `Bearer ${wrongAudJwt}` },
        }),
        accessConfig,
      ),
    ).toBeNull();

    const expiredJwt = await signAccessJwt(
      keyPair.privateKey,
      "cf-access-key-1",
      {
        sub: "user-abhinav-1",
        aud: ["aud-tag-123"],
        iss: "https://abhinav.cloudflareaccess.com",
        exp: nowSec - 60,
      },
    );
    expect(
      await verifyCloudflareAccessJwt(
        new Request("https://agent.test/api/me/ws", {
          headers: { Authorization: `Bearer ${expiredJwt}` },
        }),
        accessConfig,
      ),
    ).toBeNull();
  });

  it("plans a repeat trip over WebSocket using built-in skill read_file, sqlite_query, and host-isolated SecretsFacet tokens", async () => {
    const secretHomeAirport = "SFO-PRIVATE-AIRPORT-991";
    const secretOauthToken = "ya29.super-secret-oauth-token-xyz";
    const secretPromptPhrase = "SECRET_TOKYO_PROMPT_CANARY_42";
    const secretReplyPhrase = "SECRET_ANA_NH7_COMPLETION_CANARY_88";

    const stub = personalStub();
    await stub.setScript("personal", [
      {
        toolCalls: [
          {
            id: "tc-skill",
            name: "read_file",
            arguments: { path: "skills/flight-planning/SKILL.md" },
          },
          {
            id: "tc-profile",
            name: "sqlite_query",
            arguments: {
              sql: "SELECT key, value FROM user_profile ORDER BY key ASC",
            },
          },
          {
            id: "tc-tables",
            name: "sqlite_query",
            arguments: {
              sql: "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name ASC",
            },
          },
        ],
      },
      {
        toolCalls: [
          {
            id: "tc-gmail-search",
            name: "gmail_search",
            arguments: { query: "Tokyo flight confirmation" },
          },
          {
            id: "tc-calendar",
            name: "calendar_list_events",
            arguments: {
              timeMin: "2026-10-10T00:00:00Z",
              timeMax: "2026-10-22T00:00:00Z",
            },
          },
        ],
      },
      {
        toolCalls: [
          {
            id: "tc-gmail-get",
            name: "gmail_get_message",
            arguments: { messageId: "msg-tokyo-2025" },
          },
          {
            id: "tc-browser-nav",
            name: "browser_navigate",
            arguments: { url: "https://ana.example/flights?from=SFO&to=NRT" },
          },
        ],
      },
      {
        toolCalls: [
          {
            id: "tc-browser-snap",
            name: "browser_snapshot",
            arguments: {},
          },
        ],
      },
      {
        toolCalls: [
          {
            id: "tc-write-note",
            name: "sqlite_query",
            arguments: {
              sql: "INSERT INTO memory_notes (date, category, content, created_at) VALUES (?, ?, ?, ?)",
              params: [
                "2026-10-12",
                "travel",
                "Planned Tokyo Oct 12-20 2026 on ANA NH7 ($1,120).",
                Date.now(),
              ],
            },
          },
        ],
      },
      {
        text: `${secretReplyPhrase} Found ANA NH7 nonstop SFO -> NRT for Oct 12-20, 2026 ($1,120). Want me to book it?`,
      },
    ]);

    const ws = await connectMeSocket();

    await wsRpc(ws, {
      type: "set_profile",
      id: "rpc-set-profile",
      key: "home_airport",
      value: secretHomeAirport,
    });
    await wsRpc(ws, {
      type: "set_connector_token",
      id: "rpc-set-gmail",
      provider: "gmail",
      accessToken: secretOauthToken,
    });
    await wsRpc(ws, {
      type: "set_connector_token",
      id: "rpc-set-cal",
      provider: "google_calendar",
      accessToken: "calendar-test-token",
    });

    ws.send(JSON.stringify({ type: "watch", id: "cmd-watch" }));
    await nextSocketMessage(ws, (m) => m.type === "view");

    await wsRpc(ws, {
      type: "submit",
      id: "cmd-submit-1",
      operationId: "op-trip-tokyo-1",
      input: `${secretPromptPhrase} Look up my Tokyo trip from last year and plan the same trip.`,
    });

    const finalView = await nextSocketMessage(
      ws,
      (m) => m.type === "view" && JSON.stringify(m).includes(secretReplyPhrase),
      "final assistant message",
      10_000,
    );
    const serializedView = JSON.stringify(finalView);
    expect(serializedView).toContain("Flight & Trip Planning");
    expect(serializedView).toContain("user_profile");
    expect(serializedView).not.toContain("connector_tokens");
    expect(serializedView).not.toContain(secretOauthToken);
    expect(serializedView).not.toContain('"isError":true');

    const searchResult = await wsRpc(ws, {
      type: "search_notes",
      id: "rpc-search-notes",
      query: "Tokyo",
    });
    const searchJson = NotesResponseSchema.parse(searchResult);
    expect(searchJson.notes.length).toBeGreaterThanOrEqual(1);
    expect(searchJson.notes[0]?.content).toContain("ANA NH7");

    ws.close();
  });

  it("supports browser Live View takeover pause and resume over WebSocket", async () => {
    const stub = personalStub();

    await stub.setScript("personal", [
      {
        toolCalls: [
          {
            id: "tc-takeover",
            name: "browser_request_takeover",
            arguments: {
              url: "https://airline.example/login",
              reason: "MFA verification required to continue checkout.",
              liveViewUrl: "https://live.browser.test/session/abc",
            },
          },
        ],
      },
      {
        text: "Sign-in complete; continuing reservation.",
      },
    ]);

    const ws = await connectMeSocket();
    ws.send(JSON.stringify({ type: "watch", id: "cmd-watch-takeover" }));
    await nextSocketMessage(ws, (m) => m.type === "view", "view");

    const takeoverPromise = nextSocketMessage(
      ws,
      (m) => m.type === "takeover_requested",
      "takeover_requested",
      10_000,
    );

    ws.send(
      JSON.stringify({
        type: "submit",
        id: "cmd-submit-takeover",
        input: "Log into my airline account.",
      }),
    );

    const takeoverMsg = await takeoverPromise;
    expect(takeoverMsg.takeover?.liveViewUrl).toBe(
      "https://live.browser.test/session/abc",
    );

    const takeoverId = takeoverMsg.takeover?.id;
    if (!takeoverId) {
      throw new Error("Expected takeover ID");
    }

    const postTakeoverPromise = nextSocketMessage(
      ws,
      (m) =>
        m.type === "view" && JSON.stringify(m).includes("Sign-in complete"),
      "post-takeover assistant message",
      10_000,
    );

    const resumeResult = await wsRpc(ws, {
      type: "resume_takeover",
      id: "cmd-resume-takeover",
      takeoverId,
      note: "MFA completed",
    });
    const resumeJson = TakeoverResumeResponseSchema.parse(resumeResult);
    expect(resumeJson.takeoverId).toBe(takeoverId);
    expect(resumeJson.delivered).toBe("delivered");

    await postTakeoverPromise;

    ws.close();
  });
});
