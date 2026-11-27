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
    const response = await fetcher(url, { ...options.init, headers });
    const text = await response.text();
    if (!response.ok) {
      const prefix = options.errorPrefix ? `${options.errorPrefix} ` : "";
      return err(`${prefix}HTTP ${response.status}: ${text}`);
    }
    const parsed: unknown = text ? JSON.parse(text) : {};
    return ok(parsed);
  } catch (thrown) {
    return err(thrown instanceof Error ? thrown.message : String(thrown));
  }
}

export function toToolResult(
  result: Result<unknown, string>,
): ToolExecutionResult {
  if (!result.ok) {
    return {
      output: [{ type: "text", text: result.error }],
      isError: true,
    };
  }
  return {
    output: [{ type: "text", text: JSON.stringify(result.value) }],
  };
}
