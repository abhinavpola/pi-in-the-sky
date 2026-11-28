import type { TaskId } from "@earendil-works/pi-durable";
import type { TakeoverRecord } from "@pi-in-the-sky/client/protocol";

const TAKEOVER_TTL_MS = 10 * 60_000;

export type BrowserTakeoverRecord = TakeoverRecord & {
  readonly taskId: TaskId;
  readonly createdAt: number;
};

type BrowserTakeoverRow = {
  id: string;
  task_id: TaskId;
  conversation_id: number;
  url: string;
  hostname: string;
  origin: string;
  live_view_url: string | null;
  expires_at: number;
  reason: string;
  status: TakeoverRecord["status"];
  created_at: number;
};

type TakeoverTokenEntry = {
  readonly takeoverId: string;
  readonly origin: string;
  readonly expiresAt: number;
};

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export class BrowserStore {
  readonly #sql: SqlStorage;
  readonly #takeoverTokens = new Map<string, TakeoverTokenEntry>();
  readonly #waitingTakeovers = new Map<string, number>();

  constructor(sql: SqlStorage) {
    this.#sql = sql;
    this.#sql.exec(`
      CREATE TABLE IF NOT EXISTS browser_takeovers (
        id TEXT PRIMARY KEY,
        task_id INTEGER NOT NULL,
        conversation_id INTEGER NOT NULL DEFAULT 0,
        url TEXT NOT NULL,
        hostname TEXT NOT NULL DEFAULT '',
        origin TEXT NOT NULL DEFAULT '',
        live_view_url TEXT,
        expires_at INTEGER NOT NULL DEFAULT 0,
        reason TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS browser_session_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    const waitingRows = this.#sql
      .exec<{ id: string; conversation_id: number }>(
        "SELECT id, conversation_id FROM browser_takeovers WHERE status = 'waiting'",
      )
      .toArray();
    for (const row of waitingRows) {
      this.#waitingTakeovers.set(row.id, row.conversation_id);
    }
  }

  getSessionId(conversationId: string): string | undefined {
    const row = this.#sql
      .exec<{ value: string }>(
        "SELECT value FROM browser_session_state WHERE key = ?",
        `session_id:${conversationId}`,
      )
      .toArray()[0];
    return row?.value;
  }

  setSessionId(conversationId: string, sessionId: string): void {
    this.#sql.exec(
      `INSERT INTO browser_session_state (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      `session_id:${conversationId}`,
      sessionId,
    );
  }

  clearSessionId(conversationId: string): void {
    this.#sql.exec(
      "DELETE FROM browser_session_state WHERE key = ?",
      `session_id:${conversationId}`,
    );
  }

  async mintTakeoverToken(
    takeoverId: string,
    origin: string,
    ttlMs = TAKEOVER_TTL_MS,
  ): Promise<{ readonly token: string; readonly expiresAt: number }> {
    const rawBytes = new Uint8Array(32);
    crypto.getRandomValues(rawBytes);
    const token = bytesToBase64Url(rawBytes);
    const tokenHash = await sha256Hex(token);
    const expiresAt = Date.now() + ttlMs;
    this.#takeoverTokens.set(tokenHash, { takeoverId, origin, expiresAt });
    return { token, expiresAt };
  }

  revokeTakeoverTokens(takeoverId: string): void {
    for (const [hash, entry] of this.#takeoverTokens.entries()) {
      if (entry.takeoverId === takeoverId || entry.expiresAt <= Date.now()) {
        this.#takeoverTokens.delete(hash);
      }
    }
  }

  createTakeover(input: {
    readonly id: string;
    readonly taskId: TaskId;
    readonly conversationId: number;
    readonly url: string;
    readonly hostname: string;
    readonly origin: string;
    readonly liveViewUrl: string | null;
    readonly expiresAt: number;
    readonly reason: string;
  }): BrowserTakeoverRecord {
    const createdAt = Date.now();
    this.#sql.exec(
      `INSERT OR IGNORE INTO browser_takeovers (
        id, task_id, conversation_id, url, hostname, origin, live_view_url, expires_at, reason, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting', ?)`,
      input.id,
      Number(input.taskId),
      input.conversationId,
      input.url,
      input.hostname,
      input.origin,
      input.liveViewUrl,
      input.expiresAt,
      input.reason,
      createdAt,
    );
    const created = this.getTakeover(input.id);
    if (!created) {
      throw new Error(`Failed to persist browser takeover ${input.id}`);
    }
    this.#waitingTakeovers.set(input.id, input.conversationId);
    return created;
  }

  #toTakeover(row: BrowserTakeoverRow): BrowserTakeoverRecord {
    return {
      id: row.id,
      taskId: row.task_id,
      url: row.url,
      hostname: row.hostname,
      origin: row.origin,
      liveViewUrl: row.live_view_url,
      expiresAt: row.expires_at,
      reason: row.reason,
      status: row.status,
      createdAt: row.created_at,
    };
  }

  getTakeover(id: string): BrowserTakeoverRecord | undefined {
    const row = this.#sql
      .exec<BrowserTakeoverRow>(
        "SELECT id, task_id, conversation_id, url, hostname, origin, live_view_url, expires_at, reason, status, created_at FROM browser_takeovers WHERE id = ?",
        id,
      )
      .toArray()[0];
    return row ? this.#toTakeover(row) : undefined;
  }

  hasWaitingTakeover(conversationId: number): boolean {
    for (const waitingConversationId of this.#waitingTakeovers.values()) {
      if (waitingConversationId === conversationId) {
        return true;
      }
    }
    return false;
  }

  listWaitingTakeovers(): BrowserTakeoverRecord[] {
    const now = Date.now();
    return this.#sql
      .exec<BrowserTakeoverRow>(
        "SELECT id, task_id, conversation_id, url, hostname, origin, live_view_url, expires_at, reason, status, created_at FROM browser_takeovers WHERE status = 'waiting' ORDER BY created_at ASC",
      )
      .toArray()
      .map((row) => {
        const record = this.#toTakeover(row);
        if (record.expiresAt > 0 && record.expiresAt <= now) {
          return { ...record, liveViewUrl: null };
        }
        return record;
      });
  }

  markResumed(id: string): void {
    this.#waitingTakeovers.delete(id);
    this.#sql.exec(
      "UPDATE browser_takeovers SET status = 'resumed' WHERE id = ?",
      id,
    );
    this.revokeTakeoverTokens(id);
  }

  clearWaitingTakeovers(conversationId: number): void {
    const ids = new Set<string>();
    for (const [
      id,
      waitingConversationId,
    ] of this.#waitingTakeovers.entries()) {
      if (waitingConversationId === conversationId) {
        ids.add(id);
        this.#waitingTakeovers.delete(id);
      }
    }
    const rows = this.#sql
      .exec<{ id: string }>(
        "SELECT id FROM browser_takeovers WHERE status = 'waiting' AND conversation_id = ?",
        conversationId,
      )
      .toArray();
    for (const row of rows) {
      ids.add(row.id);
    }
    this.#sql.exec(
      "UPDATE browser_takeovers SET status = 'resumed' WHERE status = 'waiting' AND conversation_id = ?",
      conversationId,
    );
    for (const id of ids) {
      this.revokeTakeoverTokens(id);
    }
  }
}
