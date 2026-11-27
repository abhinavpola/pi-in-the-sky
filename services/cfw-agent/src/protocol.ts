import type { JsonValue } from "@earendil-works/chord/json";
import type {
  ConversationView,
  Cursor,
  EntryRecord,
  Page,
} from "@earendil-works/pi-durable";
import type { ActivityRecord } from "@pi-in-the-sky/client/protocol";
import type { PiSessionId } from "agents/harness/pi";

import type { BrowserTakeoverRecord } from "./browser";

type ToolInfo = {
  readonly name: string;
  readonly description: string;
};

type EntriesPage = Page<EntryRecord, Cursor>;

export type CommandResult = JsonValue | EntriesPage;

export type ServerMessage =
  | {
      readonly type: "hello";
      readonly session: PiSessionId;
      readonly tools: readonly ToolInfo[];
      readonly activities: readonly ActivityRecord[];
    }
  | { readonly type: "view"; readonly view: ConversationView }
  | {
      readonly type: "takeover_requested";
      readonly takeover: BrowserTakeoverRecord;
    }
  | {
      readonly type: "activity_updated";
      readonly activity: ActivityRecord;
    }
  | { readonly type: "result"; readonly id: string; readonly result: unknown }
  | { readonly type: "error"; readonly id?: string; readonly message: string };
