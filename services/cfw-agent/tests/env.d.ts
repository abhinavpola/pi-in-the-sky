import type { TestPersonalAgent } from "./worker";

declare global {
  namespace Cloudflare {
    interface Env extends Record<string, unknown> {
      PersonalAgent: DurableObjectNamespace<TestPersonalAgent>;
    }
  }
}
