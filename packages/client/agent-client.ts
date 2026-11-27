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

export const ConnectionConfigSchema = z
  .object({
    baseUrl: z.string(),
    authToken: z.string(),
    refreshToken: z.string().optional(),
    accessTeamDomain: z.string().optional(),
    accessClientId: z.string().optional(),
  })
  .readonly();

export type ConnectionConfig = z.infer<typeof ConnectionConfigSchema>;

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
const OkResponseSchema = z.object({ ok: z.literal(true) });

const BASE_URL_PATTERN =
  /^(https?):\/\/(\[[^\]]+\]|[^/:?#]+)(?::\d+)?(\/.*)?$/i;

function validateBaseUrl(baseUrl: string): Result<string, string> {
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

type PendingRpc = {
  readonly resolve: (value: Result<unknown, string>) => void;
};

export class AgentClient {
  #config: ConnectionConfig;
  readonly #handlers: ClientHandlers;
  #socket: WebSocket | null = null;
  #messages: ChatMessage[] = [];
  #activities: ActivityRecord[] = [];
  #commandSeq = 0;
  readonly #pending = new Map<string, PendingRpc>();

  constructor(config: ConnectionConfig, handlers: ClientHandlers) {
    this.#config = config;
    this.#handlers = handlers;
  }

  updateConfig(config: ConnectionConfig): void {
    this.#config = config;
    this.clearSession();
    this.connect();
  }

  clearSession(): void {
    this.#messages = [];
    this.#activities = [];
    this.#handlers.onMessagesChange([]);
    this.#handlers.onActivitiesChange([]);
    this.#handlers.onReset();
    this.disconnect();
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
    const wsUrl = `${wsBase}/api/me/ws`;
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
        this.#rejectAllPending("Disconnected from agent.");
        this.#handlers.onConnectionChange("disconnected");
      }
    };
  }

  disconnect(): void {
    if (this.#socket) {
      this.#socket.close();
      this.#socket = null;
    }
    this.#rejectAllPending("Disconnected from agent.");
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
    return this.#call(
      { type: "get_profile", id: this.#nextId("prof") },
      ProfileListSchema,
    );
  }

  setProfileEntry(
    key: string,
    value: string,
  ): Promise<Result<{ ok: true }, string>> {
    return this.#call(
      { type: "set_profile", id: this.#nextId("setprof"), key, value },
      OkResponseSchema,
    );
  }

  searchNotes(query: string): Promise<Result<{ notes: MemoryNote[] }, string>> {
    return this.#call(
      {
        type: "search_notes",
        id: this.#nextId("notes"),
        query: query.trim() || undefined,
      },
      NotesListSchema,
    );
  }

  addNote(
    content: string,
    category = "general",
  ): Promise<Result<MemoryNote, string>> {
    return this.#call(
      { type: "add_note", id: this.#nextId("addnote"), content, category },
      MemoryNoteSchema,
    );
  }

  #nextId(prefix: string): string {
    this.#commandSeq += 1;
    return `${prefix}-${Date.now()}-${this.#commandSeq}`;
  }

  #rejectAllPending(reason: string): void {
    for (const pending of this.#pending.values()) {
      pending.resolve(err(reason));
    }
    this.#pending.clear();
  }

  async #call<T>(
    message: ClientMessage,
    schema: z.ZodType<T>,
  ): Promise<Result<T, string>> {
    if (!this.#socket || this.#socket.readyState !== 1) {
      return err("Not connected to agent.");
    }
    const raw = await new Promise<Result<unknown, string>>((resolve) => {
      this.#pending.set(message.id, { resolve });
      if (!this.#send(message)) {
        this.#pending.delete(message.id);
        resolve(err("Failed to send WebSocket message."));
      }
    });
    if (!raw.ok) {
      return raw;
    }
    const parsed = schema.safeParse(raw.value);
    if (!parsed.success) {
      return err("Unexpected response shape from agent.");
    }
    return ok(parsed.data);
  }

  #send(message: ClientMessage): boolean {
    if (!this.#socket || this.#socket.readyState !== 1) {
      return false;
    }
    this.#socket.send(JSON.stringify(message));
    return true;
  }

  #handleIncoming(msg: IncomingSocketMessage): void {
    switch (msg.type) {
      case "hello":
        this.#activities = msg.activities;
        this.#handlers.onActivitiesChange(this.#activities);
        return;
      case "result": {
        if (msg.id) {
          const pending = this.#pending.get(msg.id);
          if (pending) {
            this.#pending.delete(msg.id);
            pending.resolve(ok(msg.result));
          }
        }
        return;
      }
      case "view": {
        const extracted = extractMessagesFromView(msg.view);
        this.#messages = extracted.messages;
        this.#handlers.onMessagesChange(this.#messages);
        if (extracted.liveError) {
          this.#handlers.onError(extracted.liveError);
        }
        return;
      }
      case "takeover_requested":
        this.#handlers.onTakeoverRequested(msg.takeover);
        return;
      case "activity_updated": {
        const next = [
          msg.activity,
          ...this.#activities.filter((item) => item.id !== msg.activity.id),
        ].sort((a, b) => b.updatedAt - a.updatedAt);
        this.#activities = next;
        this.#handlers.onActivitiesChange(next);
        return;
      }
      case "error": {
        if (msg.id) {
          const pending = this.#pending.get(msg.id);
          if (pending) {
            this.#pending.delete(msg.id);
            pending.resolve(err(msg.message));
            return;
          }
        }
        this.#handlers.onError(msg.message);
        return;
      }
      default: {
        msg satisfies never;
      }
    }
  }
}
