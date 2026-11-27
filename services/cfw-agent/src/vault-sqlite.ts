import type {
  SqliteDatabase,
  SqliteExecutor,
  SqliteValue,
} from "@earendil-works/chord/sqlite";

import type { VaultCipher } from "./vault";

const PI_ENCRYPTED_COLUMNS = new Set(["record", "content"]);
const PI_JSON_AAD = "pi_vault:json";

function stripSqlIdent(token: string): string {
  return token.trim().replace(/^["`[]|["`\]]$/g, "");
}

function scanUnquotedSql(
  input: string,
  onChar: (ch: string, index: number) => void,
): void {
  let quote: string | null = null;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === undefined) {
      continue;
    }
    if (quote) {
      if (ch === quote && input[i + 1] !== quote) {
        quote = null;
      } else if (ch === quote) {
        i += 1;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
    } else {
      onChar(ch, i);
    }
  }
}

function splitTopLevelCommas(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  scanUnquotedSql(input, (ch, index) => {
    if (ch === "(") {
      depth += 1;
    } else if (ch === ")") {
      depth = Math.max(0, depth - 1);
    } else if (ch === "," && depth === 0) {
      parts.push(input.slice(start, index));
      start = index + 1;
    }
  });
  parts.push(input.slice(start));
  return parts;
}

function countUnquotedPlaceholders(input: string): number {
  let count = 0;
  scanUnquotedSql(input, (ch) => {
    if (ch === "?") {
      count += 1;
    }
  });
  return count;
}

function parseInsertColumns(sql: string): string[] | null {
  const intoMatch = /\bINTO\s+["`\w.]+\s*\(/i.exec(sql);
  if (!intoMatch) {
    return null;
  }
  const openIdx = intoMatch.index + intoMatch[0].length - 1;
  let depth = 0;
  for (let i = openIdx; i < sql.length; i += 1) {
    if (sql[i] === "(") {
      depth += 1;
    } else if (sql[i] === ")") {
      depth -= 1;
      if (depth === 0) {
        return splitTopLevelCommas(sql.slice(openIdx + 1, i)).map(
          stripSqlIdent,
        );
      }
    }
  }
  return null;
}

function parseUpdateSetColumns(sql: string): string[] | null {
  const setMatch = /\bSET\s+/i.exec(sql);
  if (!setMatch) {
    return null;
  }
  const rest = sql.slice(setMatch.index + setMatch[0].length);
  const whereMatch = /\bWHERE\b/i.exec(rest);
  const setBody = whereMatch ? rest.slice(0, whereMatch.index) : rest;
  const cols: string[] = [];
  for (const part of splitTopLevelCommas(setBody)) {
    const eqIdx = part.indexOf("=");
    if (eqIdx === -1) {
      continue;
    }
    const lhs = stripSqlIdent(part.slice(0, eqIdx));
    const placeholders = countUnquotedPlaceholders(part.slice(eqIdx + 1));
    for (let i = 0; i < placeholders; i += 1) {
      cols.push(lhs);
    }
  }
  return cols;
}

function toSqlValue(value: SqliteValue): SqlStorageValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number"
  ) {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  const buffer = new ArrayBuffer(value.byteLength);
  new Uint8Array(buffer).set(value);
  return buffer;
}

async function encryptJsonEachArray(
  rawJson: string,
  encryptedIndices: readonly number[],
  vault: VaultCipher,
): Promise<string> {
  if (encryptedIndices.length === 0) {
    return rawJson;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return rawJson;
  }
  if (!Array.isArray(parsed)) {
    return rawJson;
  }
  const outRows = await Promise.all(
    parsed.map(async (row) => {
      if (!Array.isArray(row)) {
        return row;
      }
      const nextRow: unknown[] = [...row];
      await Promise.all(
        encryptedIndices.map(async (idx) => {
          const cell = nextRow[idx];
          if (typeof cell === "string") {
            nextRow[idx] = await vault.encryptText(cell, PI_JSON_AAD);
          }
        }),
      );
      return nextRow;
    }),
  );
  return JSON.stringify(outRows);
}

async function encryptParams(
  sql: string,
  params: readonly SqliteValue[],
  vault: VaultCipher,
): Promise<SqlStorageValue[]> {
  const trimmed = sql.trimStart().toUpperCase();
  if (trimmed.startsWith("INSERT")) {
    const columns = parseInsertColumns(sql);
    if (!columns) {
      return params.map(toSqlValue);
    }
    const encryptedIndices = columns
      .map((col, idx) => (PI_ENCRYPTED_COLUMNS.has(col) ? idx : -1))
      .filter((idx) => idx >= 0);
    if (encryptedIndices.length === 0) {
      return params.map(toSqlValue);
    }
    if (/\bjson_each\s*\(\s*\?\s*\)/i.test(sql) && params.length === 1) {
      const first = params[0];
      return typeof first === "string"
        ? [await encryptJsonEachArray(first, encryptedIndices, vault)]
        : params.map(toSqlValue);
    }
    const encryptedSet = new Set(encryptedIndices);
    return Promise.all(
      params.map(async (param, idx) =>
        encryptedSet.has(idx % columns.length) && typeof param === "string"
          ? vault.encryptText(param, PI_JSON_AAD)
          : toSqlValue(param),
      ),
    );
  }

  if (trimmed.startsWith("UPDATE")) {
    const setColumns = parseUpdateSetColumns(sql);
    if (!setColumns) {
      return params.map(toSqlValue);
    }
    return Promise.all(
      params.map(async (param, idx) => {
        const col = setColumns[idx];
        return col && PI_ENCRYPTED_COLUMNS.has(col) && typeof param === "string"
          ? vault.encryptText(param, PI_JSON_AAD)
          : toSqlValue(param);
      }),
    );
  }

  return params.map(toSqlValue);
}

async function decryptRow<T extends object>(
  row: Record<string, SqlStorageValue>,
  vault: VaultCipher,
): Promise<T> {
  const entries = await Promise.all(
    Object.entries(row).map(
      async ([key, value]): Promise<[string, unknown]> => {
        if (PI_ENCRYPTED_COLUMNS.has(key) && typeof value === "string") {
          const decrypted = await vault.tryDecryptJsonEnvelope(
            value,
            PI_JSON_AAD,
          );
          return [key, decrypted ?? value];
        }
        if (value instanceof ArrayBuffer) {
          return [key, new Uint8Array(value)];
        }
        return [key, value];
      },
    ),
  );
  return Object.assign(Object.create(null), Object.fromEntries(entries));
}

export function createEncryptedSqliteDatabase(
  storage: DurableObjectStorage,
  vault: VaultCipher,
): SqliteDatabase {
  const sql = storage.sql;

  const executor: SqliteExecutor = {
    async exec(statement: string): Promise<void> {
      sql.exec(statement);
    },
    async run(statement: string, ...params: SqliteValue[]): Promise<void> {
      sql.exec(statement, ...(await encryptParams(statement, params, vault)));
    },
    async runCounted(
      statement: string,
      ...params: SqliteValue[]
    ): Promise<number> {
      const cursor = sql.exec(
        statement,
        ...(await encryptParams(statement, params, vault)),
      );
      return cursor.rowsWritten;
    },
    async get<T extends object>(
      statement: string,
      ...params: SqliteValue[]
    ): Promise<T | undefined> {
      const target = sql
        .exec<Record<string, SqlStorageValue>>(
          statement,
          ...params.map(toSqlValue),
        )
        .toArray()[0];
      return target ? decryptRow<T>(target, vault) : undefined;
    },
    async all<T extends object>(
      statement: string,
      ...params: SqliteValue[]
    ): Promise<T[]> {
      const rows = sql
        .exec<Record<string, SqlStorageValue>>(
          statement,
          ...params.map(toSqlValue),
        )
        .toArray();
      return Promise.all(rows.map((row) => decryptRow<T>(row, vault)));
    },
  };

  return {
    ...executor,
    transaction<T>(fn: (tx: SqliteExecutor) => Promise<T>): Promise<T> {
      return storage.transaction(() => fn(executor));
    },
    async close(): Promise<void> {},
  };
}
