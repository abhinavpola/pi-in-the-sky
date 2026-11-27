import { z } from "zod";

export const ActivityStatusSchema = z.enum([
  "running",
  "waiting_input",
  "completed",
  "failed",
  "cancelled",
]);

export type ActivityStatus = z.infer<typeof ActivityStatusSchema>;

export const ActivityRecordSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  title: z.string(),
  summary: z.string(),
  status: ActivityStatusSchema,
  collapsed: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export type ActivityRecord = z.infer<typeof ActivityRecordSchema>;

export const TakeoverStatusSchema = z.enum(["waiting", "resumed"]);

export const TakeoverRecordSchema = z.object({
  id: z.string(),
  url: z.string(),
  liveViewUrl: z.string().nullable(),
  reason: z.string(),
  status: TakeoverStatusSchema,
});

export type TakeoverRecord = z.infer<typeof TakeoverRecordSchema>;

export const ProfileEntrySchema = z.object({
  key: z.string(),
  value: z.string(),
  updatedAt: z.number(),
});

export type ProfileEntry = z.infer<typeof ProfileEntrySchema>;

export const MemoryNoteSchema = z.object({
  id: z.number(),
  date: z.string(),
  category: z.string(),
  content: z.string(),
  createdAt: z.number(),
});

export type MemoryNote = z.infer<typeof MemoryNoteSchema>;

export const AuthConfigResponseSchema = z.object({
  provider: z.enum(["cloudflare_access_oauth", "none"]),
  teamDomain: z.string().nullable(),
  aud: z.string().nullable(),
  clientId: z.string().nullable(),
});

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

const TextBlockSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

const ContentSchema = z.union([z.string(), z.array(z.unknown())]);

const ModelPartSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: ContentSchema,
});

const ViewEntrySchema = z.object({
  id: z.union([z.number(), z.string()]).optional(),
  model: z.array(z.unknown()).optional(),
});

const IncomingViewSchema = z.object({
  entries: z.array(z.unknown()).optional(),
  pi: z
    .object({
      live: z
        .object({
          message: z.object({ content: ContentSchema.optional() }).optional(),
          error: z.string().optional(),
        })
        .nullable()
        .optional(),
    })
    .optional(),
});

export type IncomingView = z.infer<typeof IncomingViewSchema>;

export const IncomingSocketMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    activities: z.array(ActivityRecordSchema).default([]),
  }),
  z.object({
    type: z.literal("view"),
    view: IncomingViewSchema,
  }),
  z.object({
    type: z.literal("takeover_requested"),
    takeover: TakeoverRecordSchema,
  }),
  z.object({
    type: z.literal("activity_updated"),
    activity: ActivityRecordSchema,
  }),
  z.object({ type: z.literal("result") }),
  z.object({
    type: z.literal("error"),
    message: z.string().default("Unknown agent error"),
  }),
]);

export type IncomingSocketMessage = z.infer<typeof IncomingSocketMessageSchema>;

export type ChatMessage = {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
};

function extractTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const item of content) {
    const parsed = TextBlockSchema.safeParse(item);
    if (parsed.success) {
      parts.push(parsed.data.text);
    }
  }
  return parts.join("\n");
}

export function extractMessagesFromView(view: IncomingView): {
  readonly messages: ChatMessage[];
  readonly liveError: string | null;
} {
  const result: ChatMessage[] = [];
  for (const rawEntry of view.entries ?? []) {
    const entry = ViewEntrySchema.safeParse(rawEntry);
    if (!entry.success || !entry.data.model) {
      continue;
    }
    const entryId =
      entry.data.id !== undefined
        ? String(entry.data.id)
        : String(result.length);
    for (const rawPart of entry.data.model) {
      const part = ModelPartSchema.safeParse(rawPart);
      if (!part.success) {
        continue;
      }
      const text = extractTextContent(part.data.content);
      if (text) {
        result.push({
          id: `${entryId}-${part.data.role}`,
          role: part.data.role,
          text,
        });
      }
    }
  }
  const live = view.pi?.live;
  const liveText = extractTextContent(live?.message?.content);
  if (liveText) {
    result.push({
      id: "pi-live-assistant",
      role: "assistant",
      text: liveText,
    });
  }
  const liveError = live?.error && live.error.length > 0 ? live.error : null;
  return { messages: result, liveError };
}
