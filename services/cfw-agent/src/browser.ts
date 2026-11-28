import puppeteer, {
  type Browser,
  type BrowserWorker,
  type Page,
} from "@cloudflare/puppeteer";
import {
  defineSignal,
  type Extension,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { bool, obj, opt, str } from "@earendil-works/pi-schema";
import {
  isSafeLiveViewUrl,
  parseTakeoverTarget,
} from "@pi-in-the-sky/client/protocol";
import { err, ok, type Result } from "@pi-in-the-sky/result-monad";

import type { BrowserStore, BrowserTakeoverRecord } from "./browser-store";
import { errorToolResult, toToolResult } from "./http-tool";

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
  readonly pinnedOrigin: string;
};

export type LiveViewUrlResolver = (info: {
  readonly takeoverId: string;
  readonly token: string;
  readonly origin: string;
  readonly url: string;
}) => string | null;

function extractPageUrl(value: unknown): string | null {
  if (typeof value !== "object" || value === null || !("url" in value)) {
    return null;
  }
  return typeof value.url === "string" ? value.url : null;
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
    }
  | {
      readonly action: "current_page";
      readonly conversationId: string;
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
    if (req.action === "navigate" && !parseTakeoverTarget(req.url)) {
      return err("Only http:// and https:// URLs are allowed for navigation.");
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
        case "current_page": {
          return ok({ url: page.url(), sessionId: browser.sessionId() });
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
  reason: str(),
});

export function createBrowserExtension(
  store: BrowserStore,
  executeAction: BrowserExecutor,
  onTakeoverRequested: (record: BrowserTakeoverRecord) => void,
  resolveLiveViewUrl?: LiveViewUrlResolver,
): Extension {
  const ensureNotInTakeover = (
    conversationId: number,
  ): ToolExecutionResult | null => {
    if (store.hasWaitingTakeover(conversationId)) {
      return errorToolResult(
        "Browser automation is paused while user takeover is in progress.",
      );
    }
    return null;
  };

  const navigateTool: ToolRegistration<typeof NavigateSchema> = {
    name: "browser_navigate",
    description: "Navigate the cloud browser session to an http(s) URL.",
    parameters: NavigateSchema,
    replay: "safe",
    execute: async ({ url }, api) => {
      const blocked = ensureNotInTakeover(Number(api.conversationId));
      if (blocked) {
        return blocked;
      }
      if (!parseTakeoverTarget(url)) {
        return errorToolResult(
          "Only http:// and https:// URLs are allowed for navigation.",
        );
      }
      return toToolResult(
        await executeAction({
          action: "navigate",
          conversationId: String(api.conversationId),
          url,
        }),
      );
    },
  };

  const snapshotTool: ToolRegistration<typeof SnapshotSchema> = {
    name: "browser_snapshot",
    description:
      "Capture a structured text snapshot of the current browser page.",
    parameters: SnapshotSchema,
    replay: "safe",
    execute: async ({ selector }, api) => {
      const blocked = ensureNotInTakeover(Number(api.conversationId));
      if (blocked) {
        return blocked;
      }
      return toToolResult(
        await executeAction({
          action: "snapshot",
          conversationId: String(api.conversationId),
          selector,
        }),
      );
    },
  };

  const clickTool: ToolRegistration<typeof ClickSchema> = {
    name: "browser_click",
    description: "Click an element on the current browser page by selector.",
    parameters: ClickSchema,
    replay: "unsafe",
    execute: async ({ selector }, api) => {
      const blocked = ensureNotInTakeover(Number(api.conversationId));
      if (blocked) {
        return blocked;
      }
      return toToolResult(
        await executeAction({
          action: "click",
          conversationId: String(api.conversationId),
          selector,
        }),
      );
    },
  };

  const fillTool: ToolRegistration<typeof FillSchema> = {
    name: "browser_fill",
    description: "Fill an input field on the current browser page.",
    parameters: FillSchema,
    replay: "unsafe",
    execute: async ({ selector, value }, api) => {
      const blocked = ensureNotInTakeover(Number(api.conversationId));
      if (blocked) {
        return blocked;
      }
      return toToolResult(
        await executeAction({
          action: "fill",
          conversationId: String(api.conversationId),
          selector,
          value,
        }),
      );
    },
  };

  const requestTakeoverTool: ToolRegistration<
    typeof RequestTakeoverSchema,
    TakeoverCheckpoint,
    TakeoverCheckpoint
  > = {
    name: "browser_request_takeover",
    description:
      "Pause the agent and ask the user to take over the active browser page for login, MFA, CAPTCHA, or checkout. The host derives the URL and Live View link from the active browser session.",
    parameters: RequestTakeoverSchema,
    replay: "safe",
    async execute(args, api, context) {
      const conversationKey = String(api.conversationId);
      if (api.wake?.reason === "signal" && api.checkpoint) {
        const signal = await api.readSignal(
          BrowserTakeoverSignal,
          api.checkpoint.takeoverId,
          context,
        );
        if (signal?.kind === "value") {
          store.markResumed(api.checkpoint.takeoverId);
          const currentPage = await executeAction({
            action: "current_page",
            conversationId: conversationKey,
          });
          const postUrl = currentPage.ok
            ? extractPageUrl(currentPage.value)
            : null;
          const postTarget = postUrl ? parseTakeoverTarget(postUrl) : null;
          const originMismatch =
            postTarget !== null &&
            postTarget.origin !== api.checkpoint.pinnedOrigin;
          if (originMismatch) {
            store.clearSessionId(conversationKey);
          }
          return {
            output: [
              {
                type: "text",
                text: JSON.stringify({
                  takeoverId: api.checkpoint.takeoverId,
                  resumed: signal.value.resumed,
                  note: signal.value.note ?? null,
                  originMismatch,
                }),
              },
            ],
          };
        }
        store.markResumed(api.checkpoint.takeoverId);
        return {
          isError: true,
          output: [{ type: "text", text: "Browser takeover expired." }],
        };
      }
      const currentPage = await executeAction({
        action: "current_page",
        conversationId: conversationKey,
      });
      if (!currentPage.ok) {
        return {
          isError: true,
          output: [{ type: "text", text: currentPage.error }],
        };
      }
      const activeUrl = extractPageUrl(currentPage.value);
      const target = activeUrl ? parseTakeoverTarget(activeUrl) : null;
      if (!target) {
        return {
          isError: true,
          output: [
            {
              type: "text",
              text: "Cannot request takeover: navigate the browser to an http(s) page first.",
            },
          ],
        };
      }
      const takeoverId = api.callId;
      const { token, expiresAt } = await store.mintTakeoverToken(
        takeoverId,
        target.origin,
      );
      const candidateLiveViewUrl =
        resolveLiveViewUrl?.({
          takeoverId,
          token,
          origin: target.origin,
          url: target.url,
        }) ?? null;
      const liveViewUrl =
        candidateLiveViewUrl && isSafeLiveViewUrl(candidateLiveViewUrl)
          ? candidateLiveViewUrl
          : null;
      const record = store.createTakeover({
        id: takeoverId,
        taskId: api.taskId,
        conversationId: Number(api.conversationId),
        url: target.url,
        hostname: target.hostname,
        origin: target.origin,
        liveViewUrl,
        expiresAt,
        reason: args.reason,
      });
      onTakeoverRequested(record);
      return {
        kind: "sleep",
        checkpoint: { takeoverId, pinnedOrigin: target.origin },
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
