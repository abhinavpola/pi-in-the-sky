import type { Extension } from "@earendil-works/pi-durable";
import type { MemoryNote, ProfileEntry } from "@pi-in-the-sky/client/protocol";

type ProfileRow = {
  key: string;
  value: string;
  updated_at: number;
};

type NoteRow = {
  id: number;
  date: string;
  category: string;
  content: string;
  created_at: number;
};

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function toFtsQuery(raw: string): string {
  return raw
    .trim()
    .split(/\s+/)
    .map((token) => token.replace(/[^\p{L}\p{N}_-]/gu, ""))
    .filter(Boolean)
    .map((token) => `"${token}"*`)
    .join(" ");
}

export class MemoryStore {
  readonly #sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
    this.#sql.exec(`
      CREATE TABLE IF NOT EXISTS user_profile (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memory_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        category TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS memory_notes_fts USING fts5(
        content,
        category,
        date,
        content='memory_notes',
        content_rowid='id'
      );

      CREATE TRIGGER IF NOT EXISTS memory_notes_ai AFTER INSERT ON memory_notes BEGIN
        INSERT INTO memory_notes_fts(rowid, content, category, date)
        VALUES (new.id, new.content, new.category, new.date);
      END;
    `);
  }

  getProfile(): ProfileEntry[] {
    return this.#sql
      .exec<ProfileRow>(
        "SELECT key, value, updated_at FROM user_profile ORDER BY key ASC",
      )
      .toArray()
      .map((row) => ({
        key: row.key,
        value: row.value,
        updatedAt: row.updated_at,
      }));
  }

  setProfileEntry(key: string, value: string): ProfileEntry {
    const now = Date.now();
    this.#sql.exec(
      `INSERT INTO user_profile (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      key,
      value,
      now,
    );
    return { key, value, updatedAt: now };
  }

  addNote(content: string, category = "general", date?: string): MemoryNote {
    const noteDate = date ?? todayIsoDate();
    const now = Date.now();
    this.#sql.exec(
      "INSERT INTO memory_notes (date, category, content, created_at) VALUES (?, ?, ?, ?)",
      noteDate,
      category,
      content,
      now,
    );
    const idRow = this.#sql
      .exec<{ id: number }>("SELECT last_insert_rowid() AS id")
      .toArray()[0];
    return {
      id: idRow?.id ?? 0,
      date: noteDate,
      category,
      content,
      createdAt: now,
    };
  }

  searchNotes(query: string, limit = 10): MemoryNote[] {
    const clampedLimit = Math.max(1, Math.min(limit, 50));
    const ftsQuery = toFtsQuery(query);
    const rows = ftsQuery
      ? this.#sql
          .exec<NoteRow>(
            `SELECT n.id, n.date, n.category, n.content, n.created_at
             FROM memory_notes_fts f
             JOIN memory_notes n ON n.id = f.rowid
             WHERE memory_notes_fts MATCH ?
             ORDER BY n.created_at DESC
             LIMIT ?`,
            ftsQuery,
            clampedLimit,
          )
          .toArray()
      : this.#sql
          .exec<NoteRow>(
            "SELECT id, date, category, content, created_at FROM memory_notes ORDER BY created_at DESC LIMIT ?",
            clampedLimit,
          )
          .toArray();
    return rows.map((row) => ({
      id: row.id,
      date: row.date,
      category: row.category,
      content: row.content,
      createdAt: row.created_at,
    }));
  }

  renderProfileSummary(): string {
    const entries = this.getProfile();
    if (entries.length === 0) {
      return "No stored user profile facts yet.";
    }
    return entries.map((e) => `- ${e.key}: ${e.value}`).join("\n");
  }
}

export function createMemoryExtension(store: MemoryStore): Extension {
  return {
    name: "memory",
    sections: [
      {
        key: "user-profile",
        render: () => store.renderProfileSummary(),
      },
    ],
  };
}
