import type { Extension, ToolRegistration } from "@earendil-works/pi-durable";
import { int, obj, opt, str } from "@earendil-works/pi-schema";
import { err } from "@pi-in-the-sky/result-monad";

import { fetchJsonWithBearer, toToolResult } from "./http-tool";

export type ConnectorProvider = "gmail" | "google_calendar";

type ConnectorConfig = {
  readonly gmailAccessToken?: string;
  readonly calendarAccessToken?: string;
  readonly gmailApiBaseUrl?: string;
  readonly calendarApiBaseUrl?: string;
};

export class ConnectorStore {
  readonly #sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
    this.#migrate();
  }

  #migrate(): void {
    this.#sql.exec(`
      CREATE TABLE IF NOT EXISTS connector_tokens (
        provider TEXT PRIMARY KEY,
        access_token TEXT NOT NULL,
        refresh_token TEXT,
        expires_at INTEGER,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  setToken(
    provider: ConnectorProvider,
    accessToken: string,
    refreshToken?: string,
    expiresAt?: number,
  ): void {
    this.#sql.exec(
      `INSERT INTO connector_tokens (provider, access_token, refresh_token, expires_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(provider) DO UPDATE SET
         access_token = excluded.access_token,
         refresh_token = excluded.refresh_token,
         expires_at = excluded.expires_at,
         updated_at = excluded.updated_at`,
      provider,
      accessToken,
      refreshToken ?? null,
      expiresAt ?? null,
      Date.now(),
    );
  }

  getAccessToken(provider: ConnectorProvider): string | undefined {
    const rows = this.#sql
      .exec<{ access_token: string }>(
        "SELECT access_token FROM connector_tokens WHERE provider = ?",
        provider,
      )
      .toArray();
    return rows[0]?.access_token;
  }
}

const GmailSearchSchema = obj({
  query: str(),
  maxResults: opt(int()),
});

const GmailGetMessageSchema = obj({
  messageId: str(),
});

const GmailCreateDraftSchema = obj({
  to: str(),
  subject: str(),
  body: str(),
});

const CalendarListEventsSchema = obj({
  timeMin: str(),
  timeMax: str(),
  calendarId: opt(str()),
});

export function createConnectorsExtension(
  store: ConnectorStore,
  getConfig: () => ConnectorConfig,
  fetcher: typeof fetch = fetch,
): Extension {
  const resolveToken = (provider: ConnectorProvider): string | undefined => {
    const stored = store.getAccessToken(provider);
    if (stored) {
      return stored;
    }
    const config = getConfig();
    switch (provider) {
      case "gmail":
        return config.gmailAccessToken;
      case "google_calendar":
        return config.calendarAccessToken;
      default: {
        provider satisfies never;
        return undefined;
      }
    }
  };

  const requestApi = async (
    provider: ConnectorProvider,
    url: string,
    init?: RequestInit,
  ) => {
    const token = resolveToken(provider);
    if (!token) {
      return toToolResult(
        err("Connector is not authenticated. Configure an OAuth token first."),
      );
    }
    return toToolResult(
      await fetchJsonWithBearer(url, fetcher, { token, init }),
    );
  };

  const gmailBase = () =>
    (
      getConfig().gmailApiBaseUrl ?? "https://gmail.googleapis.com/gmail/v1"
    ).replace(/\/$/, "");

  const calendarBase = () =>
    (
      getConfig().calendarApiBaseUrl ?? "https://www.googleapis.com/calendar/v3"
    ).replace(/\/$/, "");

  const gmailSearchTool: ToolRegistration<typeof GmailSearchSchema> = {
    name: "gmail_search",
    description: "Search Gmail messages matching a Gmail query string.",
    parameters: GmailSearchSchema,
    replay: "safe",
    execute: ({ query, maxResults }) => {
      const params = new URLSearchParams({
        q: query,
        maxResults: String(Math.max(1, Math.min(maxResults ?? 10, 50))),
      });
      return requestApi(
        "gmail",
        `${gmailBase()}/users/me/messages?${params.toString()}`,
      );
    },
  };

  const gmailGetMessageTool: ToolRegistration<typeof GmailGetMessageSchema> = {
    name: "gmail_get_message",
    description: "Fetch the full contents of a Gmail message by message ID.",
    parameters: GmailGetMessageSchema,
    replay: "safe",
    execute: ({ messageId }) =>
      requestApi(
        "gmail",
        `${gmailBase()}/users/me/messages/${encodeURIComponent(messageId)}`,
      ),
  };

  const gmailCreateDraftTool: ToolRegistration<typeof GmailCreateDraftSchema> =
    {
      name: "gmail_create_draft",
      description: "Create a Gmail draft without sending it.",
      parameters: GmailCreateDraftSchema,
      replay: "unsafe",
      execute: ({ to, subject, body }) => {
        const rawMime = [`To: ${to}`, `Subject: ${subject}`, "", body].join(
          "\r\n",
        );
        const raw = btoa(rawMime)
          .replaceAll("+", "-")
          .replaceAll("/", "_")
          .replaceAll("=", "");
        return requestApi("gmail", `${gmailBase()}/users/me/drafts`, {
          method: "POST",
          body: JSON.stringify({ message: { raw } }),
        });
      },
    };

  const calendarListEventsTool: ToolRegistration<
    typeof CalendarListEventsSchema
  > = {
    name: "calendar_list_events",
    description: "List Google Calendar events within an ISO-8601 time range.",
    parameters: CalendarListEventsSchema,
    replay: "safe",
    execute: ({ timeMin, timeMax, calendarId }) => {
      const id = encodeURIComponent(calendarId ?? "primary");
      const params = new URLSearchParams({
        timeMin,
        timeMax,
        singleEvents: "true",
        orderBy: "startTime",
      });
      return requestApi(
        "google_calendar",
        `${calendarBase()}/calendars/${id}/events?${params.toString()}`,
      );
    },
  };

  return {
    name: "connectors",
    tools: [
      gmailSearchTool,
      gmailGetMessageTool,
      gmailCreateDraftTool,
      calendarListEventsTool,
    ],
  };
}
