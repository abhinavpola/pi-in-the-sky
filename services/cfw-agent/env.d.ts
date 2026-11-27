import type { PersonalAgent } from "./src/index";

export interface Env {
  PersonalAgent: DurableObjectNamespace<PersonalAgent>;
  BROWSER?: Fetcher;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  CF_ACCESS_OAUTH_CLIENT_ID?: string;
  VAULT_MASTER_KEY?: string;
  NEARAI_API_KEY?: string;
}
