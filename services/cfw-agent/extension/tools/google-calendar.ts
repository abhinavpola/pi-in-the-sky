import {
  callConnector,
  type ConnectorBridgeEnv,
  readRunInput,
} from "../connections/google.ts";

export default {
  async fetch(request: Request, env: ConnectorBridgeEnv): Promise<Response> {
    const input = await readRunInput(request);
    if (
      !input ||
      input.action !== "list_events" ||
      typeof input.timeMin !== "string" ||
      typeof input.timeMax !== "string"
    ) {
      return Response.json(
        { error: "Unsupported Google Calendar action or missing time range." },
        { status: 400 },
      );
    }
    const rawMax = typeof input.maxResults === "number" ? input.maxResults : 25;
    const params = new URLSearchParams({
      timeMin: input.timeMin,
      timeMax: input.timeMax,
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: String(Math.max(1, Math.min(rawMax, 100))),
    });
    if (typeof input.pageToken === "string" && input.pageToken.length > 0) {
      params.set("pageToken", input.pageToken);
    }
    return callConnector(
      env,
      "google_calendar",
      `/calendars/primary/events?${params.toString()}`,
    );
  },
};
