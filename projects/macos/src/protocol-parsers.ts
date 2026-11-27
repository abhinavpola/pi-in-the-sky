import type {
  ActivityItem,
  ActivityStatus,
  ChatMessage,
  IncomingSocketMessage,
  IncomingView,
  MemoryNote,
  ProfileEntry,
  TakeoverItem,
} from "./types";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function readNumber(
  record: Record<string, unknown>,
  key: string,
): number | null {
  const value = record[key];
  return typeof value === "number" ? value : null;
}

function parseActivityStatus(value: unknown): ActivityStatus | null {
  switch (value) {
    case "running":
    case "waiting_input":
    case "completed":
    case "failed":
    case "cancelled":
      return value;
    default:
      return null;
  }
}

function parseActivity(raw: unknown): ActivityItem | null {
  if (!isRecord(raw)) {
    return null;
  }
  const id = readString(raw, "id");
  const sessionId = readString(raw, "sessionId");
  const title = readString(raw, "title");
  const summary = readString(raw, "summary");
  const status = parseActivityStatus(raw.status);
  const collapsed = typeof raw.collapsed === "boolean" ? raw.collapsed : null;
  const createdAt = readNumber(raw, "createdAt");
  const updatedAt = readNumber(raw, "updatedAt");
  if (
    !id ||
    !sessionId ||
    title === null ||
    summary === null ||
    !status ||
    collapsed === null ||
    createdAt === null ||
    updatedAt === null
  ) {
    return null;
  }
  return {
    id,
    sessionId,
    title,
    summary,
    status,
    collapsed,
    createdAt,
    updatedAt,
  };
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const item of content) {
    if (
      isRecord(item) &&
      item.type === "text" &&
      typeof item.text === "string"
    ) {
      parts.push(item.text);
    }
  }
  return parts.join("\n");
}

function parseIncomingView(raw: unknown): IncomingView {
  if (!isRecord(raw)) {
    return {};
  }
  const entries = Array.isArray(raw.entries) ? raw.entries : undefined;
  if (!isRecord(raw.pi) || !isRecord(raw.pi.live)) {
    return { entries };
  }
  const liveRaw = raw.pi.live;
  const message = isRecord(liveRaw.message)
    ? { content: liveRaw.message.content }
    : undefined;
  const error = typeof liveRaw.error === "string" ? liveRaw.error : undefined;
  return {
    entries,
    pi: { live: { message, error } },
  };
}

function parseTakeover(raw: unknown): TakeoverItem | null {
  if (!isRecord(raw)) {
    return null;
  }
  const id = readString(raw, "id");
  const url = readString(raw, "url");
  const reason = readString(raw, "reason");
  const status = raw.status;
  if (
    !id ||
    !url ||
    !reason ||
    (status !== "waiting" && status !== "resumed")
  ) {
    return null;
  }
  const liveViewUrl =
    typeof raw.liveViewUrl === "string" ? raw.liveViewUrl : null;
  return { id, url, liveViewUrl, reason, status };
}

export function parseIncomingSocketMessage(
  raw: unknown,
): IncomingSocketMessage | null {
  if (!isRecord(raw) || typeof raw.type !== "string") {
    return null;
  }
  switch (raw.type) {
    case "hello": {
      const activities = Array.isArray(raw.activities)
        ? raw.activities
            .map(parseActivity)
            .filter((item): item is ActivityItem => item !== null)
        : [];
      return { type: "hello", activities };
    }
    case "result":
      return { type: "result" };
    case "ops":
      return { type: "ops" };
    case "view":
      return { type: "view", view: parseIncomingView(raw.view) };
    case "takeover_requested": {
      const takeover = parseTakeover(raw.takeover);
      return takeover ? { type: "takeover_requested", takeover } : null;
    }
    case "activity_updated": {
      const activity = parseActivity(raw.activity);
      return activity ? { type: "activity_updated", activity } : null;
    }
    case "error":
      return {
        type: "error",
        message: readString(raw, "message") ?? "Unknown agent error",
      };
    default:
      return null;
  }
}

export function parseProfileEntry(raw: unknown): ProfileEntry | null {
  if (!isRecord(raw)) {
    return null;
  }
  const key = readString(raw, "key");
  const value = readString(raw, "value");
  const updatedAt = readNumber(raw, "updatedAt");
  if (!key || value === null || updatedAt === null) {
    return null;
  }
  return { key, value, updatedAt };
}

export function parseMemoryNote(raw: unknown): MemoryNote | null {
  if (!isRecord(raw)) {
    return null;
  }
  const id = readNumber(raw, "id");
  const date = readString(raw, "date");
  const category = readString(raw, "category");
  const content = readString(raw, "content");
  const createdAt = readNumber(raw, "createdAt");
  if (
    id === null ||
    date === null ||
    category === null ||
    content === null ||
    createdAt === null
  ) {
    return null;
  }
  return { id, date, category, content, createdAt };
}

export function extractMessagesFromView(view: IncomingView): {
  readonly messages: ChatMessage[];
  readonly liveError: string | null;
} {
  const entries = view.entries ?? [];
  const result: ChatMessage[] = [];
  for (const raw of entries) {
    if (!isRecord(raw) || !Array.isArray(raw.model)) {
      continue;
    }
    const entryId =
      typeof raw.id === "number" || typeof raw.id === "string"
        ? String(raw.id)
        : String(result.length);
    for (const part of raw.model) {
      if (!isRecord(part)) {
        continue;
      }
      if (part.role !== "user" && part.role !== "assistant") {
        continue;
      }
      const text = extractTextContent(part.content);
      if (text) {
        result.push({
          id: `${entryId}-${part.role}`,
          role: part.role,
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
  const liveError =
    typeof live?.error === "string" && live.error.length > 0
      ? live.error
      : null;
  return { messages: result, liveError };
}
