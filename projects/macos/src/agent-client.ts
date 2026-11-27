import { err, ok, type Result } from "@pi-in-the-sky/result-monad";

import type {
  ApprovalItem,
  ChatMessage,
  ConnectionConfig,
  ConnectionState,
  IncomingSocketMessage,
  MemoryNote,
  ProfileEntry,
  TakeoverItem,
} from "./types";

type ClientHandlers = {
  readonly onConnectionChange: (state: ConnectionState) => void;
  readonly onMessagesChange: (messages: ChatMessage[]) => void;
  readonly onApprovalRequested: (approval: ApprovalItem) => void;
  readonly onTakeoverRequested: (takeover: TakeoverItem) => void;
  readonly onError: (message: string) => void;
};

function extractMessagesFromEntries(entries: unknown[]): ChatMessage[] {
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
  return result;
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

function makeWsUrl(config: ConnectionConfig): string {
  const cleanBase = config.baseUrl.replace(/\/$/, "");
  const wsBase = cleanBase.replace(/^http/, "ws");
  const tokenQuery = config.authToken
    ? `?token=${encodeURIComponent(config.authToken)}`
    : "";
  return `${wsBase}/api/agents/${encodeURIComponent(config.agentId)}/ws${tokenQuery}`;
}

async function requestJson<T>(
  config: ConnectionConfig,
  path: string,
  init?: RequestInit,
): Promise<Result<T, string>> {
  try {
    const cleanBase = config.baseUrl.replace(/\/$/, "");
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
    this.disconnect();
    this.connect();
  }

  connect(): void {
    this.disconnect();
    this.#handlers.onConnectionChange("connecting");
    const socket = new WebSocket(makeWsUrl(this.#config));
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

  submitPrompt(input: string): void {
    const trimmed = input.trim();
    if (!trimmed) {
      return;
    }
    const operationId = this.#nextId("op");
    this.#messages = [
      ...this.#messages,
      { id: operationId, role: "user", text: trimmed },
    ];
    this.#handlers.onMessagesChange(this.#messages);
    this.#send({
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

  #send(payload: Record<string, unknown>): void {
    if (!this.#socket || this.#socket.readyState !== 1) {
      this.#handlers.onError("Not connected to agent.");
      return;
    }
    this.#socket.send(JSON.stringify(payload));
  }

  #handleIncoming(message: IncomingSocketMessage): void {
    switch (message.type) {
      case "hello":
      case "result":
        return;
      case "view": {
        const entries = message.view.entries ?? [];
        const extracted = extractMessagesFromEntries(entries);
        if (extracted.length > 0) {
          this.#messages = extracted;
          this.#handlers.onMessagesChange(this.#messages);
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
