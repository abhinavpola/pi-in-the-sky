import type {
  ConversationView,
  ConversationWatch,
  ConversationWindow,
  EntryQuery,
  RegistryReader,
  WatchEnd,
} from "@earendil-works/pi-durable";
import {
  type ActivityRecord,
  type ClientMessage,
  ClientMessageSchema,
  type ConnectorProvider,
} from "@pi-in-the-sky/client/protocol";
import { err, ok, type Result } from "@pi-in-the-sky/result-monad";
import {
  type PiHarness,
  type PiSessionId,
  ROOT_SESSION,
} from "agents/harness/pi";
import type { Connection, ConnectionContext } from "agents/lifecycle";
import type { WebSocketMessage, WebSocketsOptions } from "agents/websockets";

import type { BrowserTakeoverRecord } from "./browser";
import type { CommandResult, ServerMessage } from "./protocol";

const SESSION_TAG_PREFIX = "pi-session:";
const EXP_TAG_PREFIX = "pi-exp:";
export const ACCESS_TOKEN_EXP_HEADER = "X-Access-Token-Exp";

function sessionTag(session: PiSessionId): string {
  return `${SESSION_TAG_PREFIX}${session}`;
}

function expTagFromRequest(request: Request): string | null {
  const raw = request.headers.get(ACCESS_TOKEN_EXP_HEADER);
  if (!raw) {
    return null;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return `${EXP_TAG_PREFIX}${Math.floor(parsed)}`;
}

function expFromTags(tags: readonly string[]): number | null {
  for (const tag of tags) {
    if (tag.startsWith(EXP_TAG_PREFIX)) {
      const parsed = Number(tag.slice(EXP_TAG_PREFIX.length));
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
    }
  }
  return null;
}

function sessionFromRequest(
  request: Request,
  fallback: PiSessionId,
): PiSessionId {
  const url = new URL(request.url);
  const requested = url.searchParams.get("session")?.trim();
  return requested || fallback;
}

function sessionFromTags(
  tags: readonly string[],
  fallback: PiSessionId,
): PiSessionId {
  for (const tag of tags) {
    if (tag.startsWith(SESSION_TAG_PREFIX)) {
      return tag.slice(SESSION_TAG_PREFIX.length);
    }
  }
  return fallback;
}

function resumeAfter(view: ConversationView): ConversationWindow {
  const newest = view.entries.at(-1)?.id ?? view.before;
  return newest === undefined ? {} : { from: newest };
}

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }
  try {
    socket.send(JSON.stringify(message));
  } catch {
    return;
  }
}

type SocketCallbacks = {
  readonly onResumeTakeover: (
    takeoverId: string,
    note?: string,
  ) => Promise<Result<CommandResult, string>>;
  readonly onClearWaitingTakeovers: (conversationId: number) => void;
  readonly listWaitingTakeovers: () => Promise<BrowserTakeoverRecord[]>;
  readonly listActivities: () => Promise<ActivityRecord[]>;
  readonly onSteerActivity: (
    activityId: string,
    instruction: string,
  ) => Promise<Result<CommandResult, string>>;
  readonly onToggleActivity: (
    activityId: string,
    collapsed: boolean,
  ) => Promise<Result<CommandResult, string>>;
  readonly onCompactThread: (summary: string) => Promise<CommandResult>;
  readonly onGetProfile: () => Promise<CommandResult>;
  readonly onSetProfile: (key: string, value: string) => Promise<CommandResult>;
  readonly onSearchNotes: (
    query?: string,
    limit?: number,
  ) => Promise<CommandResult>;
  readonly onAddNote: (
    content: string,
    category?: string,
  ) => Promise<CommandResult>;
  readonly onSetConnectorToken: (
    provider: ConnectorProvider,
    accessToken: string,
    refreshToken?: string,
    expiresAt?: number,
  ) => Promise<CommandResult>;
};

export class AgentSockets {
  readonly #harness: PiHarness;
  readonly #registry: RegistryReader;
  readonly #getWebSockets: (tag?: string) => WebSocket[];
  readonly #getTags: (socket: WebSocket) => readonly string[];
  readonly #callbacks: SocketCallbacks;
  readonly #watches = new Map<WebSocket, ConversationWatch>();

