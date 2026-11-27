import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { TestPersonalAgent } from "./worker";

const AUTH_HEADERS = {
  Authorization: "Bearer test-secret-token",
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
  it("enforces bearer auth and exposes health endpoint", async () => {
    const health = await SELF.fetch("https://agent.test/health");
    expect(health.status).toBe(200);
    expect(HealthResponseSchema.parse(await health.json())).toEqual({
      ok: true,
    });

    const unauthorized = await SELF.fetch(
      "https://agent.test/api/agents/auth-check/profile",
    );
    expect(unauthorized.status).toBe(401);

    const authorized = await SELF.fetch(
      "https://agent.test/api/agents/auth-check/profile",
      { headers: AUTH_HEADERS },
    );
    expect(authorized.status).toBe(200);
    expect(ProfileResponseSchema.parse(await authorized.json())).toEqual({
      entries: [],
    });
  });

  it("plans a repeat trip using memory, skills, Gmail, Calendar, browser, and FTS5 notes", async () => {
    const agentId = "trip-planner-e2e";

    const putProfile = await SELF.fetch(
      `https://agent.test/api/agents/${agentId}/profile`,
      {
        method: "PUT",
        headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
        body: JSON.stringify({ key: "home_airport", value: "SFO" }),
      },
    );
    expect(putProfile.status).toBe(200);

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
        text: "Found ANA NH7 nonstop SFO -> NRT for Oct 12-20, 2026 ($1,120). Want me to go ahead and book it?",
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
        input: "Look up my Tokyo trip from last year and plan the same trip.",
      }),
    );

    const submitResult = await nextSocketMessage(
      ws,
      (m) => m.type === "result" && m.id === "cmd-submit-1",
    );
    expect(submitResult.type).toBe("result");

    await nextSocketMessage(
      ws,
      (m) => m.type === "ops" && JSON.stringify(m).includes("ANA NH7"),
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

    ws.send(
      JSON.stringify({
        type: "submit",
        id: "cmd-submit-dup",
        operationId: promptOpId,
        input: "Look up my Tokyo trip from last year and plan the same trip.",
      }),
    );
    const dupResult = await nextSocketMessage(
      ws,
      (m) => m.type === "result" && m.id === "cmd-submit-dup",
    );
    expect(dupResult.type).toBe("result");

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

    ws.close();
  });
});
