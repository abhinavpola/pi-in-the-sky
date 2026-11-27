import type { PersonalAgent } from "./src/index";

export interface Env {
  PersonalAgent: DurableObjectNamespace<PersonalAgent>;
  AUTH_TOKEN?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  CF_ACCESS_OAUTH_CLIENT_ID?: string;
  CF_ACCESS_JWKS_JSON?: string;
  VAULT_MASTER_KEY?: string;
  DEFAULT_MODEL?: string;
  NEARAI_API_KEY?: string;
  NEARAI_BASE_URL?: string;
  GMAIL_ACCESS_TOKEN?: string;
  GOOGLE_CALENDAR_ACCESS_TOKEN?: string;
  GMAIL_API_BASE_URL?: string;
  CALENDAR_API_BASE_URL?: string;
  BROWSER_RUN_ENDPOINT?: string;
  BROWSER_RUN_TOKEN?: string;
}
