import type { Extension, ToolRegistration } from "@earendil-works/pi-durable";
import { int, obj, opt, str } from "@earendil-works/pi-schema";

export type ProfileEntry = {
  readonly key: string;
  readonly value: string;
  readonly updatedAt: number;
};

export type MemoryNote = {
  readonly id: number;
  readonly date: string;
  readonly category: string;
  readonly content: string;
  readonly createdAt: number;
};

export class MemoryStore {
  readonly #sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
    this.#migrate();
  }

  #migrate(): void {
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
        content='memory_notes',
        content_rowid='id'
      );

      CREATE TRIGGER IF NOT EXISTS memory_notes_ai AFTER INSERT ON memory_notes BEGIN
        INSERT INTO memory_notes_fts(rowid, content, category)
        VALUES (new.id, new.content, new.category);
      END;

      CREATE TRIGGER IF NOT EXISTS memory_notes_ad AFTER DELETE ON memory_notes BEGIN
        INSERT INTO memory_notes_fts(memory_notes_fts, rowid, content, category)
        VALUES ('delete', old.id, old.content, old.category);
      END;

      CREATE TRIGGER IF NOT EXISTS memory_notes_au AFTER UPDATE ON memory_notes BEGIN
        INSERT INTO memory_notes_fts(memory_notes_fts, rowid, content, category)
        VALUES ('delete', old.id, old.content, old.category);
        INSERT INTO memory_notes_fts(rowid, content, category)
        VALUES (new.id, new.content, new.category);
      END;
    `);
  }

  getProfile(): ProfileEntry[] {
    const rows = this.#sql
      .exec<{ key: string; value: string; updated_at: number }>(
        "SELECT key, value, updated_at FROM user_profile ORDER BY key ASC",
      )
      .toArray();
    return rows.map((row) => ({
      key: row.key,
      value: row.value,
      updatedAt: row.updated_at,
    }));
  }

  setProfileEntry(key: string, value: string): ProfileEntry {
    const updatedAt = Date.now();
    this.#sql.exec(
      `INSERT INTO user_profile (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      key,
      value,
      updatedAt,
    );
    return { key, value, updatedAt };
  }

  deleteProfileEntry(key: string): boolean {
    const before = this.#sql
      .exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM user_profile WHERE key = ?",
        key,
      )
      .one().count;
    if (before === 0) {
      return false;
    }
    this.#sql.exec("DELETE FROM user_profile WHERE key = ?", key);
    return true;
  }

  addNote(content: string, category = "general", date?: string): MemoryNote {
    const createdAt = Date.now();
    const resolvedDate = date ?? new Date(createdAt).toISOString().slice(0, 10);
    this.#sql.exec(
      "INSERT INTO memory_notes (date, category, content, created_at) VALUES (?, ?, ?, ?)",
      resolvedDate,
      category,
      content,
      createdAt,
    );
    const row = this.#sql
      .exec<{
        id: number;
        date: string;
        category: string;
        content: string;
        created_at: number;
      }>(
        "SELECT id, date, category, content, created_at FROM memory_notes ORDER BY id DESC LIMIT 1",
      )
      .one();
    return {
      id: row.id,
      date: row.date,
      category: row.category,
      content: row.content,
      createdAt: row.created_at,
    };
  }

  #toNote(row: {
    id: number;
    date: string;
    category: string;
    content: string;
    created_at: number;
  }): MemoryNote {
    return {
      id: row.id,
      date: row.date,
      category: row.category,
      content: row.content,
      createdAt: row.created_at,
    };
  }

  searchNotes(query: string, limit = 10): MemoryNote[] {
    const trimmed = query.trim();
    if (!trimmed) {
      return this.listRecentNotes(limit);
    }
    const sanitized = trimmed
      .split(/\s+/)
      .map((term) => `"${term.replaceAll('"', '""')}"`)
      .join(" OR ");
    const rows = this.#sql
      .exec<{
        id: number;
        date: string;
        category: string;
        content: string;
        created_at: number;
      }>(
        `SELECT m.id, m.date, m.category, m.content, m.created_at
         FROM memory_notes m
         JOIN memory_notes_fts f ON f.rowid = m.id
         WHERE memory_notes_fts MATCH ?
         ORDER BY bm25(memory_notes_fts), m.created_at DESC
         LIMIT ?`,
        sanitized,
        Math.max(1, Math.min(limit, 50)),
      )
      .toArray();
    return rows.map((row) => this.#toNote(row));
  }

  listRecentNotes(limit = 10): MemoryNote[] {
    const rows = this.#sql
      .exec<{
        id: number;
        date: string;
        category: string;
        content: string;
        created_at: number;
      }>(
        "SELECT id, date, category, content, created_at FROM memory_notes ORDER BY created_at DESC, id DESC LIMIT ?",
        Math.max(1, Math.min(limit, 50)),
      )
      .toArray();
    return rows.map((row) => this.#toNote(row));
  }

  renderProfilePrompt(): string {
    const entries = this.getProfile();
    if (entries.length === 0) {
      return "User profile is empty. Save durable preferences with memory_set_profile.";
    }
    const lines = entries.map((entry) => `- ${entry.key}: ${entry.value}`);
    return ["User profile:", ...lines].join("\n");
  }
}

const EmptySchema = obj({});
const SetProfileSchema = obj({
  key: str(),
  value: str(),
});
const WriteNoteSchema = obj({
  content: str(),
  category: opt(str()),
  date: opt(str()),
});
const SearchMemorySchema = obj({
  query: str(),
  limit: opt(int()),
});

export function createMemoryExtension(memory: MemoryStore): Extension {
  const getProfileTool: ToolRegistration<typeof EmptySchema> = {
    name: "memory_get_profile",
    description: "Read all standing user profile facts and preferences.",
    parameters: EmptySchema,
    replay: "safe",
    async execute() {
      return {
        output: [{ type: "text", text: JSON.stringify(memory.getProfile()) }],
      };
    },
  };

  const setProfileTool: ToolRegistration<typeof SetProfileSchema> = {
    name: "memory_set_profile",
    description:
      "Save or update a standing user profile preference such as home_airport, timezone, or seating_preference.",
    parameters: SetProfileSchema,
    replay: "safe",
    async execute({ key, value }) {
      const saved = memory.setProfileEntry(key, value);
      return {
        output: [{ type: "text", text: JSON.stringify(saved) }],
      };
    },
  };

  const writeNoteTool: ToolRegistration<typeof WriteNoteSchema> = {
    name: "memory_write_note",
    description: "Record a dated note for future recall via full-text search.",
    parameters: WriteNoteSchema,
    replay: "unsafe",
    async execute({ content, category, date }) {
      const saved = memory.addNote(content, category, date);
      return {
        output: [{ type: "text", text: JSON.stringify(saved) }],
      };
    },
  };

  const searchMemoryTool: ToolRegistration<typeof SearchMemorySchema> = {
    name: "memory_search",
    description:
      "Search stored dated notes using SQLite FTS5 full-text search.",
    parameters: SearchMemorySchema,
    replay: "safe",
    async execute({ query, limit }) {
      const results = memory.searchNotes(query, limit);
      return {
        output: [{ type: "text", text: JSON.stringify(results) }],
      };
    },
  };

  return {
    name: "memory",
    sections: [
      {
        key: "memory_profile",
        render: () => memory.renderProfilePrompt(),
      },
    ],
    tools: [getProfileTool, setProfileTool, writeNoteTool, searchMemoryTool],
  };
}
