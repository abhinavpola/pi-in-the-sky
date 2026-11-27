import type { Extension, ToolRegistration } from "@earendil-works/pi-durable";
import { num, obj, opt, str } from "@earendil-works/pi-schema";

import type { VaultCipher } from "./vault";

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

type ProfileRow = {
  key: string;
  value_enc: string;
  updated_at: number;
};

type NoteRow = {
  id: number;
  date: string;
  category: string;
  content_enc: string;
  created_at: number;
};

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export class MemoryStore {
  readonly #sql: SqlStorage;
  readonly #vault: VaultCipher;

  constructor(sql: SqlStorage, vault: VaultCipher) {
    this.#sql = sql;
    this.#vault = vault;
    this.#sql.exec(`
      CREATE TABLE IF NOT EXISTS user_profile_vault (
        key TEXT PRIMARY KEY,
        value_enc TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memory_notes_vault (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        category TEXT NOT NULL,
        content_enc TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
  }

  async getProfile(): Promise<ProfileEntry[]> {
    const rows = this.#sql
      .exec<ProfileRow>(
        "SELECT key, value_enc, updated_at FROM user_profile_vault ORDER BY key ASC",
      )
      .toArray();
    const entries: ProfileEntry[] = [];
    for (const row of rows) {
      const value = await this.#vault.decryptText(
        row.value_enc,
        `user_profile:${row.key}`,
      );
      entries.push({
        key: row.key,
        value,
        updatedAt: row.updated_at,
      });
    }
    return entries;
  }

  async setProfileEntry(key: string, value: string): Promise<ProfileEntry> {
    const now = Date.now();
    const encrypted = await this.#vault.encryptText(
      value,
      `user_profile:${key}`,
    );
    this.#sql.exec(
      `INSERT INTO user_profile_vault (key, value_enc, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_enc = excluded.value_enc, updated_at = excluded.updated_at`,
      key,
      encrypted,
      now,
    );
    return { key, value, updatedAt: now };
  }

  async addNote(
    content: string,
    category = "general",
    date?: string,
  ): Promise<MemoryNote> {
    const noteDate = date ?? todayIsoDate();
    const now = Date.now();
    const encrypted = await this.#vault.encryptText(
      content,
      `memory_notes:${noteDate}:${category}`,
    );
    this.#sql.exec(
      "INSERT INTO memory_notes_vault (date, category, content_enc, created_at) VALUES (?, ?, ?, ?)",
      noteDate,
      category,
      encrypted,
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

  async searchNotes(query: string, limit = 10): Promise<MemoryNote[]> {
    const clampedLimit = Math.max(1, Math.min(limit, 50));
    const trimmed = query.trim().toLowerCase();
    const rows = this.#sql
      .exec<NoteRow>(
        "SELECT id, date, category, content_enc, created_at FROM memory_notes_vault ORDER BY created_at DESC LIMIT 500",
      )
      .toArray();
    const tokens = trimmed ? trimmed.split(/\s+/).filter(Boolean) : [];
    const results: MemoryNote[] = [];
    for (const row of rows) {
      const content = await this.#vault.decryptText(
        row.content_enc,
        `memory_notes:${row.date}:${row.category}`,
      );
      if (tokens.length > 0) {
        const haystack = `${row.date} ${row.category} ${content}`.toLowerCase();
        if (!tokens.every((token) => haystack.includes(token))) {
          continue;
        }
      }
      results.push({
        id: row.id,
        date: row.date,
        category: row.category,
        content,
        createdAt: row.created_at,
      });
      if (results.length >= clampedLimit) {
        break;
      }
    }
    return results;
  }

  async renderProfileSummary(): Promise<string> {
    const entries = await this.getProfile();
    if (entries.length === 0) {
      return "No stored user profile facts yet.";
    }
    return entries.map((e) => `- ${e.key}: ${e.value}`).join("\n");
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
  limit: opt(num()),
});

export function createMemoryExtension(store: MemoryStore): Extension {
  const getProfileTool: ToolRegistration<typeof EmptySchema> = {
    name: "memory_get_profile",
    description:
      "Read all stored user profile facts (standing preferences like home_airport, airline_loyalty, timezone, seat_preference).",
    parameters: EmptySchema,
    replay: "safe",
    async execute() {
      const entries = await store.getProfile();
      return {
        output: [{ type: "text", text: JSON.stringify({ entries }) }],
      };
    },
  };

  const setProfileTool: ToolRegistration<typeof SetProfileSchema> = {
    name: "memory_set_profile",
    description:
      "Upsert a standing user profile preference or fact so future conversations remember it.",
    parameters: SetProfileSchema,
    replay: "safe",
    async execute({ key, value }) {
      const entry = await store.setProfileEntry(key, value);
      return {
        output: [{ type: "text", text: JSON.stringify(entry) }],
      };
    },
  };

  const writeNoteTool: ToolRegistration<typeof WriteNoteSchema> = {
    name: "memory_write_note",
    description:
      "Save a dated encrypted note (trips, bookings, decisions, follow-ups) to long-term memory.",
    parameters: WriteNoteSchema,
    replay: "safe",
    async execute({ content, category, date }) {
      const note = await store.addNote(content, category ?? "general", date);
      return {
        output: [{ type: "text", text: JSON.stringify(note) }],
      };
    },
  };

  const searchMemoryTool: ToolRegistration<typeof SearchMemorySchema> = {
    name: "memory_search",
    description:
      "Search encrypted dated memory notes for past trips, preferences, bookings, and facts.",
    parameters: SearchMemorySchema,
    replay: "safe",
    async execute({ query, limit }) {
      const notes = await store.searchNotes(query, limit ?? 10);
      return {
        output: [{ type: "text", text: JSON.stringify({ notes }) }],
      };
    },
  };

  return {
    name: "memory",
    tools: [getProfileTool, setProfileTool, writeNoteTool, searchMemoryTool],
    sections: [
      {
        key: "user-profile",
        render: () => store.renderProfileSummary(),
      },
    ],
  };
}
