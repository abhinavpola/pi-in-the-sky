import type {
  SqliteDatabase,
  SqliteExecutor,
  SqliteValue,
} from "@earendil-works/chord/sqlite";

import type { VaultCipher } from "./vault";

const PI_ENCRYPTED_COLUMNS = new Set(["record", "content"]);
const PI_JSON_AAD = "pi_vault:json";

function parseInsertColumns(sql: string): string[] | null {
  const match = /\bINTO\s+["`\w.]+\s*\(([^)]+)\)/i.exec(sql);
  if (!match?.[1]) {
    return null;
  }
  return match[1]
    .split(",")
    .map((col) => col.trim().replace(/^["`]|["`]$/g, ""));
}

function parseUpdateSetColumns(sql: string): string[] | null {
  const setMatch = /\bSET\s+([\s\S]+?)(?:\bWHERE\b|$)/i.exec(sql);
  if (!setMatch?.[1]) {
    return null;
  }
  const cols: string[] = [];
  for (const part of setMatch[1].split(",")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx === -1) {
      continue;
    }
    const lhs = part
      .slice(0, eqIdx)
      .trim()
      .replace(/^["`]|["`]$/g, "");
    const rhs = part.slice(eqIdx + 1);
    const placeholders = (rhs.match(/\?/g) ?? []).length;
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
  const outRows: unknown[] = [];
  for (const row of parsed) {
    if (!Array.isArray(row)) {
      outRows.push(row);
      continue;
    }
    const nextRow: unknown[] = [...row];
    for (const idx of encryptedIndices) {
      const cell = nextRow[idx];
      if (typeof cell === "string") {
        nextRow[idx] = await vault.encryptText(cell, PI_JSON_AAD);
      }
    }
    outRows.push(nextRow);
  }
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
      if (typeof first === "string") {
        return [await encryptJsonEachArray(first, encryptedIndices, vault)];
      }
      return params.map(toSqlValue);
    }

    const colCount = columns.length;
    const encryptedSet = new Set(encryptedIndices);
    const out: SqlStorageValue[] = [];
    for (let i = 0; i < params.length; i += 1) {
      const param = params[i];
      if (param === undefined) {
        continue;
      }
      if (encryptedSet.has(i % colCount) && typeof param === "string") {
        out.push(await vault.encryptText(param, PI_JSON_AAD));
      } else {
        out.push(toSqlValue(param));
      }
    }
    return out;
  }

  if (trimmed.startsWith("UPDATE")) {
    const setColumns = parseUpdateSetColumns(sql);
    if (!setColumns) {
      return params.map(toSqlValue);
    }
    const out: SqlStorageValue[] = [];
    for (let i = 0; i < params.length; i += 1) {
      const param = params[i];
      if (param === undefined) {
        continue;
      }
      const col = setColumns[i];
      if (col && PI_ENCRYPTED_COLUMNS.has(col) && typeof param === "string") {
        out.push(await vault.encryptText(param, PI_JSON_AAD));
      } else {
        out.push(toSqlValue(param));
      }
    }
    return out;
  }

  return params.map(toSqlValue);
}

async function decryptRowInPlace<T extends object>(
  row: T,
  vault: VaultCipher,
): Promise<T> {
  const patch: Record<string, SqliteValue> = {};
  for (const [key, value] of Object.entries(row)) {
    if (PI_ENCRYPTED_COLUMNS.has(key) && typeof value === "string") {
      const decrypted = await vault.tryDecryptJsonEnvelope(value, PI_JSON_AAD);
      if (decrypted !== null) {
        patch[key] = decrypted;
      }
    } else if (value instanceof ArrayBuffer) {
      patch[key] = new Uint8Array(value);
    }
  }
  return Object.assign({}, row, patch);
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
      const encrypted = await encryptParams(statement, params, vault);
      sql.exec(statement, ...encrypted);
    },
    async runCounted(
      statement: string,
      ...params: SqliteValue[]
    ): Promise<number> {
      const encrypted = await encryptParams(statement, params, vault);
      const cursor = sql.exec(statement, ...encrypted);
      return cursor.rowsWritten;
    },
    async get<T extends object>(
      statement: string,
      ...params: SqliteValue[]
    ): Promise<T | undefined> {
      const encoded = params.map(toSqlValue);
      const rows = sql
        .exec<Record<string, SqlStorageValue>>(statement, ...encoded)
        .toArray();
      const target = rows[0];
      if (!target) {
        return undefined;
      }
      const decrypted = await decryptRowInPlace(target, vault);
      return Object.assign(Object.create(null), decrypted);
    },
    async all<T extends object>(
      statement: string,
      ...params: SqliteValue[]
    ): Promise<T[]> {
      const encoded = params.map(toSqlValue);
      const rows = sql
        .exec<Record<string, SqlStorageValue>>(statement, ...encoded)
        .toArray();
      const decrypted: T[] = [];
      for (const row of rows) {
        const plain = await decryptRowInPlace(row, vault);
        decrypted.push(Object.assign(Object.create(null), plain));
      }
      return decrypted;
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
