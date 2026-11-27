import type { Op } from "@earendil-works/chord/delta";
import type { JsonValue } from "@earendil-works/pi-ai";
import type {
  ConversationView,
  Cursor,
  EntryId,
  EntryQuery,
  EntryRecord,
  Page,
  UserInput,
} from "@earendil-works/pi-durable";
import type { PiSessionId, PiWhenBusy } from "agents/harness/pi";

import type { ApprovalRecord } from "./approvals";
import type { BrowserTakeoverRecord } from "./browser";

type ToolInfo = {
  readonly name: string;
  readonly description: string;
};

type EntriesPage = Page<EntryRecord, Cursor>;

export type CommandResult = JsonValue | EntriesPage;

export type ClientMessage =
  | {
      readonly type: "submit";
      readonly id?: string;
      readonly input: UserInput;
      readonly whenBusy?: PiWhenBusy;
      readonly operationId?: string;
    }
  | { readonly type: "abort"; readonly id?: string }
  | { readonly type: "reset"; readonly id?: string; readonly handoff?: string }
  | { readonly type: "watch"; readonly id?: string; readonly from?: EntryId }
  | {
      readonly type: "entries";
      readonly id: string;
      readonly query: Omit<EntryQuery, "conversationId">;
      readonly limit: number;
    }
  | {
      readonly type: "resolve_approval";
      readonly id?: string;
      readonly approvalId: string;
      readonly approved: boolean;
      readonly note?: string;
    }
  | {
      readonly type: "resume_takeover";
      readonly id?: string;
      readonly takeoverId: string;
      readonly note?: string;
    };

export type ServerMessage =
  | {
      readonly type: "hello";
      readonly session: PiSessionId;
      readonly tools: readonly ToolInfo[];
    }
  | {
      readonly type: "view";
      readonly session: PiSessionId;
      readonly view: ConversationView;
    }
  | {
      readonly type: "ops";
      readonly session: PiSessionId;
      readonly ops: readonly Op[];
    }
  | {
      readonly type: "approval_requested";
      readonly approval: ApprovalRecord;
    }
  | {
      readonly type: "takeover_requested";
      readonly takeover: BrowserTakeoverRecord;
    }
  | {
      readonly type: "result";
      readonly id: string;
      readonly result: CommandResult;
    }
  | { readonly type: "error"; readonly id?: string; readonly message: string };
