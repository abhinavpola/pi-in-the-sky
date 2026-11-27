import type { createAI } from "agents/models/pi-ai";

import type { PersonalAgent } from "./src/index";

type CloudflareModelId = Parameters<ReturnType<typeof createAI>>[0];

export interface Env {
  AI: Ai;
  PersonalAgent: DurableObjectNamespace<PersonalAgent>;
  AUTH_TOKEN?: string;
  DEFAULT_MODEL?: CloudflareModelId;
  GMAIL_ACCESS_TOKEN?: string;
  GOOGLE_CALENDAR_ACCESS_TOKEN?: string;
  GMAIL_API_BASE_URL?: string;
  CALENDAR_API_BASE_URL?: string;
  BROWSER_RUN_ENDPOINT?: string;
  BROWSER_RUN_TOKEN?: string;
}
