import type { Extension, ToolRegistration } from "@earendil-works/pi-durable";
import { num, obj, opt, str } from "@earendil-works/pi-schema";
import { z } from "zod";

import {
  fetchJsonWithBearer,
  type HttpFetcher,
  toToolResult,
} from "./http-tool";
import { toBase64, type VaultCipher } from "./vault";

export const ConnectorProviderSchema = z.enum(["gmail", "google_calendar"]);
type ConnectorProvider = z.infer<typeof ConnectorProviderSchema>;

const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1";
const CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";

type TokenRow = {
  provider: string;
  payload_enc: string;
  updated_at: number;
};

const StoredTokenPayloadSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().nullable(),
  expiresAt: z.number().nullable(),
});

export class ConnectorStore {
  readonly #sql: SqlStorage;
  readonly #vault: VaultCipher;

  constructor(sql: SqlStorage, vault: VaultCipher) {
    this.#sql = sql;
    this.#vault = vault;
    this.#sql.exec(`
      CREATE TABLE IF NOT EXISTS connector_tokens_vault (
        provider TEXT PRIMARY KEY,
        payload_enc TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  async setToken(
    provider: ConnectorProvider,
    accessToken: string,
    refreshToken?: string,
    expiresAt?: number,
  ): Promise<void> {
    const encrypted = await this.#vault.encryptJson(
      {
        accessToken,
        refreshToken: refreshToken ?? null,
        expiresAt: expiresAt ?? null,
      },
      `connector_tokens:${provider}`,
    );
    this.#sql.exec(
      `INSERT INTO connector_tokens_vault (provider, payload_enc, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(provider) DO UPDATE SET
         payload_enc = excluded.payload_enc,
         updated_at = excluded.updated_at`,
      provider,
      encrypted,
      Date.now(),
    );
  }

  async getAccessToken(
    provider: ConnectorProvider,
  ): Promise<string | undefined> {
    const rows = this.#sql
      .exec<TokenRow>(
        "SELECT provider, payload_enc, updated_at FROM connector_tokens_vault WHERE provider = ?",
        provider,
      )
      .toArray();
    const row = rows[0];
    if (!row) {
      return undefined;
    }
    const parsed = await this.#vault.decryptJson(
      row.payload_enc,
      `connector_tokens:${provider}`,
      StoredTokenPayloadSchema,
    );
    return parsed.accessToken;
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
  const resolveToken = (
    provider: ConnectorProvider,
  ): Promise<string | undefined> => store.getAccessToken(provider);

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
