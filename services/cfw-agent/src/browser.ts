import {
  defineSignal,
  type Extension,
  type TaskId,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { bool, obj, opt, str } from "@earendil-works/pi-schema";
import { err } from "@pi-in-the-sky/result-monad";

import { fetchJsonWithBearer, toToolResult } from "./http-tool";

type BrowserConfig = {
  readonly endpoint?: string;
  readonly token?: string;
};

export type BrowserTakeoverRecord = {
  readonly id: string;
  readonly taskId: TaskId;
  readonly url: string;
  readonly liveViewUrl: string | null;
  readonly reason: string;
  readonly status: "waiting" | "resumed";
  readonly createdAt: number;
};

const TakeoverResumeSchema = obj({
  resumed: bool(),
  note: opt(str()),
});

export const BrowserTakeoverSignal = defineSignal({
  name: "browser.takeover",
  version: 1,
  schema: TakeoverResumeSchema,
});

export class BrowserStore {
  readonly #sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
    this.#migrate();
  }

  #migrate(): void {
    this.#sql.exec(`
      CREATE TABLE IF NOT EXISTS browser_takeovers (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        url TEXT NOT NULL,
        live_view_url TEXT,
        reason TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
  }

  createTakeover(input: {
    readonly id: string;
    readonly taskId: TaskId;
    readonly url: string;
    readonly liveViewUrl: string | null;
    readonly reason: string;
  }): BrowserTakeoverRecord {
    const createdAt = Date.now();
    this.#sql.exec(
      `INSERT OR IGNORE INTO browser_takeovers (
        id, task_id, url, live_view_url, reason, status, created_at
      ) VALUES (?, ?, ?, ?, ?, 'waiting', ?)`,
      input.id,
      String(input.taskId),
      input.url,
      input.liveViewUrl,
      input.reason,
      createdAt,
    );
    return this.getTakeover(input.id)!;
  }

  getTakeover(id: string): BrowserTakeoverRecord | undefined {
    const rows = this.#sql
      .exec<{
        id: string;
        task_id: string;
        url: string;
        live_view_url: string | null;
        reason: string;
        status: "waiting" | "resumed";
        created_at: number;
      }>(
        "SELECT id, task_id, url, live_view_url, reason, status, created_at FROM browser_takeovers WHERE id = ?",
        id,
      )
      .toArray();
    const row = rows[0];
    if (!row) {
      return undefined;
    }
    return {
      id: row.id,
      taskId: row.task_id as unknown as TaskId,
      url: row.url,
      liveViewUrl: row.live_view_url,
      reason: row.reason,
      status: row.status,
      createdAt: row.created_at,
    };
  }

  markResumed(id: string): void {
    this.#sql.exec(
      "UPDATE browser_takeovers SET status = 'resumed' WHERE id = ?",
      id,
    );
  }
}

const NavigateSchema = obj({
  url: str(),
});

const SnapshotSchema = obj({
  selector: opt(str()),
});

const ClickSchema = obj({
  selector: str(),
});

const FillSchema = obj({
  selector: str(),
  value: str(),
});

const TakeoverSchema = obj({
  url: str(),
  reason: str(),
  liveViewUrl: opt(str()),
});

type TakeoverCheckpoint = {
  readonly takeoverId: string;
};

export function createBrowserExtension(
  store: BrowserStore,
  getConfig: () => BrowserConfig,
  onTakeoverRequested?: (record: BrowserTakeoverRecord) => void,
  fetcher: typeof fetch = fetch,
): Extension {
  const runAction = async (
    action: "navigate" | "snapshot" | "click" | "fill",
    payload: Record<string, unknown>,
  ) => {
    const config = getConfig();
    if (!config.endpoint) {
      return toToolResult(
        err(
          "Browser runtime endpoint is not configured. Set BROWSER_RUN_ENDPOINT.",
        ),
      );
    }
    const base = config.endpoint.replace(/\/$/, "");
    return toToolResult(
      await fetchJsonWithBearer(`${base}/${action}`, fetcher, {
        token: config.token,
        errorPrefix: "Browser",
        init: {
          method: "POST",
          body: JSON.stringify(payload),
        },
      }),
    );
  };

  const navigateTool: ToolRegistration<typeof NavigateSchema> = {
    name: "browser_navigate",
    description: "Navigate the active browser tab to a URL.",
    parameters: NavigateSchema,
    replay: "safe",
    execute: ({ url }) => runAction("navigate", { url }),
  };

  const snapshotTool: ToolRegistration<typeof SnapshotSchema> = {
    name: "browser_snapshot",
    description:
      "Read a structured snapshot of the current browser page or a specific CSS selector.",
    parameters: SnapshotSchema,
    replay: "safe",
    execute: ({ selector }) => runAction("snapshot", { selector }),
  };

  const clickTool: ToolRegistration<typeof ClickSchema> = {
    name: "browser_click",
    description: "Click an element matching a CSS selector in the browser.",
    parameters: ClickSchema,
    replay: "unsafe",
    execute: ({ selector }) => runAction("click", { selector }),
  };

  const fillTool: ToolRegistration<typeof FillSchema> = {
    name: "browser_fill",
    description: "Fill an input field matching a CSS selector with a value.",
    parameters: FillSchema,
    replay: "unsafe",
    execute: ({ selector, value }) => runAction("fill", { selector, value }),
  };

  const takeoverTool: ToolRegistration<
    typeof TakeoverSchema,
    TakeoverCheckpoint,
    TakeoverCheckpoint
  > = {
    name: "browser_request_takeover",
    description:
      "Pause browser automation and hand control to the user via Live View for sign-in, CAPTCHA, or MFA.",
    parameters: TakeoverSchema,
    replay: "safe",
    async execute(args, api, context) {
      if (api.wake?.reason === "signal" && api.checkpoint) {
        const signal = await api.readSignal(
          BrowserTakeoverSignal,
          api.checkpoint.takeoverId,
          context,
        );
        if (signal?.kind === "value") {
          store.markResumed(api.checkpoint.takeoverId);
          return {
            output: [
              {
                type: "text",
                text: JSON.stringify({
                  takeoverId: api.checkpoint.takeoverId,
                  resumed: signal.value.resumed,
                  note: signal.value.note ?? null,
                }),
              },
            ],
          };
        }
        return {
          isError: true,
          output: [{ type: "text", text: "Browser takeover expired." }],
        };
      }

      const takeoverId = api.callId;
      const record = store.createTakeover({
        id: takeoverId,
        taskId: api.taskId,
        url: args.url,
        liveViewUrl: args.liveViewUrl ?? null,
        reason: args.reason,
      });
      onTakeoverRequested?.(record);

      return {
        kind: "sleep",
        checkpoint: { takeoverId },
        signals: [BrowserTakeoverSignal.key(takeoverId)],
      };
    },
  };

  return {
    name: "browser",
    tools: [navigateTool, snapshotTool, clickTool, fillTool, takeoverTool],
  };
}
