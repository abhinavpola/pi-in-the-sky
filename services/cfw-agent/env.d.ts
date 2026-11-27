import type { BrowserWorker } from "@cloudflare/puppeteer";

import type { PersonalAgent } from "./src/index";

export interface Env {
  PersonalAgent: DurableObjectNamespace<PersonalAgent>;
  BROWSER?: BrowserWorker;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  CF_ACCESS_OAUTH_CLIENT_ID?: string;
  NEARAI_API_KEY?: string;
}