  constructor(
    harness: PiHarness,
    registry: RegistryReader,
    getWebSockets: (tag?: string) => WebSocket[],
    getTags: (socket: WebSocket) => readonly string[],
    callbacks: SocketCallbacks,
  ) {
    this.#harness = harness;
    this.#registry = registry;
    this.#getWebSockets = getWebSockets;
    this.#getTags = getTags;
    this.#callbacks = callbacks;
  }

  #isExpired(socket: WebSocket, tags?: readonly string[]): boolean {
    const tokenExpSec = expFromTags(tags ?? this.#getTags(socket));
    return tokenExpSec !== null && Date.now() / 1000 >= tokenExpSec;
  }

  #expireSocket(socket: WebSocket): void {
    send(socket, {
      type: "error",
      message: "Access token expired; reconnect with a fresh token.",
    });
    void this.#unwatch(socket);
    try {
      socket.close(4401, "Access token expired");
    } catch {
      return;
    }
  }

  #sendIfActive(socket: WebSocket, message: ServerMessage): boolean {
    if (this.#isExpired(socket)) {
      this.#expireSocket(socket);
      return false;
    }
    send(socket, message);
    return true;
  }

  options(): WebSocketsOptions {
    return {
      getConnectionTags: (_connection, ctx) => {
        const tags = [
          sessionTag(sessionFromRequest(ctx.request, ROOT_SESSION)),
        ];
        const expTag = expTagFromRequest(ctx.request);
        if (expTag) {
          tags.push(expTag);
        }
        return tags;
      },
      handlers: {
        onConnect: (connection, ctx) => this.#onConnect(connection, ctx),
        onMessage: (connection, message) =>
          this.#onMessage(connection, message),
        onClose: (connection) => this.#unwatch(connection),
        onError: (connection) => this.#unwatch(connection),
      },
    };
  }

  broadcastTakeover(takeover: BrowserTakeoverRecord): void {
    const message: ServerMessage = {
      type: "takeover_requested",
      takeover,
    };
    for (const socket of this.#getWebSockets()) {
      this.#sendIfActive(socket, message);
    }
  }

  broadcastActivity(activity: ActivityRecord): void {
    const message: ServerMessage = {
      type: "activity_updated",
      activity,
    };
    for (const socket of this.#getWebSockets()) {
      this.#sendIfActive(socket, message);
    }
  }

  async reattach(): Promise<void> {
    if (this.#getWebSockets().length === 0) {
      return;
    }
    const activities = await this.#callbacks.listActivities();
    const sessionIds = new Set<PiSessionId>([
      ROOT_SESSION,
      ...activities.map((activity) => activity.sessionId),
    ]);
    for (const id of sessionIds) {
      for (const socket of this.#getWebSockets(sessionTag(id))) {
        await this.#watchOrClose(socket, id);
      }
    }
  }

  async #onConnect(
    connection: Connection,
    ctx: ConnectionContext,
  ): Promise<void> {
    const session = sessionFromRequest(ctx.request, ROOT_SESSION);
    const [activities, takeovers] = await Promise.all([
      this.#callbacks.listActivities(),
      this.#callbacks.listWaitingTakeovers(),
    ]);
    send(connection, {
      type: "hello",
      session,
      tools: this.#registry
        .snapshot()
        .tools()
        .map(({ tool }) => ({
          name: tool.name,
          description: tool.description,
        })),
      activities,
    });
    for (const takeover of takeovers) {
      send(connection, { type: "takeover_requested", takeover });
    }
  }

  async #watch(
    socket: WebSocket,
    session: PiSessionId,
    window: ConversationWindow = {},
  ): Promise<void> {
    const watch = await this.#harness.session(session).watch(window);
    if (socket.readyState !== WebSocket.OPEN) {
      await watch.stop();
      return;
    }
    const previous = this.#watches.get(socket);
    this.#watches.set(socket, watch);
    void previous?.stop();
    let last = watch.value;
    if (!this.#sendIfActive(socket, { type: "view", view: last })) {
      return;
    }
    watch.start(async (call) => {
      if (call.kind !== "value") {
        return;
      }
      if (socket.readyState !== WebSocket.OPEN) {
        void this.#unwatch(socket);
        return;
      }
      last = call.value;
      this.#sendIfActive(socket, { type: "view", view: call.value });
    });
    void watch.closed.then((end) =>
      this.#ended(socket, session, watch, end, last),
    );
  }

  async #watchOrClose(
    socket: WebSocket,
    session: PiSessionId,
    window: ConversationWindow = {},
  ): Promise<void> {
    try {
      await this.#watch(socket, session, window);
    } catch {
      try {
        socket.close(1011, "Failed to watch session");
      } catch {
        return;
      }
    }
  }

  async #ended(
    socket: WebSocket,
    session: PiSessionId,
    watch: ConversationWatch,
    end: WatchEnd,
    last: ConversationView,
  ): Promise<void> {
    if (this.#watches.get(socket) !== watch) {
      return;
    }
    this.#watches.delete(socket);
    if (socket.readyState !== WebSocket.OPEN || end.kind === "stopped") {
      return;
    }
    await this.#watchOrClose(socket, session, resumeAfter(last));
  }

  async #unwatch(socket: WebSocket): Promise<void> {
    const watch = this.#watches.get(socket);
    this.#watches.delete(socket);
    await watch?.stop();
  }

  async #onMessage(
    connection: Connection,
    message: WebSocketMessage,
  ): Promise<void> {
    if (this.#isExpired(connection, connection.tags)) {
      this.#expireSocket(connection);
      return;
    }
    if (typeof message !== "string") {
      send(connection, { type: "error", message: "Expected text frame" });
      return;
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(message);
    } catch {
      send(connection, { type: "error", message: "Invalid JSON" });
      return;
    }
    const parsed = ClientMessageSchema.safeParse(parsedJson);
    if (!parsed.success) {
      send(connection, { type: "error", message: "Invalid message payload" });
      return;
    }
    const msg = parsed.data;
    const session = sessionFromTags(connection.tags, ROOT_SESSION);
    try {
      const outcome = await this.#handle(connection, session, msg);
      if (!outcome.ok) {
        send(connection, { type: "error", id: msg.id, message: outcome.error });
        return;
      }
      send(connection, { type: "result", id: msg.id, result: outcome.value });
    } catch (thrown) {
      send(connection, {
        type: "error",
        id: msg.id,
        message: thrown instanceof Error ? thrown.message : String(thrown),
      });
    }
  }

  async #handle(
    connection: Connection,
    session: PiSessionId,
    msg: ClientMessage,
  ): Promise<Result<CommandResult, string>> {
    switch (msg.type) {
      case "watch": {
        await this.#watch(connection, session, {});
        return ok({ watching: session });
      }
      case "submit": {
        return ok(
          await this.#harness.session(session).submit(msg.input, {
            operationId: msg.operationId,
            whenBusy: msg.whenBusy,
          }),
        );
      }
      case "abort": {
        const conversationId =
          this.#watches.get(connection)?.value.conversation.id;
        if (conversationId !== undefined) {
          this.#callbacks.onClearWaitingTakeovers(Number(conversationId));
        }
        return ok(await this.#harness.session(session).abort());
      }
      case "reset": {
        const conversationId =
          this.#watches.get(connection)?.value.conversation.id;
        if (conversationId !== undefined) {
          this.#callbacks.onClearWaitingTakeovers(Number(conversationId));
        }
        await this.#harness.session(session).reset(msg.handoff);
        return ok({ ok: true });
      }
      case "compact": {
        return ok(await this.#callbacks.onCompactThread(msg.summary));
      }
      case "entries": {
        const query: Omit<EntryQuery, "conversationId"> = msg.query ?? {};
        const limit = Math.max(1, Math.min(msg.limit, 200));
        return ok(await this.#harness.session(session).entries(query, limit));
      }
      case "resume_takeover": {
        return this.#callbacks.onResumeTakeover(msg.takeoverId, msg.note);
      }
      case "steer_activity": {
        return this.#callbacks.onSteerActivity(msg.activityId, msg.instruction);
      }
      case "toggle_activity": {
        return this.#callbacks.onToggleActivity(msg.activityId, msg.collapsed);
      }
      case "get_profile": {
        return ok(await this.#callbacks.onGetProfile());
      }
      case "set_profile": {
        return ok(await this.#callbacks.onSetProfile(msg.key, msg.value));
      }
      case "search_notes": {
        return ok(await this.#callbacks.onSearchNotes(msg.query, msg.limit));
      }
      case "add_note": {
        return ok(await this.#callbacks.onAddNote(msg.content, msg.category));
      }
      case "set_connector_token": {
        return ok(
          await this.#callbacks.onSetConnectorToken(
            msg.provider,
            msg.accessToken,
            msg.refreshToken,
            msg.expiresAt,
          ),
        );
      }
      default: {
        msg satisfies never;
        return err("Unhandled client message");
      }
    }
  }
}
