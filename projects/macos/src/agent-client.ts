import { err, ok, type Result } from "@pi-in-the-sky/result-monad";

import type {
  ChatMessage,
  ConnectionConfig,
  ConnectionState,
  IncomingSocketMessage,
  IncomingView,
  MemoryNote,
  ProfileEntry,
  TakeoverItem,
} from "./types";

type ClientHandlers = {
  readonly onConnectionChange: (state: ConnectionState) => void;
  readonly onMessagesChange: (messages: ChatMessage[]) => void;
  readonly onTakeoverRequested: (takeover: TakeoverItem) => void;
  readonly onReset: () => void;
  readonly onError: (message: string) => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
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

function parseIncomingSocketMessage(
  raw: unknown,
): IncomingSocketMessage | null {
  if (!isRecord(raw) || typeof raw.type !== "string") {
    return null;
  }
  switch (raw.type) {
    case "hello":
      return { type: "hello" };
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
    case "error":
      return {
        type: "error",
        message: readString(raw, "message") ?? "Unknown agent error",
      };
    default:
      return null;
  }
}

function parseProfileEntry(raw: unknown): ProfileEntry | null {
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

function parseMemoryNote(raw: unknown): MemoryNote | null {
  if (!isRecord(raw)) {
    return null;
  }
  const id = readNumber(raw, "id");
  const date = readString(raw, "date");
  const category = readString(raw, "category");
  const content = readString(raw, "content");
  const createdAt = readNumber(raw, "createdAt");
  if (id === null || !date || !category || !content || createdAt === null) {
    return null;
  }
  return { id, date, category, content, createdAt };
}

function extractMessagesFromView(view: IncomingView): {
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

const BASE_URL_PATTERN =
  /^(https?):\/\/(\[[^\]]+\]|[^/:?#]+)(?::\d+)?(\/.*)?$/i;

export function validateBaseUrl(baseUrl: string): Result<string, string> {
  const trimmed = baseUrl.trim().replace(/\/$/, "");
  const match = BASE_URL_PATTERN.exec(trimmed);
  if (!match?.[1] || !match[2]) {
    return err("Server URL must use https:// (or http:// for localhost).");
  }
  const scheme = match[1].toLowerCase();
  const host = match[2].toLowerCase();
  const isLoopback =
    host === "127.0.0.1" ||
    host === "localhost" ||
    host === "::1" ||
    host === "[::1]";
  switch (scheme) {
    case "https":
      return ok(trimmed);
    case "http":
      if (isLoopback) {
        return ok(trimmed);
      }
      return err("Remote connections must use https://.");
    default:
      return err("Server URL must use https:// (or http:// for localhost).");
  }
}

function makeWsUrl(config: ConnectionConfig): string {
  const cleanBase = config.baseUrl.replace(/\/$/, "");
  const wsBase = cleanBase.replace(/^http/, "ws");
  return `${wsBase}/api/agents/${encodeURIComponent(config.agentId)}/ws`;
}

async function requestJson<T>(
  config: ConnectionConfig,
  path: string,
  parse: (data: unknown) => T | null,
  init?: RequestInit,
): Promise<Result<T, string>> {
  const validated = validateBaseUrl(config.baseUrl);
  if (!validated.ok) {
    return validated;
  }
  try {
    const cleanBase = validated.value;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (config.authToken) {
      headers.Authorization = `Bearer ${config.authToken}`;
    }
    const response = await fetch(
      `${cleanBase}/api/agents/${encodeURIComponent(config.agentId)}${path}`,
      {
        ...init,
        headers,
      },
    );
    const text = await response.text();
    if (!response.ok) {
      return err(`HTTP ${response.status}: ${text}`);
    }
    const raw: unknown = text ? JSON.parse(text) : {};
    const parsed = parse(raw);
    if (parsed === null) {
      return err("Unexpected response shape from agent.");
    }
    return ok(parsed);
  } catch (thrown) {
    return err(thrown instanceof Error ? thrown.message : String(thrown));
  }
}

export class AgentClient {
  #config: ConnectionConfig;
  readonly #handlers: ClientHandlers;
  #socket: WebSocket | null = null;
  #messages: ChatMessage[] = [];
  #commandSeq = 0;

  constructor(config: ConnectionConfig, handlers: ClientHandlers) {
    this.#config = config;
    this.#handlers = handlers;
  }

  updateConfig(config: ConnectionConfig): void {
    this.#config = config;
    this.#messages = [];
    this.#handlers.onMessagesChange([]);
    this.#handlers.onReset();
    this.disconnect();
    this.connect();
  }

  connect(): void {
    this.disconnect();
    const validated = validateBaseUrl(this.#config.baseUrl);
    if (!validated.ok) {
      this.#handlers.onError(validated.error);
      return;
    }
    this.#handlers.onConnectionChange("connecting");
    const headers: Record<string, string> = {};
    if (this.#config.authToken) {
      headers.Authorization = `Bearer ${this.#config.authToken}`;
    }
    const socket = new WebSocket(makeWsUrl(this.#config), null, { headers });
    this.#socket = socket;

    socket.onopen = () => {
      this.#handlers.onConnectionChange("connected");
      this.#send({ type: "watch", id: this.#nextId("watch") });
    };

    socket.onmessage = (event) => {
      try {
        const parsed = parseIncomingSocketMessage(
          JSON.parse(String(event.data)),
        );
        if (parsed) {
          this.#handleIncoming(parsed);
        }
      } catch {
        this.#handlers.onError("Received invalid JSON from agent.");
      }
    };

    socket.onerror = () => {
      this.#handlers.onError("WebSocket connection error.");
    };

    socket.onclose = () => {
      if (this.#socket === socket) {
        this.#socket = null;
        this.#handlers.onConnectionChange("disconnected");
      }
    };
  }

  disconnect(): void {
    if (this.#socket) {
      this.#socket.close();
      this.#socket = null;
    }
    this.#handlers.onConnectionChange("disconnected");
  }

  submitPrompt(input: string): boolean {
    const trimmed = input.trim();
    if (!trimmed) {
      return false;
    }
    if (!this.#socket || this.#socket.readyState !== 1) {
      this.#handlers.onError("Not connected to agent.");
      return false;
    }
    const operationId = this.#nextId("op");
    this.#messages = [
      ...this.#messages,
      { id: operationId, role: "user", text: trimmed },
    ];
    this.#handlers.onMessagesChange(this.#messages);
    return this.#send({
      type: "submit",
      id: this.#nextId("sub"),
      operationId,
      input: trimmed,
    });
  }

  abort(): void {
    this.#send({ type: "abort", id: this.#nextId("abort") });
  }

  resumeTakeover(takeoverId: string, note?: string): void {
    this.#send({
      type: "resume_takeover",
      id: this.#nextId("takeover"),
      takeoverId,
      note,
    });
  }

  getProfile(): Promise<Result<{ entries: ProfileEntry[] }, string>> {
    return requestJson(this.#config, "/profile", (raw) => {
      if (!isRecord(raw) || !Array.isArray(raw.entries)) {
        return null;
      }
      const entries = raw.entries
        .map(parseProfileEntry)
        .filter((item): item is ProfileEntry => item !== null);
      return { entries };
    });
  }

  setProfileEntry(
    key: string,
    value: string,
  ): Promise<Result<ProfileEntry, string>> {
    return requestJson(this.#config, "/profile", parseProfileEntry, {
      method: "PUT",
      body: JSON.stringify({ key, value }),
    });
  }

  searchNotes(query: string): Promise<Result<{ notes: MemoryNote[] }, string>> {
    const encoded = encodeURIComponent(query);
    return requestJson(this.#config, `/notes?q=${encoded}`, (raw) => {
      if (!isRecord(raw) || !Array.isArray(raw.notes)) {
        return null;
      }
      const notes = raw.notes
        .map(parseMemoryNote)
        .filter((item): item is MemoryNote => item !== null);
      return { notes };
    });
  }

  addNote(
    content: string,
    category = "general",
  ): Promise<Result<MemoryNote, string>> {
    return requestJson(this.#config, "/notes", parseMemoryNote, {
      method: "POST",
      body: JSON.stringify({ content, category }),
    });
  }

  #nextId(prefix: string): string {
    this.#commandSeq += 1;
    return `${prefix}-${Date.now()}-${this.#commandSeq}`;
  }

  #send(payload: Record<string, unknown>): boolean {
    if (!this.#socket || this.#socket.readyState !== 1) {
      this.#handlers.onError("Not connected to agent.");
      return false;
    }
    this.#socket.send(JSON.stringify(payload));
    return true;
  }

  #handleIncoming(message: IncomingSocketMessage): void {
    switch (message.type) {
      case "hello":
      case "result":
        return;
      case "view": {
        const { messages, liveError } = extractMessagesFromView(message.view);
        this.#messages = messages;
        this.#handlers.onMessagesChange(this.#messages);
        if (liveError) {
          this.#handlers.onError(liveError);
        }
        return;
      }
      case "ops": {
        this.#send({ type: "watch", id: this.#nextId("resync") });
        return;
      }
      case "takeover_requested": {
        this.#handlers.onTakeoverRequested(message.takeover);
        return;
      }
      case "error": {
        this.#handlers.onError(message.message);
        return;
      }
      default: {
        message satisfies never;
      }
    }
  }
}
