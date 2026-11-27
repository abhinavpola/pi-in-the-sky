import {
  defineSignal,
  type Extension,
  type TaskId,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { bool, obj, opt, str } from "@earendil-works/pi-schema";
import {
  type TakeoverRecord,
  TakeoverRecordSchema,
} from "@pi-in-the-sky/client/protocol";
import { err } from "@pi-in-the-sky/result-monad";

import {
  fetchJsonWithBearer,
  type HttpFetcher,
  toToolResult,
} from "./http-tool";
import type { VaultCipher } from "./vault";

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

export type BrowserTakeoverRecord = TakeoverRecord & {
  readonly taskId: TaskId;
  readonly createdAt: number;
};

type BrowserRuntimeConfig = {
  readonly endpoint?: string;
  readonly token?: string;
};

type BrowserTakeoverRow = {
  id: string;
  task_id: TaskId;
  payload_enc: string;
  status: TakeoverRecord["status"];
  created_at: number;
};

const TakeoverPayloadSchema = TakeoverRecordSchema.pick({
  url: true,
  liveViewUrl: true,
  reason: true,
});

export class BrowserStore {
  readonly #sql: SqlStorage;
  readonly #vault: VaultCipher;

  constructor(sql: SqlStorage, vault: VaultCipher) {
    this.#sql = sql;
    this.#vault = vault;
    this.#sql.exec(`
      CREATE TABLE IF NOT EXISTS browser_takeovers_vault (
        id TEXT PRIMARY KEY,
        task_id INTEGER NOT NULL,
        payload_enc TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
  }

  async createTakeover(input: {
    readonly id: string;
    readonly taskId: TaskId;
    readonly url: string;
    readonly liveViewUrl: string | null;
    readonly reason: string;
  }): Promise<BrowserTakeoverRecord> {
    const createdAt = Date.now();
    const encrypted = await this.#vault.encryptJson(
      {
        url: input.url,
        liveViewUrl: input.liveViewUrl,
        reason: input.reason,
      },
      `browser_takeovers:${input.id}`,
    );
    this.#sql.exec(
      `INSERT OR IGNORE INTO browser_takeovers_vault (
        id, task_id, payload_enc, status, created_at
      ) VALUES (?, ?, ?, 'waiting', ?)`,
      input.id,
      Number(input.taskId),
      encrypted,
      createdAt,
    );
    const created = await this.getTakeover(input.id);
    if (!created) {
      throw new Error(`Failed to persist browser takeover ${input.id}`);
    }
    return created;
  }

  async #toTakeover(row: BrowserTakeoverRow): Promise<BrowserTakeoverRecord> {
    const payload = await this.#vault.decryptJson(
      row.payload_enc,
      `browser_takeovers:${row.id}`,
      TakeoverPayloadSchema,
    );
    return {
      id: row.id,
      taskId: row.task_id,
      url: payload.url,
      liveViewUrl: payload.liveViewUrl,
      reason: payload.reason,
      status: row.status,
      createdAt: row.created_at,
    };
  }

  async getTakeover(id: string): Promise<BrowserTakeoverRecord | undefined> {
    const rows = this.#sql
      .exec<BrowserTakeoverRow>(
        "SELECT id, task_id, payload_enc, status, created_at FROM browser_takeovers_vault WHERE id = ?",
        id,
      )
      .toArray();
    const row = rows[0];
    if (!row) {
      return undefined;
    }
    return this.#toTakeover(row);
  }

  async listWaitingTakeovers(): Promise<BrowserTakeoverRecord[]> {
    const rows = this.#sql
      .exec<BrowserTakeoverRow>(
        "SELECT id, task_id, payload_enc, status, created_at FROM browser_takeovers_vault WHERE status = 'waiting' ORDER BY created_at ASC",
      )
      .toArray();
    return Promise.all(rows.map((row) => this.#toTakeover(row)));
  }

  markResumed(id: string): void {
    this.#sql.exec(
      "UPDATE browser_takeovers_vault SET status = 'resumed' WHERE id = ?",
      id,
    );
  }

  clearWaitingTakeovers(): void {
    this.#sql.exec(
      "UPDATE browser_takeovers_vault SET status = 'resumed' WHERE status = 'waiting'",
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
  const runAction = async (
    action: BrowserAction,
    body: Record<string, unknown>,
  ) => {
    const config = getConfig();
    if (!config.endpoint) {
      return toToolResult(
        err("BROWSER_RUN_ENDPOINT is not configured for browser automation."),
      );
    }
    const base = config.endpoint.replace(/\/$/, "");
    const result = await fetchJsonWithBearer(`${base}/${action}`, fetcher, {
      token: config.token,
      errorPrefix: "Browser",
      init: {
        method: "POST",
        body: JSON.stringify(body),
      },
    });
    return toToolResult(result);
  };

  const navigateTool: ToolRegistration<typeof NavigateSchema> = {
    name: "browser_navigate",
    description: "Navigate the cloud browser session to a URL.",
    parameters: NavigateSchema,
    replay: "safe",
    execute: ({ url }) => runAction("navigate", { url }),
  };

  const snapshotTool: ToolRegistration<typeof SnapshotSchema> = {
    name: "browser_snapshot",
    description:
      "Capture a structured accessibility/text snapshot of the current browser page.",
    parameters: SnapshotSchema,
    replay: "safe",
    execute: ({ selector }) =>
      runAction("snapshot", selector ? { selector } : {}),
  };

  const clickTool: ToolRegistration<typeof ClickSchema> = {
    name: "browser_click",
    description: "Click an element on the current browser page by selector.",
    parameters: ClickSchema,
    replay: "unsafe",
    execute: ({ selector }) => runAction("click", { selector }),
  };

  const fillTool: ToolRegistration<typeof FillSchema> = {
    name: "browser_fill",
    description: "Fill an input field on the current browser page.",
    parameters: FillSchema,
    replay: "unsafe",
    execute: ({ selector, value }) => runAction("fill", { selector, value }),
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
      const record = await store.createTakeover({
        id: takeoverId,
        taskId: api.taskId,
        url: args.url,
        liveViewUrl: args.liveViewUrl ?? null,
        reason: args.reason,
      });
      onTakeoverRequested(record);
      return {
        kind: "sleep",
        checkpoint: { takeoverId },
        signals: [BrowserTakeoverSignal.key(takeoverId)],
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
