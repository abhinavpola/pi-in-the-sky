import type {
  Extension,
  ToolExecutionResult,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import { num, obj, opt, str } from "@earendil-works/pi-schema";

import type { ExtensionModuleRunner } from "./extensions";
import { errorToolResult, jsonToolResult } from "./http-tool";

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

async function runConnectorModule(
  runModule: ExtensionModuleRunner,
  path: string,
  input: unknown,
): Promise<ToolExecutionResult> {
  const result = await runModule({ path, input });
  if (result.ok) {
    return jsonToolResult(result.output);
  }
  const message =
    typeof result.output === "object" &&
    result.output !== null &&
    "error" in result.output &&
    typeof result.output.error === "string"
      ? result.output.error
      : JSON.stringify(result.output);
  return errorToolResult(message);
}

export function createConnectorsExtension(
  runModule: ExtensionModuleRunner,
): Extension {
  const gmailSearchTool: ToolRegistration<typeof GmailSearchSchema> = {
    name: "gmail_search",
    description:
      "Search the user's Gmail messages using Gmail search syntax (e.g. 'Tokyo flight confirmation').",
    parameters: GmailSearchSchema,
    replay: "safe",
    execute: ({ query, maxResults }) =>
      runConnectorModule(runModule, "tools/gmail.ts", {
        action: "search",
        query,
        maxResults,
      }),
  };

  const gmailGetMessageTool: ToolRegistration<typeof GmailGetMessageSchema> = {
    name: "gmail_get_message",
    description: "Fetch a full Gmail message by messageId.",
    parameters: GmailGetMessageSchema,
    replay: "safe",
    execute: ({ messageId }) =>
      runConnectorModule(runModule, "tools/gmail.ts", {
        action: "get_message",
        messageId,
      }),
  };

  const gmailCreateDraftTool: ToolRegistration<typeof GmailCreateDraftSchema> =
    {
      name: "gmail_create_draft",
      description:
        "Create a Gmail draft (does not send; ask the user before sending).",
      parameters: GmailCreateDraftSchema,
      replay: "unsafe",
      execute: ({ to, subject, body }) =>
        runConnectorModule(runModule, "tools/gmail.ts", {
          action: "create_draft",
          to,
          subject,
          body,
        }),
    };

  const calendarListEventsTool: ToolRegistration<
    typeof CalendarListEventsSchema
  > = {
    name: "calendar_list_events",
    description:
      "List Google Calendar events in an ISO-8601 time range [timeMin, timeMax].",
    parameters: CalendarListEventsSchema,
    replay: "safe",
    execute: ({ timeMin, timeMax, maxResults, pageToken }) =>
      runConnectorModule(runModule, "tools/google-calendar.ts", {
        action: "list_events",
        timeMin,
        timeMax,
        maxResults,
        pageToken,
      }),
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
