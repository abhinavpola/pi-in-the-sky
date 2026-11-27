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
    takeover: z
      .object({
        id: z.string(),
        liveViewUrl: z.string().nullable(),
      })
      .optional(),
    activity: z
      .object({
        id: z.string(),
        title: z.string(),
        status: z.string(),
        collapsed: z.boolean(),
        summary: z.string(),
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

function stubFor(id: string): DurableObjectStub<TestPersonalAgent> {
  return env.PersonalAgent.getByName(id);
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

describe("cfw-agent workerd integration", () => {
  it("enforces fail-closed auth, /auth/config discovery, /api/me routing, and Cloudflare Access RS256 JWT verification", async () => {
    const health = await SELF.fetch("https://agent.test/health");
    expect(health.status).toBe(200);
    expect(HealthResponseSchema.parse(await health.json())).toEqual({
      ok: true,
    });

    const authConfig = await SELF.fetch("https://agent.test/auth/config");
    expect(authConfig.status).toBe(200);

    const unauthorized = await SELF.fetch("https://agent.test/api/me/profile");
    expect(unauthorized.status).toBe(401);

    const meAuthorized = await SELF.fetch("https://agent.test/api/me/profile", {
      headers: AUTH_HEADERS,
    });
    expect(meAuthorized.status).toBe(200);
    expect(ProfileResponseSchema.parse(await meAuthorized.json())).toEqual({
      entries: [],
    });

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
      new Request("https://agent.test/api/me/profile", {
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
        new Request("https://agent.test/api/me/profile", {
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
        new Request("https://agent.test/api/me/profile", {
          headers: { Authorization: `Bearer ${expiredJwt}` },
        }),
        accessConfig,
      ),
    ).toBeNull();
  });

  it("plans a repeat trip with zero plaintext prompts, completions, notes, or tokens in SQLite", async () => {
    const agentId = "trip-planner-e2e";
    const secretHomeAirport = "SFO-PRIVATE-AIRPORT-991";
    const secretOauthToken = "ya29.super-secret-oauth-token-xyz";
    const secretPromptPhrase = "SECRET_TOKYO_PROMPT_CANARY_42";
    const secretReplyPhrase = "SECRET_ANA_NH7_COMPLETION_CANARY_88";

    const putProfile = await SELF.fetch(
      `https://agent.test/api/agents/${agentId}/profile`,
      {
        method: "PUT",
        headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
        body: JSON.stringify({ key: "home_airport", value: secretHomeAirport }),
      },
    );
    expect(putProfile.status).toBe(200);

    const putToken = await SELF.fetch(
      `https://agent.test/api/agents/${agentId}/connectors/gmail/token`,
      {
        method: "PUT",
        headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
        body: JSON.stringify({ accessToken: secretOauthToken }),
      },
    );
    expect(putToken.status).toBe(200);

    const putCalendarToken = await SELF.fetch(
      `https://agent.test/api/agents/${agentId}/connectors/google_calendar/token`,
      {
        method: "PUT",
        headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
        body: JSON.stringify({ accessToken: "calendar-test-token" }),
      },
    );
    expect(putCalendarToken.status).toBe(200);

    const stub = stubFor(agentId);
    await stub.setScript(agentId, [
      {
        toolCalls: [
          {
            id: "tc-skill",
            name: "load_skill",
            arguments: { name: "flight-planning" },
          },
          {
            id: "tc-profile",
            name: "memory_get_profile",
            arguments: {},
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
            name: "memory_write_note",
            arguments: {
              category: "travel",
              content: "Planned Tokyo Oct 12-20 2026 on ANA NH7 ($1,120).",
            },
          },
        ],
      },
      {
        text: `${secretReplyPhrase} Found ANA NH7 nonstop SFO -> NRT for Oct 12-20, 2026 ($1,120). Want me to book it?`,
      },
    ]);

    const wsResponse = await SELF.fetch(
      `https://agent.test/api/agents/${agentId}/ws`,
      {
        headers: {
          ...AUTH_HEADERS,
          Upgrade: "websocket",
        },
      },
    );
    expect(wsResponse.status).toBe(101);
    const ws = wsResponse.webSocket;
    if (!ws) {
      throw new Error("Expected WebSocket upgrade");
    }
    ws.accept();

    const hello = await nextSocketMessage(ws, (m) => m.type === "hello");
    expect(hello.type).toBe("hello");

    ws.send(JSON.stringify({ type: "watch", id: "cmd-watch" }));
    await nextSocketMessage(ws, (m) => m.type === "view");

    const promptOpId = "op-trip-tokyo-1";
    ws.send(
      JSON.stringify({
        type: "submit",
        id: "cmd-submit-1",
        operationId: promptOpId,
        input: `${secretPromptPhrase} Look up my Tokyo trip from last year and plan the same trip.`,
      }),
    );

    const submitResult = await nextSocketMessage(
      ws,
      (m) => m.type === "result" && m.id === "cmd-submit-1",
    );
    expect(submitResult.type).toBe("result");

    await nextSocketMessage(
      ws,
      (m) => m.type === "view" && JSON.stringify(m).includes(secretReplyPhrase),
      "final assistant message",
      10_000,
    );

    const searchNotes = await SELF.fetch(
      `https://agent.test/api/agents/${agentId}/notes?q=Tokyo`,
      { headers: AUTH_HEADERS },
    );
    expect(searchNotes.status).toBe(200);
    const searchJson = NotesResponseSchema.parse(await searchNotes.json());
    expect(searchJson.notes.length).toBeGreaterThanOrEqual(1);
    expect(searchJson.notes[0]?.content).toContain("ANA NH7");

    const rawSqlite = await stub.dumpRawSqliteText();
    expect(rawSqlite).not.toContain(secretHomeAirport);
    expect(rawSqlite).not.toContain(secretOauthToken);
    expect(rawSqlite).not.toContain(secretPromptPhrase);
    expect(rawSqlite).not.toContain(secretReplyPhrase);
    expect(rawSqlite).not.toContain("Planned Tokyo Oct 12-20 2026");

    ws.close();
  });

  it("supports browser Live View takeover pause and resume", async () => {
    const agentId = "browser-takeover-e2e";
    const stub = stubFor(agentId);

    await stub.setScript(agentId, [
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

    const wsResponse = await SELF.fetch(
      `https://agent.test/api/agents/${agentId}/ws`,
      {
        headers: {
          ...AUTH_HEADERS,
          Upgrade: "websocket",
        },
      },
    );
    const ws = wsResponse.webSocket;
    if (!ws) {
      throw new Error("Expected WebSocket upgrade");
    }
    ws.accept();

    await nextSocketMessage(ws, (m) => m.type === "hello", "hello");
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

    const resumeResp = await SELF.fetch(
      `https://agent.test/api/agents/${agentId}/takeovers/${encodeURIComponent(takeoverId)}/resume`,
      {
        method: "POST",
        headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
        body: JSON.stringify({ note: "MFA completed" }),
      },
    );
    expect(resumeResp.status).toBe(200);
    const resumeJson = TakeoverResumeResponseSchema.parse(
      await resumeResp.json(),
    );
    expect(resumeJson.takeoverId).toBe(takeoverId);
    expect(resumeJson.delivered).toBe("delivered");

    await postTakeoverPromise;

    ws.close();
  });
});
