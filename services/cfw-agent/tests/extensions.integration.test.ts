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

const LIB_MATH_TS = `
export function sumNumbers(values: readonly number[]): number {
  return values.reduce((acc, n) => acc + n, 0);
}
`.trim();

const TOOL_SUM_TS = `
import { sumNumbers } from "../lib/math.ts";

interface SumInput {
  numbers?: number[];
}

export default {
  async fetch(request: Request): Promise<Response> {
    const body = (await request.json()) as { input?: SumInput };
    const values = Array.isArray(body.input?.numbers) ? body.input.numbers : [];
    return Response.json({
      sum: sumNumbers(values),
      count: values.length,
    });
  },
};
`.trim();

const FACET_V1_TS = `
import { DurableObject } from "cloudflare:workers";

export class InboxCursorFacet extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS cursor_state (id INTEGER PRIMARY KEY, cursor INTEGER NOT NULL)",
    );
  }

  async fetch(request: Request): Promise<Response> {
    const body = (await request.json()) as { input?: { delta?: number } };
    const delta = Number(body.input?.delta ?? 1);
    const row = this.ctx.storage.sql
      .exec<{ cursor: number }>("SELECT cursor FROM cursor_state WHERE id = 1")
      .toArray()[0];
    const next = (row?.cursor ?? 0) + delta;
    this.ctx.storage.sql.exec(
      "INSERT INTO cursor_state (id, cursor) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET cursor = excluded.cursor",
      next,
    );
    return Response.json({ version: "v1", cursor: next });
  }
}
`.trim();

const FACET_V2_TS = FACET_V1_TS.replace('version: "v1"', 'version: "v2"');

describe("cfw-agent extension/ workspace (Artifacts + Dynamic Workers + DO Facets)", () => {
  it("overlays bundled built-in extension/ files with Artifacts, runs cross-module Dynamic Workers, persists state in DO Facets across code updates, and restores overridden built-ins on delete", async () => {
    const stub: DurableObjectStub<TestPersonalAgent> =
      env.PersonalAgent.getByName("personal");

    await stub.setScript("personal", [
      {
        toolCalls: [
          {
            id: "tc-list-builtin",
            name: "list_files",
            arguments: {},
          },
          {
            id: "tc-read-builtin",
            name: "read_file",
            arguments: { path: "instructions.md" },
          },
          {
            id: "tc-override-skill",
            name: "write_file",
            arguments: {
              path: "skills/email-inbox-triage/SKILL.md",
              content:
                "# Custom Inbox Triage\nAlways prioritize VIP senders.\n",
              commitMessage: "Override built-in email-inbox-triage skill",
            },
          },
          {
            id: "tc-write-lib",
            name: "write_file",
            arguments: {
              path: "lib/math.ts",
              content: LIB_MATH_TS,
              commitMessage: "Add extension/lib/math.ts",
            },
          },
          {
            id: "tc-write-tool",
            name: "write_file",
            arguments: {
              path: "tools/sum.ts",
              content: TOOL_SUM_TS,
              commitMessage: "Add extension/tools/sum.ts",
            },
          },
          {
            id: "tc-write-skill",
            name: "write_file",
            arguments: {
              path: "skills/triage/SKILL.md",
              content: "# Triage Skill\nSort incoming items by urgency.\n",
              commitMessage: "Add triage skill",
            },
          },
          {
            id: "tc-write-facet-v1",
            name: "write_file",
            arguments: {
              path: "extension.ts",
              content: FACET_V1_TS,
              commitMessage: "Add InboxCursorFacet v1",
            },
          },
        ],
      },
      {
        toolCalls: [
          {
            id: "tc-list",
            name: "list_files",
            arguments: {},
          },
          {
            id: "tc-read",
            name: "read_file",
            arguments: { path: "skills/triage/SKILL.md" },
          },
          {
            id: "tc-read-override",
            name: "read_file",
            arguments: { path: "skills/email-inbox-triage/SKILL.md" },
          },
          {
            id: "tc-run-sum",
            name: "run_module",
            arguments: {
              path: "tools/sum.ts",
              input: { numbers: [10, 20, 12] },
            },
          },
          {
            id: "tc-facet-1",
            name: "run_module",
            arguments: {
              path: "extension.ts",
              facet: "inbox",
              className: "InboxCursorFacet",
              input: { delta: 1 },
            },
          },
        ],
      },
      {
        toolCalls: [
          {
            id: "tc-facet-2",
            name: "run_module",
            arguments: {
              path: "extension.ts",
              facet: "inbox",
              className: "InboxCursorFacet",
              input: { delta: 1 },
            },
          },
        ],
      },
      {
        toolCalls: [
          {
            id: "tc-write-facet-v2",
            name: "write_file",
            arguments: {
              path: "extension.ts",
              content: FACET_V2_TS,
              commitMessage: "Upgrade InboxCursorFacet to v2",
            },
          },
        ],
      },
      {
        toolCalls: [
          {
            id: "tc-facet-3",
            name: "run_module",
            arguments: {
              path: "extension.ts",
              facet: "inbox",
              className: "InboxCursorFacet",
              input: { delta: 1 },
            },
          },
          {
            id: "tc-delete-tool",
            name: "delete_file",
            arguments: {
              path: "tools/sum.ts",
              commitMessage: "Remove temporary sum tool",
            },
          },
          {
            id: "tc-delete-override",
            name: "delete_file",
            arguments: {
              path: "skills/email-inbox-triage/SKILL.md",
              commitMessage: "Restore built-in email-inbox-triage skill",
            },
          },
        ],
      },
      {
        text: "Workspace verified: sum=42 and inbox facet v2 cursor=3.",
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
        m.type === "view" &&
        JSON.stringify(m.view ?? null).includes("cursor=3"),
      "final view with cursor=3",
      20_000,
    );

    ws.send(
      JSON.stringify({
        type: "submit",
        id: "cmd-submit-ext",
        input: "Set up extension/ tools, skills, and stateful inbox facet.",
      }),
    );

    const finalMsg = await doneView;
    const serialized = JSON.stringify(finalMsg.view ?? null);
    expect(serialized).toContain("instructions.md");
    expect(serialized).toContain("Always prioritize VIP senders.");
    expect(serialized).toContain('\\"source\\":\\"override\\"');
    expect(serialized).toContain('\\"restoredBuiltin\\":true');
    expect(serialized).toContain("skills/triage/SKILL.md");
    expect(serialized).toContain('\\"sum\\":42');
    expect(serialized).toContain('\\"count\\":3');
    expect(serialized).toContain('\\"version\\":\\"v1\\",\\"cursor\\":1');
    expect(serialized).toContain('\\"version\\":\\"v1\\",\\"cursor\\":2');
    expect(serialized).toContain('\\"version\\":\\"v2\\",\\"cursor\\":3');
    expect(serialized).not.toContain('"isError":true');

    ws.close();
  });
});
