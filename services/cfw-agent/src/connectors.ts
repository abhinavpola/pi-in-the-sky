import type { Extension, ToolRegistration } from "@earendil-works/pi-durable";
import { num, obj, opt, str } from "@earendil-works/pi-schema";
import type { ConnectorProvider } from "@pi-in-the-sky/client/protocol";

import {
  fetchJsonWithBearer,
  type HttpFetcher,
  toToolResult,
} from "./http-tool";

const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1";
const CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

type TokenRow = {
  access_token: string;
};

export class ConnectorStore {
  readonly #sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
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
    const row = this.#sql
      .exec<TokenRow>(
        "SELECT access_token FROM connector_tokens WHERE provider = ?",
        provider,
      )
      .toArray()[0];
    return row?.access_token;
  }
}

const GmailSearchSchema = obj({
  query: str(),
  maxResults: opt(num()),
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
  maxResults: opt(num()),
  pageToken: opt(str()),
});

function encodeBase64Url(input: string): string {
  return toBase64(new TextEncoder().encode(input))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function createConnectorsExtension(
  store: ConnectorStore,
  fetcher: HttpFetcher = (input, init) => fetch(input, init),
): Extension {
  const resolveToken = (provider: ConnectorProvider): string | undefined =>
    store.getAccessToken(provider);

  const gmailBase = () => GMAIL_API_BASE;
  const calendarBase = () => CALENDAR_API_BASE;

  const gmailSearchTool: ToolRegistration<typeof GmailSearchSchema> = {
    name: "gmail_search",
    description:
      "Search the user's Gmail messages using Gmail search syntax (e.g. 'Tokyo flight confirmation').",
    parameters: GmailSearchSchema,
    replay: "safe",
    async execute({ query, maxResults }) {
      const token = await resolveToken("gmail");
      if (!token) {
        return {
          isError: true,
          output: [
            { type: "text", text: "Gmail connector is not authorized." },
          ],
        };
      }
      const params = new URLSearchParams({
        q: query,
        maxResults: String(Math.max(1, Math.min(maxResults ?? 10, 25))),
      });
      const result = await fetchJsonWithBearer(
        `${gmailBase()}/users/me/messages?${params.toString()}`,
        fetcher,
        { token },
      );
      return toToolResult(result);
    },
  };

  const gmailGetMessageTool: ToolRegistration<typeof GmailGetMessageSchema> = {
    name: "gmail_get_message",
    description: "Fetch a full Gmail message by messageId.",
    parameters: GmailGetMessageSchema,
    replay: "safe",
    async execute({ messageId }) {
      const token = await resolveToken("gmail");
      if (!token) {
        return {
          isError: true,
          output: [
            { type: "text", text: "Gmail connector is not authorized." },
          ],
        };
      }
      const result = await fetchJsonWithBearer(
        `${gmailBase()}/users/me/messages/${encodeURIComponent(messageId)}`,
        fetcher,
        { token },
      );
      return toToolResult(result);
    },
  };

  const gmailCreateDraftTool: ToolRegistration<typeof GmailCreateDraftSchema> =
    {
      name: "gmail_create_draft",
      description:
        "Create a Gmail draft (does not send; ask the user before sending).",
      parameters: GmailCreateDraftSchema,
      replay: "unsafe",
      async execute({ to, subject, body }) {
        const token = await resolveToken("gmail");
        if (!token) {
          return {
            isError: true,
            output: [
              { type: "text", text: "Gmail connector is not authorized." },
            ],
          };
        }
        const rawMime = [
          `To: ${to}`,
          `Subject: ${subject}`,
          "Content-Type: text/plain; charset=UTF-8",
          "",
          body,
        ].join("\r\n");
        const result = await fetchJsonWithBearer(
          `${gmailBase()}/users/me/drafts`,
          fetcher,
          {
            token,
            init: {
              method: "POST",
              body: JSON.stringify({
                message: { raw: encodeBase64Url(rawMime) },
              }),
            },
          },
        );
        return toToolResult(result);
      },
    };

  const calendarListEventsTool: ToolRegistration<
    typeof CalendarListEventsSchema
  > = {
    name: "calendar_list_events",
    description:
      "List Google Calendar events in an ISO-8601 time range [timeMin, timeMax].",
    parameters: CalendarListEventsSchema,
    replay: "safe",
    async execute({ timeMin, timeMax, maxResults, pageToken }) {
      const token = await resolveToken("google_calendar");
      if (!token) {
        return {
          isError: true,
          output: [
            {
              type: "text",
              text: "Google Calendar connector is not authorized.",
            },
          ],
        };
      }
      const params = new URLSearchParams({
        timeMin,
        timeMax,
        singleEvents: "true",
        orderBy: "startTime",
        maxResults: String(Math.max(1, Math.min(maxResults ?? 25, 100))),
      });
      if (pageToken) {
        params.set("pageToken", pageToken);
      }
      const result = await fetchJsonWithBearer(
        `${calendarBase()}/calendars/primary/events?${params.toString()}`,
        fetcher,
        { token },
      );
      return toToolResult(result);
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
