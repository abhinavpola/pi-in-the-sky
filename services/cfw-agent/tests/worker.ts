import { createModels, type MutableModels } from "@earendil-works/pi-ai/models";
import type { PiModel } from "agents/harness/pi";

import type { Env } from "../env";
import { PersonalAgent } from "../src/agent";
import worker from "../src/index";
import {
  createStubProvider,
  type ScriptedTurn,
  STUB_MODEL,
} from "./stub-provider";

export class TestPersonalAgent extends PersonalAgent {
  #scriptedTurns: ScriptedTurn[] = [];
  #observedToolOutputs: string[] = [];

  setScriptedTurns(turns: ScriptedTurn[]): void {
    this.#scriptedTurns = [...turns];
    this.#observedToolOutputs = [];
  }

  getObservedToolOutputs(): string[] {
    return [...this.#observedToolOutputs];
  }

  protected override createModelRegistry(): { models: MutableModels } {
    const models = createModels();
    models.setProvider(
      createStubProvider((context) => {
        const lastMessage = context.messages.at(-1);
        if (lastMessage && lastMessage.role === "toolResult") {
          for (const part of lastMessage.content) {
            if (part.type === "text") {
              this.#observedToolOutputs.push(part.text);
            }
          }
        }
        const next = this.#scriptedTurns.shift();
        if (!next) {
          return { text: "No scripted turns remaining." };
        }
        return next;
      }),
    );
    return { models };
  }

  protected override resolveDefaultModel(): PiModel {
    return { provider: STUB_MODEL.provider, id: STUB_MODEL.id };
  }

  protected override createFetcher(): typeof fetch {
    const stubFetch = async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url,
      );

      if (
        url.origin === "https://gmail.googleapis.com" &&
        url.pathname === "/gmail/v1/users/me/messages"
      ) {
        return Response.json({ messages: [{ id: "msg-tokyo-2025" }] });
      }

      if (
        url.origin === "https://gmail.googleapis.com" &&
        url.pathname === "/gmail/v1/users/me/messages/msg-tokyo-2025"
      ) {
        return Response.json({
          id: "msg-tokyo-2025",
          snippet: "ANA NH7 SFO -> NRT, Oct 12-19, Window seat 14A, $940",
        });
      }

      if (
        url.origin === "https://www.googleapis.com" &&
        url.pathname === "/calendar/v3/calendars/primary/events"
      ) {
        return Response.json({ items: [] });
      }

      if (
        url.origin === "https://browser.example.test" &&
        url.pathname === "/navigate"
      ) {
        return Response.json({
          url: "https://flights.example/search?from=SFO&to=NRT",
          title: "SFO to NRT Flights",
        });
      }

      if (
        url.origin === "https://browser.example.test" &&
        url.pathname === "/snapshot"
      ) {
        return Response.json({
          text: "ANA NH7 Nonstop SFO->NRT Dec 12-19 Window 14A Total $980",
        });
      }

      return Response.json(
        { error: `Unexpected external URL: ${url.toString()}` },
        { status: 404 },
      );
    };

    return stubFetch as typeof fetch;
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return worker.fetch(request, env);
  },
};
