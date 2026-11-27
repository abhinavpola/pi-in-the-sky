import { createModels, type MutableModels } from "@earendil-works/pi-ai/models";
import type { PiModel } from "agents/harness/pi";

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

  setScript(key: string, turns: ScriptedTurn[]): void {
    this.#scriptKey = key;
    scriptedQueues.set(key, [...turns]);
  }

  dumpRawSqliteText(): string {
    const tables = this.ctx.storage.sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
      )
      .toArray();
    const chunks: string[] = [];
    for (const table of tables) {
      const rows = this.ctx.storage.sql
        .exec(`SELECT * FROM "${table.name}"`)
        .toArray();
      chunks.push(`${table.name}:${JSON.stringify(rows)}`);
    }
    return chunks.join("\n");
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

  protected override resolveBrowserBinding(): Pick<Fetcher, "fetch"> {
    const fetcher = this.createFetcher();
    return {
      fetch: (input: RequestInfo | URL, init?: RequestInit) =>
        fetcher(input, init),
    };
  }

  protected override createFetcher(): HttpFetcher {
    return async (input, init) => {
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

      if (url === "https://browser.internal/navigate") {
        const body = typeof init?.body === "string" ? init.body : "{}";
        return Response.json({
          ok: true,
          title: "ANA Flights - SFO to NRT",
          echo: JSON.parse(body),
        });
      }

      if (url === "https://browser.internal/snapshot") {
        return Response.json({
          ok: true,
          text: "ANA NH7 nonstop SFO -> NRT Oct 12-20, 2026. Economy Window: $1,120 total.",
        });
      }

      return new Response(`Unhandled test URL: ${url}`, { status: 404 });
    };
  }
}

export default worker;
