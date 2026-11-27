import type { WatchEnd } from "@earendil-works/chord/watch";
import type {
  ConversationView,
  ConversationWatch,
  ConversationWindow,
  EntryQuery,
  RegistryReader,
} from "@earendil-works/pi-durable";
import {
  type PiHarness,
  type PiSessionId,
  ROOT_SESSION,
} from "agents/harness/pi";
import type { Connection, ConnectionContext } from "agents/lifecycle";
import type { WebSocketMessage, WebSocketsOptions } from "agents/websockets";

import type { BrowserTakeoverRecord } from "./browser";
import {
  type ClientMessage,
  ClientMessageSchema,
  type CommandResult,
  type ServerMessage,
} from "./protocol";

const OPEN = 1;
const SESSION_TAG_PREFIX = "pi-session:";

function sessionTag(session: PiSessionId): string {
  return `${SESSION_TAG_PREFIX}${session}`;
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
  readonly onClearWaitingTakeovers: () => void;
  readonly listWaitingTakeovers: () => BrowserTakeoverRecord[];
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
      getConnectionTags: (_connection, ctx) => [
        sessionTag(sessionFromRequest(ctx.request, ROOT_SESSION)),
      ],
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

  async reattach(): Promise<void> {
    if (this.#getWebSockets().length === 0) {
      return;
    }
    for (const { id } of await this.#harness.sessions.list()) {
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
    });
    for (const takeover of this.#callbacks.listWaitingTakeovers()) {
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
    send(socket, { type: "view", session, view: last });
    watch.start(async (call) => {
      if (call.kind !== "value") {
        return;
      }
      if (socket.readyState !== OPEN) {
        void this.#unwatch(socket);
        return;
      }
      last = call.value;
      send(socket, { type: "ops", session, ops: call.ops });
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
    if (!watch) {
      return;
    }
    this.#watches.delete(socket);
    await watch.stop();
  }

  async #onMessage(
    connection: Connection,
    message: WebSocketMessage,
  ): Promise<void> {
    const raw =
      typeof message === "string" ? message : new TextDecoder().decode(message);
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      send(connection, { type: "error", message: "Invalid JSON payload" });
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
      const errorMessage =
        thrown instanceof Error ? thrown.message : String(thrown);
      send(connection, { type: "error", id: msg.id, message: errorMessage });
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
        this.#callbacks.onClearWaitingTakeovers();
        return this.#harness.session(session).abort();
      }
      case "reset": {
        this.#callbacks.onClearWaitingTakeovers();
        await this.#harness.session(session).reset(msg.handoff);
        return { ok: true };
      }
      case "entries": {
        const query: Omit<EntryQuery, "conversationId"> = msg.query ?? {};
        const limit = Math.max(1, Math.min(msg.limit, 200));
        return this.#harness.session(session).entries(query, limit);
      }
      case "resume_takeover": {
        return this.#callbacks.onResumeTakeover(msg.takeoverId, msg.note);
      }
      default: {
        msg satisfies never;
        throw new Error("Unhandled client message");
      }
    }
  }
}
