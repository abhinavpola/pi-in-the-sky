import type { Extension, ToolRegistration } from "@earendil-works/pi-durable";
import { arr, nul, num, obj, opt, str, union } from "@earendil-works/pi-schema";

import { errorToolResult, jsonToolResult } from "./http-tool";

const MAX_SQLITE_ROWS = 200;

const SqlParamSchema = union([str(), num(), nul()]);

const SqliteQuerySchema = obj({
  sql: str(),
  params: opt(arr(SqlParamSchema)),
});

const SQLITE_SCHEMA_GUIDE = [
  "You have direct SQLite access to your agent database via sqlite_query (secrets live in an isolated host facet and are never in this database).",
  "Key tables:",
  "- user_profile (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)",
  "- memory_notes (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, category TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL) + FTS5 memory_notes_fts",
  "- activities (id, title, session_id, status, summary, collapsed, created_at, updated_at)",
  "- Inspect all tables (including conversation/pre-compaction history) with: SELECT name, sql FROM sqlite_master WHERE type='table'",
].join("\n");

export function createSqliteExtension(sql: SqlStorage): Extension {
  const sqliteQueryTool: ToolRegistration<typeof SqliteQuerySchema> = {
    name: "sqlite_query",
    description:
      "Execute a parameterized SQLite query against your agent database (user_profile, memory_notes, memory_notes_fts, activities, and conversation history). Pass bind parameters in params.",
    parameters: SqliteQuerySchema,
    replay: "unsafe",
    async execute({ sql: query, params }) {
      const trimmed = query.trim();
      if (!trimmed) {
        return errorToolResult("SQL query must not be empty.");
      }
      try {
        const cursor = sql.exec(trimmed, ...(params ?? []));
        const rows: Record<string, SqlStorageValue>[] = [];
        let truncated = false;
        for (const row of cursor) {
          if (rows.length >= MAX_SQLITE_ROWS) {
            truncated = true;
            break;
          }
          rows.push(row);
        }
        return jsonToolResult({
          columns: cursor.columnNames,
          rows,
          rowCount: rows.length,
          truncated,
          rowsRead: cursor.rowsRead,
          rowsWritten: cursor.rowsWritten,
        });
      } catch (thrown) {
        return errorToolResult(
          thrown instanceof Error ? thrown.message : String(thrown),
        );
      }
    },
  };

  return {
    name: "sqlite",
    tools: [sqliteQueryTool],
    sections: [
      {
        key: "sqlite-database",
        render: () => SQLITE_SCHEMA_GUIDE,
      },
    ],
  };
}
