import { err, ok, type Result } from "@pi-in-the-sky/result-monad";
import { z } from "zod";

import {
  type ActivityRecord,
  type ChatMessage,
  type ClientMessage,
  extractMessagesFromView,
  type IncomingSocketMessage,
  IncomingSocketMessageSchema,
  type MemoryNote,
  MemoryNoteSchema,
  type ProfileEntry,
  ProfileEntrySchema,
  type TakeoverRecord,
} from "./protocol";

export type ConnectionState = "disconnected" | "connecting" | "connected";

export type ConnectionConfig = {
  readonly baseUrl: string;
  readonly agentId: string;
  readonly authToken: string;
  readonly refreshToken?: string;
  readonly accessTeamDomain?: string;
  readonly accessClientId?: string;
};

type ClientHandlers = {
  readonly onConnectionChange: (state: ConnectionState) => void;
  readonly onMessagesChange: (messages: ChatMessage[]) => void;
  readonly onActivitiesChange: (activities: ActivityRecord[]) => void;
  readonly onTakeoverRequested: (takeover: TakeoverRecord) => void;
  readonly onReset: () => void;
  readonly onError: (message: string) => void;
  readonly createSocket?: (
    url: string,
    headers: Record<string, string>,
  ) => WebSocket;
};

const ProfileListSchema = z.object({ entries: z.array(ProfileEntrySchema) });
const NotesListSchema = z.object({ notes: z.array(MemoryNoteSchema) });

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
      return isLoopback
        ? ok(trimmed)
        : err("Remote connections must use https://.");
    default:
      return err("Server URL must use https:// (or http:// for localhost).");
  }
}

function apiPrefix(config: ConnectionConfig): string {
  const customId = config.agentId.trim();
  if (!customId || customId === "me" || config.accessTeamDomain) {
    return "/api/me";
  }
  return `/api/agents/${encodeURIComponent(customId)}`;
}

async function requestJson<T>(
  config: ConnectionConfig,
  path: string,
  schema: z.ZodType<T>,
  init?: RequestInit,
): Promise<Result<T, string>> {
  const validated = validateBaseUrl(config.baseUrl);
  if (!validated.ok) {
    return validated;
  }
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (config.authToken) {
      headers.Authorization = `Bearer ${config.authToken}`;
    }
    const response = await fetch(
      `${validated.value}${apiPrefix(config)}${path}`,
      { ...init, headers },
    );
    const text = await response.text();
    if (!response.ok) {
      return err(`HTTP ${response.status}: ${text}`);
    }
    const parsed = schema.safeParse(text ? JSON.parse(text) : {});
    if (!parsed.success) {
      return err("Unexpected response shape from agent.");
    }
    return ok(parsed.data);
  } catch (thrown) {
    return err(thrown instanceof Error ? thrown.message : String(thrown));
  }
}

export class AgentClient {
  #config: ConnectionConfig;
  readonly #handlers: ClientHandlers;
  #socket: WebSocket | null = null;
  #messages: ChatMessage[] = [];
  #activities: ActivityRecord[] = [];
  #commandSeq = 0;

  constructor(config: ConnectionConfig, handlers: ClientHandlers) {
    this.#config = config;
    this.#handlers = handlers;
  }

  updateConfig(config: ConnectionConfig): void {
    this.#config = config;
    this.#messages = [];
    this.#activities = [];
    this.#handlers.onMessagesChange([]);
    this.#handlers.onActivitiesChange([]);
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
    const wsBase = validated.value.replace(/^http/, "ws");
    const wsUrl = `${wsBase}${apiPrefix(this.#config)}/ws`;
    const socket = this.#handlers.createSocket
      ? this.#handlers.createSocket(wsUrl, headers)
      : new WebSocket(wsUrl);
    this.#socket = socket;

    socket.onopen = () => {
      this.#handlers.onConnectionChange("connected");
      this.#send({ type: "watch", id: this.#nextId("watch") });
    };

    socket.onmessage = (event) => {
      try {
        const parsed = IncomingSocketMessageSchema.safeParse(
          JSON.parse(String(event.data)),
        );
        if (parsed.success) {
          this.#handleIncoming(parsed.data);
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

  steerActivity(activityId: string, instruction: string): boolean {
    const trimmed = instruction.trim();
    if (!trimmed) {
      return false;
    }
    return this.#send({
      type: "steer_activity",
      id: this.#nextId("steer"),
      activityId,
      instruction: trimmed,
    });
  }

  toggleActivity(activityId: string, collapsed: boolean): void {
    this.#send({
      type: "toggle_activity",
      id: this.#nextId("toggle"),
      activityId,
      collapsed,
    });
  }

  compactThread(summary: string): void {
    this.#send({ type: "compact", id: this.#nextId("compact"), summary });
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
    return requestJson(this.#config, "/profile", ProfileListSchema);
  }

  setProfileEntry(
    key: string,
    value: string,
  ): Promise<Result<ProfileEntry, string>> {
    return requestJson(this.#config, "/profile", ProfileEntrySchema, {
      method: "PUT",
      body: JSON.stringify({ key, value }),
    });
  }

  searchNotes(query: string): Promise<Result<{ notes: MemoryNote[] }, string>> {
    return requestJson(
      this.#config,
      `/notes?q=${encodeURIComponent(query)}`,
      NotesListSchema,
    );
  }

  addNote(
    content: string,
    category = "general",
  ): Promise<Result<MemoryNote, string>> {
    return requestJson(this.#config, "/notes", MemoryNoteSchema, {
      method: "POST",
      body: JSON.stringify({ content, category }),
    });
  }

  #nextId(prefix: string): string {
    this.#commandSeq += 1;
    return `${prefix}-${Date.now()}-${this.#commandSeq}`;
  }

  #send(payload: ClientMessage): boolean {
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
        this.#activities = [...message.activities];
        this.#handlers.onActivitiesChange(this.#activities);
        return;
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
      case "takeover_requested":
        this.#handlers.onTakeoverRequested(message.takeover);
        return;
      case "activity_updated":
        this.#activities = [
          message.activity,
          ...this.#activities.filter((a) => a.id !== message.activity.id),
        ];
        this.#handlers.onActivitiesChange(this.#activities);
        return;
      case "error":
        this.#handlers.onError(message.message);
        return;
      default: {
        message satisfies never;
      }
    }
  }
}
