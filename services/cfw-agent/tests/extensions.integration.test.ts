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
    view: z.unknown().optional(),
    result: z.unknown().optional(),
  })
  .passthrough();

type ParsedSocketMessage = z.infer<typeof SocketMessageSchema>;

function nextSocketMessage(
  ws: WebSocket,
  predicate: (message: ParsedSocketMessage) => boolean,
  label = "message",
  timeoutMs = 10_000,
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

const EXTENSION_CODE = `
export default {
  async fetch(request) {
    const { input } = await request.json();
    const values = Array.isArray(input?.numbers) ? input.numbers : [];
    const sum = values.reduce((acc, n) => acc + Number(n), 0);
    return Response.json({ sum, count: values.length });
  },
};
`.trim();

describe("cfw-agent Cloudflare Artifacts + Dynamic Worker Loaders integration", () => {
  it("saves an extension to Artifacts, lists and reads it, executes it in a sandboxed Dynamic Worker, and deletes it", async () => {
    const stub: DurableObjectStub<TestPersonalAgent> =
      env.PersonalAgent.getByName("personal");

    await stub.setScript("personal", [
      {
        toolCalls: [
          {
            id: "tc-save",
            name: "extension_save",
            arguments: {
              name: "sum-numbers",
              description: "Sums an array of numbers inside a Dynamic Worker.",
              code: EXTENSION_CODE,
              commitMessage: "Add sum-numbers extension",
            },
          },
        ],
      },
      {
        toolCalls: [
          {
            id: "tc-list",
            name: "extension_list",
            arguments: {},
          },
          {
            id: "tc-read",
            name: "extension_read",
            arguments: { name: "sum-numbers" },
          },
          {
            id: "tc-run",
            name: "extension_run",
            arguments: {
              name: "sum-numbers",
              input: { numbers: [10, 20, 12] },
            },
          },
        ],
      },
      {
        toolCalls: [
          {
            id: "tc-delete",
            name: "extension_delete",
            arguments: {
              name: "sum-numbers",
              commitMessage: "Remove sum-numbers extension",
            },
          },
        ],
      },
      {
        text: "Saved, ran (sum=42), and deleted sum-numbers.",
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
    ws.send(JSON.stringify({ type: "watch", id: "cmd-watch-ext" }));
    await nextSocketMessage(ws, (m) => m.type === "view");

    const doneView = nextSocketMessage(
      ws,
      (m) =>
        m.type === "view" && JSON.stringify(m.view ?? null).includes("sum=42"),
      "final view with sum=42",
      15_000,
    );

    ws.send(
      JSON.stringify({
        type: "submit",
        id: "cmd-submit-ext",
        input: "Write and run a sum-numbers extension for [10, 20, 12].",
      }),
    );

    const finalMsg = await doneView;
    const serialized = JSON.stringify(finalMsg.view ?? null);
    expect(serialized).toContain("sum-numbers");
    expect(serialized).toContain('\\"sum\\":42');
    expect(serialized).toContain('\\"count\\":3');
    expect(serialized).not.toContain('"isError":true');

    ws.close();
  });
});
