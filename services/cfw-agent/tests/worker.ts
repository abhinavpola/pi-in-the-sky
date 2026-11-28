import { createModels, type MutableModels } from "@earendil-works/pi-ai/models";
import { ok } from "@pi-in-the-sky/result-monad";
import type { PiModel } from "agents/harness/pi";

import type { BrowserExecutor, LiveViewUrlResolver } from "../src/browser";
import type { HttpFetcher } from "../src/http-tool";
import worker, { PersonalAgent } from "../src/index";
import {
  createStubProvider,
  type ScriptedTurn,
  STUB_MODEL,
} from "./stub-provider";

const scriptedQueues = new Map<string, ScriptedTurn[]>();

export class TestPersonalAgent extends PersonalAgent {
  #scriptKey = "default";
  readonly #pageUrls = new Map<string, string>();

  setScript(key: string, turns: ScriptedTurn[]): void {
    this.#scriptKey = key;
    scriptedQueues.set(key, [...turns]);
  }

  async listSchedules(): Promise<
    readonly { readonly id: string; readonly type: string }[]
  > {
    const items = await this.schedules.list();
    return items.map((item) => ({ id: item.id, type: item.type }));
  }

  async cancelSchedule(id: string): Promise<boolean> {
    return this.schedules.cancel(id);
  }

  async runExtensionModule(
    path: string,
    facet?: string,
    className?: string,
  ): Promise<{ readonly ok: boolean; readonly outputJson: string }> {
    const result = await this.extensionsRuntime.runModule({
      path,
      facet,
      className,
    });
    return { ok: result.ok, outputJson: JSON.stringify(result.output) };
  }

  protected override createModelRegistry(): { models: MutableModels } {
    const models = createModels();
    models.setProvider(
      createStubProvider(() => {
        const queue = scriptedQueues.get(this.#scriptKey) ?? [];
        const next = queue.shift();
        if (!next) {
          return { text: "Done." };
        }
        return next;
      }),
    );
    return { models };
  }

  protected override resolveDefaultModel(): PiModel {
    return STUB_MODEL;
  }

  protected override createBrowserExecutor(): BrowserExecutor {
    return async (req) => {
      switch (req.action) {
        case "navigate":
          this.#pageUrls.set(req.conversationId, req.url);
          return ok({
            ok: true,
            title: "ANA Flights - SFO to NRT",
            url: req.url,
          });
        case "snapshot":
          return ok({
            ok: true,
            text: "ANA NH7 nonstop SFO -> NRT Oct 12-20, 2026. Economy Window: $1,120 total.",
          });
        case "click":
          return ok({ clicked: req.selector });
        case "fill":
          return ok({ filled: req.selector });
        case "current_page":
          return ok({
            url: this.#pageUrls.get(req.conversationId) ?? "about:blank",
            sessionId: `test-session-${req.conversationId}`,
          });
        default: {
          req satisfies never;
          return ok({});
        }
      }
    };
  }

  protected override createLiveViewUrlResolver(): LiveViewUrlResolver {
    return ({ token }) => `https://live.browser.test/takeover/${token}`;
  }

  protected override createFetcher(): HttpFetcher {
    return async (input) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;

      if (
        url.startsWith(
          "https://gmail.googleapis.com/gmail/v1/users/me/messages?",
        )
      ) {
        return Response.json({
          messages: [{ id: "msg-tokyo-2025", threadId: "thread-tokyo-2025" }],
        });
      }

      if (
        url ===
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/msg-tokyo-2025"
      ) {
        return Response.json({
          id: "msg-tokyo-2025",
          snippet:
            "ANA NH7 SFO -> NRT, Oct 10-18, 2025, Window seat 14A, Park Hyatt Tokyo.",
          payload: {
            headers: [
              {
                name: "Subject",
                value: "ANA Flight Confirmation - SFO to NRT",
              },
              { name: "From", value: "confirmations@ana.co.jp" },
            ],
          },
        });
      }

      if (
        url.startsWith(
          "https://www.googleapis.com/calendar/v3/calendars/primary/events?",
        )
      ) {
        return Response.json({
          items: [
            {
              summary: "Q4 Planning",
              start: { dateTime: "2026-10-08T10:00:00Z" },
              end: { dateTime: "2026-10-08T11:00:00Z" },
            },
          ],
        });
      }

      return new Response(`Unhandled test URL: ${url}`, { status: 404 });
    };
  }
}

export default worker;
