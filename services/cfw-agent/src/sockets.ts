import type {
  ConversationView,
  ConversationWatch,
  ConversationWindow,
  EntryId,
  EntryQuery,
  RegistryReader,
  WatchEnd,
} from "@earendil-works/pi-durable";
import {
  type PiHarness,
  type PiSessionId,
  ROOT_SESSION,
} from "agents/harness/pi";
import type { Connection, ConnectionContext } from "agents/lifecycle";
import type { WebSocketMessage, WebSocketsOptions } from "agents/websockets";

import type { ApprovalRecord } from "./approvals";
import type { BrowserTakeoverRecord } from "./browser";
import type { ClientMessage, CommandResult, ServerMessage } from "./protocol";

const SESSION_TAG_PREFIX = "pi-session:";
const SESSION_QUERY = "session";
const MAX_PAGE = 100;
const OPEN = 1;

function sessionTag(session: PiSessionId): string {
  return `${SESSION_TAG_PREFIX}${session}`;
}

function sessionFromRequest(
  request: Request,
  fallback: PiSessionId,
): PiSessionId {
  const session = new URL(request.url).searchParams.get(SESSION_QUERY);
  if (session === null || session === "") {
    return fallback;
  }
  if (!/^[1-9][0-9]{0,15}$/.test(session)) {
    throw new Error(`Invalid pi session ${JSON.stringify(session)}`);
  }
  return session;
}

function sessionOf(tags: readonly string[]): string | undefined {
  const tag = tags.find((candidate) =>
    candidate.startsWith(SESSION_TAG_PREFIX),
  );
  return tag?.slice(SESSION_TAG_PREFIX.length);
}

function isEntryId(value: unknown): value is EntryId {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function parseEntryQuery(query: unknown): Omit<EntryQuery, "conversationId"> {
  const { minEntryId, maxEntryId, order } = (query ?? {}) as Record<
    string,
    unknown
  >;
  if (minEntryId !== undefined && !isEntryId(minEntryId)) {
    throw new Error("Invalid minEntryId");
  }
  if (maxEntryId !== undefined && !isEntryId(maxEntryId)) {
    throw new Error("Invalid maxEntryId");
  }
  if (order !== undefined && order !== "ascending" && order !== "descending") {
    throw new Error("Invalid order");
  }
  return {
    ...(minEntryId === undefined ? {} : { minEntryId }),
    ...(maxEntryId === undefined ? {} : { maxEntryId }),
    ...(order === undefined ? {} : { order }),
  };
}

function resumeAfter(view: ConversationView): ConversationWindow {
  const newest = view.entries.at(-1)?.id ?? view.before;
  return newest === undefined ? {} : { from: (newest + 1) as EntryId };
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
  readonly onResolveApproval: (
    approvalId: string,
    approved: boolean,
    note?: string,
  ) => Promise<CommandResult>;
  readonly onResumeTakeover: (
    takeoverId: string,
    note?: string,
  ) => Promise<CommandResult>;
  readonly listPendingApprovals: () => ApprovalRecord[];
  readonly listWaitingTakeovers: () => BrowserTakeoverRecord[];
};

export class AgentSockets {
  readonly #harness: PiHarness;
  readonly #registry: RegistryReader;
  readonly #getWebSockets: (tag?: string) => WebSocket[];
  readonly #callbacks: SocketCallbacks;
  readonly #watches = new Map<WebSocket, ConversationWatch>();
  #closed = false;

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

  broadcastApproval(approval: ApprovalRecord): void {
    const message: ServerMessage = {
      type: "approval_requested",
      approval,
    };
    for (const socket of this.#getWebSockets()) {
      send(socket, message);
    }
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
    for (const approval of this.#callbacks.listPendingApprovals()) {
      send(connection, { type: "approval_requested", approval });
    }
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
    if (this.#closed || socket.readyState !== OPEN) {
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
    if (this.#closed || socket.readyState !== OPEN || end.kind === "stopped") {
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
    raw: WebSocketMessage,
  ): Promise<void> {
    if (typeof raw !== "string") {
      send(connection, { type: "error", message: "Expected JSON text frame" });
      return;
    }
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      send(connection, { type: "error", message: "Invalid JSON" });
      return;
    }
    const id = "id" in msg ? msg.id : undefined;
    const session = sessionOf(connection.tags ?? []) ?? ROOT_SESSION;
    try {
      const result = await this.#dispatch(connection, session, msg);
      if (id !== undefined) {
        send(connection, { type: "result", id, result });
      }
    } catch (thrown) {
      send(connection, {
        type: "error",
        ...(id === undefined ? {} : { id }),
        message: thrown instanceof Error ? thrown.message : String(thrown),
      });
    }
  }

  async #dispatch(
    socket: WebSocket,
    session: PiSessionId,
    msg: ClientMessage,
  ): Promise<CommandResult> {
    switch (msg.type) {
      case "submit": {
        const receipt = await this.#harness.session(session).submit(msg.input, {
          whenBusy: msg.whenBusy,
          operationId: msg.operationId,
        });
        return receipt;
      }
      case "abort": {
        return this.#harness.session(session).abort();
      }
      case "reset": {
        await this.#harness.session(session).reset(msg.handoff);
        return { ok: true };
      }
      case "watch": {
        const window: ConversationWindow =
          msg.from === undefined ? {} : { from: msg.from };
        await this.#watch(socket, session, window);
        return { ok: true };
      }
      case "entries": {
        const limit = Math.max(1, Math.min(msg.limit, MAX_PAGE));
        return this.#harness
          .session(session)
          .entries(parseEntryQuery(msg.query), limit);
      }
      case "resolve_approval": {
        return this.#callbacks.onResolveApproval(
          msg.approvalId,
          msg.approved,
          msg.note,
        );
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
