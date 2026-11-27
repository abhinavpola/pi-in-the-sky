import puppeteer, {
  type Browser,
  type BrowserWorker,
  type Page,
} from "@cloudflare/puppeteer";
import {
  defineSignal,
  type Extension,
  type TaskId,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { bool, obj, opt, str } from "@earendil-works/pi-schema";
import type { TakeoverRecord } from "@pi-in-the-sky/client/protocol";
import { err, ok, type Result } from "@pi-in-the-sky/result-monad";

import { toToolResult } from "./http-tool";

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

type BrowserTakeoverRow = {
  id: string;
  task_id: TaskId;
  conversation_id: number;
  url: string;
  live_view_url: string | null;
  reason: string;
  status: TakeoverRecord["status"];
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
        conversation_id INTEGER NOT NULL DEFAULT 0,
        url TEXT NOT NULL,
        live_view_url TEXT,
        reason TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS browser_session_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  getSessionId(conversationId: string): string | undefined {
    const row = this.#sql
      .exec<{ value: string }>(
        "SELECT value FROM browser_session_state WHERE key = ?",
        `session_id:${conversationId}`,
      )
      .toArray()[0];
    return row?.value;
  }

  setSessionId(conversationId: string, sessionId: string): void {
    this.#sql.exec(
      `INSERT INTO browser_session_state (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      `session_id:${conversationId}`,
      sessionId,
    );
  }

  clearSessionId(conversationId: string): void {
    this.#sql.exec(
      "DELETE FROM browser_session_state WHERE key = ?",
      `session_id:${conversationId}`,
    );
  }

  createTakeover(input: {
    readonly id: string;
    readonly taskId: TaskId;
    readonly conversationId: number;
    readonly url: string;
    readonly liveViewUrl: string | null;
    readonly reason: string;
  }): BrowserTakeoverRecord {
    const createdAt = Date.now();
    this.#sql.exec(
      `INSERT OR IGNORE INTO browser_takeovers (
        id, task_id, conversation_id, url, live_view_url, reason, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'waiting', ?)`,
      input.id,
      Number(input.taskId),
      input.conversationId,
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
    const row = this.#sql
      .exec<BrowserTakeoverRow>(
        "SELECT id, task_id, conversation_id, url, live_view_url, reason, status, created_at FROM browser_takeovers WHERE id = ?",
        id,
      )
      .toArray()[0];
    return row ? this.#toTakeover(row) : undefined;
  }

  listWaitingTakeovers(): BrowserTakeoverRecord[] {
    return this.#sql
      .exec<BrowserTakeoverRow>(
        "SELECT id, task_id, conversation_id, url, live_view_url, reason, status, created_at FROM browser_takeovers WHERE status = 'waiting' ORDER BY created_at ASC",
      )
      .toArray()
      .map((row) => this.#toTakeover(row));
  }

  markResumed(id: string): void {
    this.#sql.exec(
      "UPDATE browser_takeovers SET status = 'resumed' WHERE id = ?",
      id,
    );
  }

  clearWaitingTakeovers(conversationId: number): void {
    this.#sql.exec(
      "UPDATE browser_takeovers SET status = 'resumed' WHERE status = 'waiting' AND conversation_id = ?",
      conversationId,
    );
  }
}

type BrowserActionRequest =
  | {
      readonly action: "navigate";
      readonly conversationId: string;
      readonly url: string;
    }
  | {
      readonly action: "snapshot";
      readonly conversationId: string;
      readonly selector?: string;
    }
  | {
      readonly action: "click";
      readonly conversationId: string;
      readonly selector: string;
    }
  | {
      readonly action: "fill";
      readonly conversationId: string;
      readonly selector: string;
      readonly value: string;
    };

export type BrowserExecutor = (
  req: BrowserActionRequest,
) => Promise<Result<unknown, string>>;

async function openOrReuseBrowser(
  binding: BrowserWorker,
  store: BrowserStore,
  conversationId: string,
): Promise<Browser> {
  const existingId = store.getSessionId(conversationId);
  if (existingId) {
    try {
      return await puppeteer.connect(binding, existingId);
    } catch {
      store.clearSessionId(conversationId);
    }
  }
  const browser = await puppeteer.launch(binding, { keep_alive: 60_000 });
  store.setSessionId(conversationId, browser.sessionId());
  return browser;
}

async function activePage(browser: Browser): Promise<Page> {
  const pages = await browser.pages();
  return pages[0] ?? browser.newPage();
}

export function createPuppeteerBrowserExecutor(
  getBinding: () => BrowserWorker | undefined,
  store: BrowserStore,
): BrowserExecutor {
  return async (req) => {
    const binding = getBinding();
    if (!binding) {
      return err(
        "Cloudflare Browser Rendering binding (BROWSER) is not available.",
      );
    }
    let browser: Browser | undefined;
    try {
      browser = await openOrReuseBrowser(binding, store, req.conversationId);
      const page = await activePage(browser);
      switch (req.action) {
        case "navigate": {
          await page.goto(req.url, { waitUntil: "domcontentloaded" });
          return ok({ url: page.url(), title: await page.title() });
        }
        case "snapshot": {
          const html = req.selector
            ? await page.$eval(req.selector, (el) => el.textContent ?? "")
            : await page.content();
          const text = html
            .replace(/<script[\s\S]*?<\/script>/gi, " ")
            .replace(/<style[\s\S]*?<\/style>/gi, " ")
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 8000);
          return ok({
            url: page.url(),
            title: await page.title(),
            text,
          });
        }
        case "click": {
          await page.click(req.selector);
          return ok({ clicked: req.selector, url: page.url() });
        }
        case "fill": {
          await page.click(req.selector, { clickCount: 3 });
          await page.keyboard.press("Backspace");
          await page.type(req.selector, req.value);
          return ok({ filled: req.selector, url: page.url() });
        }
        default: {
          req satisfies never;
          return err("Unknown browser action.");
        }
      }
    } catch (thrown) {
      return err(thrown instanceof Error ? thrown.message : String(thrown));
    } finally {
      if (browser) {
        browser.disconnect();
      }
    }
  };
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

export function createBrowserExtension(
  store: BrowserStore,
  executeAction: BrowserExecutor,
  onTakeoverRequested: (record: BrowserTakeoverRecord) => void,
): Extension {
  const navigateTool: ToolRegistration<typeof NavigateSchema> = {
    name: "browser_navigate",
    description: "Navigate the cloud browser session to a URL.",
    parameters: NavigateSchema,
    replay: "safe",
    execute: async ({ url }, api) =>
      toToolResult(
        await executeAction({
          action: "navigate",
          conversationId: String(api.conversationId),
          url,
        }),
      ),
  };

  const snapshotTool: ToolRegistration<typeof SnapshotSchema> = {
    name: "browser_snapshot",
    description:
      "Capture a structured text snapshot of the current browser page.",
    parameters: SnapshotSchema,
    replay: "safe",
    execute: async ({ selector }, api) =>
      toToolResult(
        await executeAction({
          action: "snapshot",
          conversationId: String(api.conversationId),
          selector,
        }),
      ),
  };

  const clickTool: ToolRegistration<typeof ClickSchema> = {
    name: "browser_click",
    description: "Click an element on the current browser page by selector.",
    parameters: ClickSchema,
    replay: "unsafe",
    execute: async ({ selector }, api) =>
      toToolResult(
        await executeAction({
          action: "click",
          conversationId: String(api.conversationId),
          selector,
        }),
      ),
  };

  const fillTool: ToolRegistration<typeof FillSchema> = {
    name: "browser_fill",
    description: "Fill an input field on the current browser page.",
    parameters: FillSchema,
    replay: "unsafe",
    execute: async ({ selector, value }, api) =>
      toToolResult(
        await executeAction({
          action: "fill",
          conversationId: String(api.conversationId),
          selector,
          value,
        }),
      ),
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
        conversationId: Number(api.conversationId),
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
