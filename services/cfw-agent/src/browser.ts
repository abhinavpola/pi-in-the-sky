import {
  defineSignal,
  type Extension,
  type TaskId,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { bool, obj, opt, str } from "@earendil-works/pi-schema";
import { err } from "@pi-in-the-sky/result-monad";

import {
  fetchJsonWithBearer,
  type HttpFetcher,
  toToolResult,
} from "./http-tool";

const TakeoverResumeSchema = obj({
  resumed: bool(),
  note: opt(str()),
});

export const BrowserTakeoverSignal = defineSignal({
  name: "personal-agent:browser-takeover",
  version: 1,
  schema: TakeoverResumeSchema,
});

type TakeoverCheckpoint = {
  readonly takeoverId: string;
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

type BrowserRuntimeConfig = {
  readonly endpoint?: string;
  readonly token?: string;
};

type BrowserTakeoverRow = {
  id: string;
  task_id: TaskId;
  url: string;
  live_view_url: string | null;
  reason: string;
  status: "waiting" | "resumed";
  created_at: number;
};

export class BrowserStore {
  readonly #sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
    this.#sql.exec(`
      CREATE TABLE IF NOT EXISTS browser_takeovers (
        id TEXT PRIMARY KEY,
        task_id INTEGER NOT NULL,
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
      Number(input.taskId),
      input.url,
      input.liveViewUrl,
      input.reason,
      createdAt,
    );
    const created = this.getTakeover(input.id);
    if (!created) {
      throw new Error(`Failed to persist browser takeover ${input.id}`);
    }
    return created;
  }

  #toTakeover(row: BrowserTakeoverRow): BrowserTakeoverRecord {
    return {
      id: row.id,
      taskId: row.task_id,
      url: row.url,
      liveViewUrl: row.live_view_url,
      reason: row.reason,
      status: row.status,
      createdAt: row.created_at,
    };
  }

  getTakeover(id: string): BrowserTakeoverRecord | undefined {
    const rows = this.#sql
      .exec<BrowserTakeoverRow>(
        "SELECT id, task_id, url, live_view_url, reason, status, created_at FROM browser_takeovers WHERE id = ?",
        id,
      )
      .toArray();
    const row = rows[0];
    if (!row) {
      return undefined;
    }
    return this.#toTakeover(row);
  }

  listWaitingTakeovers(): BrowserTakeoverRecord[] {
    const rows = this.#sql
      .exec<BrowserTakeoverRow>(
        "SELECT id, task_id, url, live_view_url, reason, status, created_at FROM browser_takeovers WHERE status = 'waiting' ORDER BY created_at ASC",
      )
      .toArray();
    return rows.map((row) => this.#toTakeover(row));
  }

  markResumed(id: string): void {
    this.#sql.exec(
      "UPDATE browser_takeovers SET status = 'resumed' WHERE id = ?",
      id,
    );
  }

  clearWaitingTakeovers(): void {
    this.#sql.exec(
      "UPDATE browser_takeovers SET status = 'resumed' WHERE status = 'waiting'",
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

const RequestTakeoverSchema = obj({
  url: str(),
  reason: str(),
  liveViewUrl: opt(str()),
});

type BrowserAction = "navigate" | "snapshot" | "click" | "fill";

export function createBrowserExtension(
  store: BrowserStore,
  getConfig: () => BrowserRuntimeConfig,
  onTakeoverRequested: (record: BrowserTakeoverRecord) => void,
  fetcher: HttpFetcher = (input, init) => fetch(input, init),
): Extension {
  const invokeBrowser = async (
    action: BrowserAction,
    payload: Record<string, unknown>,
  ) => {
    const config = getConfig();
    if (!config.endpoint) {
      return toToolResult(
        err(
          "Browser runtime is not configured. Set BROWSER_RUN_ENDPOINT to enable browser tools.",
        ),
      );
    }
    const base = config.endpoint.replace(/\/$/, "");
    const result = await fetchJsonWithBearer(`${base}/${action}`, fetcher, {
      token: config.token,
      init: {
        method: "POST",
        body: JSON.stringify(payload),
      },
      errorPrefix: "Browser runtime error",
    });
    return toToolResult(result);
  };

  const navigateTool: ToolRegistration<typeof NavigateSchema> = {
    name: "browser_navigate",
    description:
      "Navigate the remote browser session to a URL and return the page title and text summary.",
    parameters: NavigateSchema,
    replay: "safe",
    execute: ({ url }) => invokeBrowser("navigate", { url }),
  };

  const snapshotTool: ToolRegistration<typeof SnapshotSchema> = {
    name: "browser_snapshot",
    description:
      "Capture an accessibility/DOM snapshot of the current browser page or a CSS selector.",
    parameters: SnapshotSchema,
    replay: "safe",
    execute: ({ selector }) => invokeBrowser("snapshot", { selector }),
  };

  const clickTool: ToolRegistration<typeof ClickSchema> = {
    name: "browser_click",
    description: "Click an element in the remote browser by CSS selector.",
    parameters: ClickSchema,
    replay: "unsafe",
    execute: ({ selector }) => invokeBrowser("click", { selector }),
  };

  const fillTool: ToolRegistration<typeof FillSchema> = {
    name: "browser_fill",
    description: "Fill an input field in the remote browser by CSS selector.",
    parameters: FillSchema,
    replay: "unsafe",
    execute: ({ selector, value }) =>
      invokeBrowser("fill", { selector, value }),
  };

  const requestTakeoverTool: ToolRegistration<
    typeof RequestTakeoverSchema,
    TakeoverCheckpoint,
    TakeoverCheckpoint
  > = {
    name: "browser_request_takeover",
    description:
      "Pause the agent and ask the user to take over the browser Live View for login, MFA, CAPTCHA, or checkout.",
    parameters: RequestTakeoverSchema,
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
      onTakeoverRequested(record);
      return {
        park: {
          checkpoint: { takeoverId },
          wait: {
            kind: "signal",
            signal: BrowserTakeoverSignal,
            key: takeoverId,
          },
        },
      };
    },
  };

  return {
    name: "browser",
    tools: [
      navigateTool,
      snapshotTool,
      clickTool,
      fillTool,
      requestTakeoverTool,
    ],
  };
}
