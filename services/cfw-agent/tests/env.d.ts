import type { Env } from "../env";

declare global {
  namespace Cloudflare {
    interface Env extends Record<string, unknown> {
      PersonalAgent: Env["PersonalAgent"];
    }
  }
}
