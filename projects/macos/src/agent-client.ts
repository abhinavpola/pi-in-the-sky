import { err, ok, type Result } from "@pi-in-the-sky/result-monad";

import type {
  ApprovalItem,
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
  readonly onApprovalRequested: (approval: ApprovalItem) => void;
  readonly onTakeoverRequested: (takeover: TakeoverItem) => void;
  readonly onReset: () => void;
  readonly onError: (message: string) => void;
};

function extractMessagesFromView(view: IncomingView): {
  readonly messages: ChatMessage[];
  readonly liveError: string | null;
} {
  const entries = view.entries ?? [];
  const result: ChatMessage[] = [];
  for (const raw of entries) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const entry = raw as { id?: number | string; model?: unknown[] };
    const modelParts = Array.isArray(entry.model) ? entry.model : [];
    for (const part of modelParts) {
      if (!part || typeof part !== "object") {
        continue;
      }
      const record = part as { role?: string; content?: unknown };
      if (record.role !== "user" && record.role !== "assistant") {
        continue;
      }
      const text = extractTextContent(record.content);
      if (text) {
        result.push({
          id: `${String(entry.id ?? result.length)}-${record.role}`,
          role: record.role,
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

function extractTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((item) => {
      if (
        item &&
        typeof item === "object" &&
        "type" in item &&
        (item as { type: unknown }).type === "text" &&
        "text" in item
      ) {
        return String((item as { text: unknown }).text);
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

type ReactNativeWebSocketConstructor = new (
  url: string,
  protocols?: string | string[] | null,
  options?: { readonly headers?: Record<string, string> },
) => WebSocket;

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
    return ok((text ? JSON.parse(text) : {}) as T);
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
    const WebSocketWithHeaders =
      WebSocket as unknown as ReactNativeWebSocketConstructor;
    const headers: Record<string, string> = {};
    if (this.#config.authToken) {
      headers.Authorization = `Bearer ${this.#config.authToken}`;
    }
    const socket = new WebSocketWithHeaders(makeWsUrl(this.#config), null, {
      headers,
    });
    this.#socket = socket;

    socket.onopen = () => {
      this.#handlers.onConnectionChange("connected");
      this.#send({ type: "watch", id: this.#nextId("watch") });
    };

    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(String(event.data)) as IncomingSocketMessage;
        this.#handleIncoming(message);
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

  resolveApproval(approvalId: string, approved: boolean, note?: string): void {
    this.#send({
      type: "resolve_approval",
      id: this.#nextId("approval"),
      approvalId,
      approved,
      note,
    });
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
    return requestJson<{ entries: ProfileEntry[] }>(this.#config, "/profile");
  }

  setProfileEntry(
    key: string,
    value: string,
  ): Promise<Result<ProfileEntry, string>> {
    return requestJson<ProfileEntry>(this.#config, "/profile", {
      method: "PUT",
      body: JSON.stringify({ key, value }),
    });
  }

  searchNotes(query: string): Promise<Result<{ notes: MemoryNote[] }, string>> {
    const encoded = encodeURIComponent(query);
    return requestJson<{ notes: MemoryNote[] }>(
      this.#config,
      `/notes?q=${encoded}`,
    );
  }

  addNote(
    content: string,
    category = "general",
  ): Promise<Result<MemoryNote, string>> {
    return requestJson<MemoryNote>(this.#config, "/notes", {
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
      case "approval_requested": {
        this.#handlers.onApprovalRequested(message.approval);
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
