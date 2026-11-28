import type { ToolExecutionResult } from "@earendil-works/pi-durable";
import { err, ok, type Result } from "@pi-in-the-sky/result-monad";

export type HttpFetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export async function fetchJsonWithBearer(
  url: string,
  fetcher: HttpFetcher,
  options: {
    readonly token?: string;
    readonly init?: RequestInit;
    readonly errorPrefix?: string;
  },
): Promise<Result<unknown, string>> {
  const headers = new Headers(options.init?.headers);
  if (options.token) {
    headers.set("Authorization", `Bearer ${options.token}`);
  }
  if (options.init?.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  try {
    const response = await fetcher(url, {
      ...options.init,
      headers,
      redirect: "manual",
    });
    const prefix = options.errorPrefix ? `${options.errorPrefix} ` : "";
    if (response.status >= 300 && response.status < 400) {
      return err(`${prefix}Unexpected redirect (HTTP ${response.status}).`);
    }
    const text = await response.text();
    if (!response.ok) {
      const summary = text.replace(/\s+/g, " ").trim().slice(0, 200);
      return err(
        summary
          ? `${prefix}HTTP ${response.status}: ${summary}`
          : `${prefix}HTTP ${response.status}`,
      );
    }
    const parsed: unknown = text ? JSON.parse(text) : {};
    return ok(parsed);
  } catch (thrown) {
    return err(thrown instanceof Error ? thrown.message : String(thrown));
  }
}

export function jsonToolResult(
  value: unknown,
  isError = false,
): ToolExecutionResult {
  return {
    output: [{ type: "text", text: JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
  };
}

export function errorToolResult(message: string): ToolExecutionResult {
  return {
    output: [{ type: "text", text: message }],
    isError: true,
  };
}

export function toToolResult(
  result: Result<unknown, string>,
): ToolExecutionResult {
  return result.ok
    ? jsonToolResult(result.value)
    : errorToolResult(result.error);
}
