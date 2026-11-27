import type { JsonValue } from "@earendil-works/chord/json";
import type {
  ConversationView,
  Cursor,
  EntryRecord,
  Page,
} from "@earendil-works/pi-durable";
import type { PiSessionId } from "agents/harness/pi";
import { z } from "zod";

import type { ActivityRecord } from "./activities";
import type { BrowserTakeoverRecord } from "./browser";

type ToolInfo = {
  readonly name: string;
  readonly description: string;
};

type EntriesPage = Page<EntryRecord, Cursor>;

export type CommandResult = JsonValue | EntriesPage;

const PiWhenBusySchema = z.enum(["steer", "followUp", "reject"]);

const EntryQuerySchema = z.object({
  order: z.enum(["ascending", "descending"]).optional(),
});

export const ClientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("submit"),
    id: z.string(),
    input: z.string(),
    operationId: z.string().optional(),
    whenBusy: PiWhenBusySchema.optional(),
  }),
  z.object({
    type: z.literal("abort"),
    id: z.string(),
  }),
  z.object({
    type: z.literal("reset"),
    id: z.string(),
    handoff: z.string().optional(),
  }),
  z.object({
    type: z.literal("compact"),
    id: z.string(),
    summary: z.string().min(1),
  }),
  z.object({
    type: z.literal("watch"),
    id: z.string(),
  }),
  z.object({
    type: z.literal("entries"),
    id: z.string(),
    query: EntryQuerySchema.optional(),
    limit: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("resume_takeover"),
    id: z.string(),
    takeoverId: z.string(),
    note: z.string().optional(),
  }),
  z.object({
    type: z.literal("steer_activity"),
    id: z.string(),
    activityId: z.string(),
    instruction: z.string().min(1),
  }),
  z.object({
    type: z.literal("toggle_activity"),
    id: z.string(),
    activityId: z.string(),
    collapsed: z.boolean(),
  }),
]);

export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export type ServerMessage =
  | {
      readonly type: "hello";
      readonly session: PiSessionId;
      readonly tools: readonly ToolInfo[];
      readonly activities: readonly ActivityRecord[];
    }
  | { readonly type: "view"; readonly view: ConversationView }
  | { readonly type: "ops"; readonly ops: unknown }
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
