import type { ToolExecutionResult } from "@earendil-works/pi-durable";
import { err, ok, type Result } from "@pi-in-the-sky/result-monad";

export async function fetchJsonWithBearer(
  url: string,
  fetcher: typeof fetch,
  options: {
    readonly token?: string;
    readonly init?: RequestInit;
    readonly errorPrefix?: string;
  },
): Promise<Result<unknown, string>> {
  try {
    const headers = new Headers(options.init?.headers);
    if (options.token) {
      headers.set("Authorization", `Bearer ${options.token}`);
    }
    if (options.init?.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    const response = await fetcher(url, { ...options.init, headers });
    const text = await response.text();
    if (!response.ok) {
      const prefix = options.errorPrefix ? `${options.errorPrefix} ` : "";
      return err(`${prefix}HTTP ${response.status}: ${text}`);
    }
    return ok(text ? (JSON.parse(text) as unknown) : {});
  } catch (thrown) {
    return err(thrown instanceof Error ? thrown.message : String(thrown));
  }
}

export function toToolResult(
  result: Result<unknown, string>,
): ToolExecutionResult {
  if (!result.ok) {
    return { isError: true, output: [{ type: "text", text: result.error }] };
  }
  return {
    output: [{ type: "text", text: JSON.stringify(result.value) }],
  };
}
