import { LOCAL_DEV_AUTH_TOKEN } from "@pi-in-the-sky/client/protocol";
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { TestPersonalAgent } from "./worker";

const AUTH_HEADERS = {
  Authorization: `Bearer ${LOCAL_DEV_AUTH_TOKEN}`,
};

const SocketMessageSchema = z
  .object({
    type: z.string(),
    id: z.string().optional(),
    result: z.unknown().optional(),
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

const CompactResultSchema = z.object({
  ok: z.literal(true),
  noteId: z.number(),
});

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

describe("cfw-agent activities and compaction integration", () => {
  it("spawns a background subagent activity, persists encrypted record, and compacts the stream", async () => {
    const stub: DurableObjectStub<TestPersonalAgent> =
      env.PersonalAgent.getByName("personal");

    await stub.setScript("personal", [
      {
        toolCalls: [
          {
            id: "tc-spawn",
            name: "activity_spawn",
            arguments: {
              title: "Lisbon flight search",
              instructions: "Find nonstop flights SFO -> LIS in October.",
              summary: "Searching nonstop SFO -> LIS flights.",
            },
          },
        ],
      },
      {
        text: "Started searching for Lisbon flights in the background.",
      },
      {
        toolCalls: [
          {
            id: "tc-complete",
            name: "activity_complete",
            arguments: {
              activityId: "act-2",
              summary: "Found TAP TP236 nonstop SFO -> LIS ($840).",
            },
          },
        ],
      },
      {
        text: "Lisbon search finished.",
      },
    ]);

    const wsResponse = await SELF.fetch("https://agent.test/api/me/ws", {
      headers: {
        ...AUTH_HEADERS,
        Upgrade: "websocket",
      },
    });
    const ws = wsResponse.webSocket;
    if (!ws) {
      throw new Error("Expected WebSocket upgrade");
    }
    ws.accept();

    await nextSocketMessage(ws, (m) => m.type === "hello");
    ws.send(JSON.stringify({ type: "watch", id: "cmd-watch-act" }));
    await nextSocketMessage(ws, (m) => m.type === "view");

    const activityCreated = nextSocketMessage(
      ws,
      (m) => m.type === "activity_updated" && m.activity?.status === "running",
      "activity_updated running",
      10_000,
    );

    ws.send(
      JSON.stringify({
        type: "submit",
        id: "cmd-submit-act",
        input: "Find me a flight to Lisbon.",
      }),
    );

    const runningMsg = await activityCreated;
    expect(runningMsg.activity?.title).toBe("Lisbon flight search");

    const rawSqlite = await stub.dumpRawSqliteText();
    expect(rawSqlite).not.toContain("Lisbon flight search");

    const compactDone = nextSocketMessage(
      ws,
      (m) => m.type === "result" && m.id === "cmd-compact",
      "compact result",
    );
    ws.send(
      JSON.stringify({
        type: "compact",
        id: "cmd-compact",
        summary: "Discussed Lisbon trip; TAP TP236 shortlisted.",
      }),
    );
    const compactMsg = await compactDone;
    expect(CompactResultSchema.parse(compactMsg.result).ok).toBe(true);

    ws.close();
  });
});
