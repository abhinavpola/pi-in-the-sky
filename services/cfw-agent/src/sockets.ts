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
} from "@pi-in-the-sky/client/protocol";
import {
  type PiHarness,
  type PiSessionId,
  ROOT_SESSION,
} from "agents/harness/pi";
import type { Connection, ConnectionContext } from "agents/lifecycle";
import type { WebSocketMessage, WebSocketsOptions } from "agents/websockets";

import type { BrowserTakeoverRecord } from "./browser";
import type { CommandResult, ServerMessage } from "./protocol";

const OPEN = 1;
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
  if (socket.readyState !== OPEN) {
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
  ) => Promise<CommandResult>;
  readonly onClearWaitingTakeovers: (conversationId: number) => void;
  readonly listWaitingTakeovers: () => Promise<BrowserTakeoverRecord[]>;
  readonly listActivities: () => Promise<ActivityRecord[]>;
  readonly onSteerActivity: (
    activityId: string,
    instruction: string,
  ) => Promise<CommandResult>;
  readonly onToggleActivity: (
    activityId: string,
    collapsed: boolean,
  ) => Promise<CommandResult>;
  readonly onCompactThread: (summary: string) => Promise<CommandResult>;
};

export class AgentSockets {
  readonly #harness: PiHarness;
  readonly #registry: RegistryReader;
  readonly #getWebSockets: (tag?: string) => WebSocket[];
  readonly #callbacks: SocketCallbacks;
  readonly #watches = new Map<WebSocket, ConversationWatch>();

  constructor(
    harness: PiHarness,
    registry: RegistryReader,
    getWebSockets: (tag?: string) => WebSocket[],
    callbacks: SocketCallbacks,
  ) {
    this.#harness = harness;
    this.#registry = registry;
    this.#getWebSockets = getWebSockets;
    this.#callbacks = callbacks;
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
      send(socket, message);
    }
  }

  broadcastActivity(activity: ActivityRecord): void {
    const message: ServerMessage = {
      type: "activity_updated",
      activity,
    };
    for (const socket of this.#getWebSockets()) {
      send(socket, message);
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
    if (socket.readyState !== OPEN) {
      await watch.stop();
      return;
    }
    const previous = this.#watches.get(socket);
    this.#watches.set(socket, watch);
    void previous?.stop();
    let last = watch.value;
    send(socket, { type: "view", view: last });
    watch.start(async (call) => {
      if (call.kind !== "value") {
        return;
      }
      if (socket.readyState !== OPEN) {
        void this.#unwatch(socket);
        return;
      }
      last = call.value;
      send(socket, { type: "view", view: call.value });
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
    if (socket.readyState !== OPEN || end.kind === "stopped") {
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
    const tokenExpSec = expFromTags(connection.tags);
    if (tokenExpSec !== null && Date.now() / 1000 >= tokenExpSec) {
      send(connection, {
        type: "error",
        message: "Access token expired; reconnect with a fresh token.",
      });
      await this.#unwatch(connection);
      try {
        connection.close(4401, "Access token expired");
      } catch {
        return;
      }
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
      const result = await this.#handle(connection, session, msg);
      send(connection, { type: "result", id: msg.id, result });
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
  ): Promise<CommandResult> {
    switch (msg.type) {
      case "watch": {
        await this.#watch(connection, session, {});
        return { watching: session };
      }
      case "submit": {
        return this.#harness.session(session).submit(msg.input, {
          operationId: msg.operationId,
          whenBusy: msg.whenBusy,
        });
      }
      case "abort": {
        const conversationId =
          this.#watches.get(connection)?.value.conversation.id;
        if (conversationId !== undefined) {
          this.#callbacks.onClearWaitingTakeovers(Number(conversationId));
        }
        return this.#harness.session(session).abort();
      }
      case "reset": {
        const conversationId =
          this.#watches.get(connection)?.value.conversation.id;
        if (conversationId !== undefined) {
          this.#callbacks.onClearWaitingTakeovers(Number(conversationId));
        }
        await this.#harness.session(session).reset(msg.handoff);
        return { ok: true };
      }
      case "compact": {
        return this.#callbacks.onCompactThread(msg.summary);
      }
      case "entries": {
        const query: Omit<EntryQuery, "conversationId"> = msg.query ?? {};
        const limit = Math.max(1, Math.min(msg.limit, 200));
        return this.#harness.session(session).entries(query, limit);
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
      default: {
        msg satisfies never;
        throw new Error("Unhandled client message");
      }
    }
  }
}
