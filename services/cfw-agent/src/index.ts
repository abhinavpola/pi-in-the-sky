import { createModels, type MutableModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { AuthConfigResponseSchema } from "@pi-in-the-sky/client/protocol";
import { PiHarness, type PiModel, ROOT_SESSION } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import { WebSockets } from "agents/websockets";
import { DurableObject } from "cloudflare:workers";

import type { Env } from "../env";
import { verifyCloudflareAccessJwt } from "./access-auth";
import { ActivityStore, createActivitiesExtension } from "./activities";
import {
  BrowserStore,
  BrowserTakeoverSignal,
  createBrowserExtension,
} from "./browser";
import { ConnectorStore, createConnectorsExtension } from "./connectors";
import type { HttpFetcher } from "./http-tool";
import { createMemoryExtension, MemoryStore } from "./memory";
import { createNearAiProvider, DEFAULT_NEARAI_MODEL } from "./providers";
import { handleAgentHttpRequest } from "./routes";
import { createSkillsExtension } from "./skills";
import { AgentSockets } from "./sockets";
import { VaultCipher } from "./vault";
import { createEncryptedSqliteDatabase } from "./vault-sqlite";

const SYSTEM_PREAMBLE = [
  "You are a private, autonomous personal AI assistant running durably on Cloudflare with end-to-end encrypted storage and attested TEE inference.",
  "This is one continuous conversation with your user—never ask them to pick a thread or start a new chat.",
  "For multi-step or backgroundable tasks (trip research, inbox triage, bookings, monitoring), call activity_spawn to launch a dedicated subagent session so the main stream stays responsive.",
  "When the user sends a follow-up that could apply to more than one active activity, ask a brief clarifying question before steering.",
  "Use your encrypted memory tools to recall and update durable user preferences and dated notes.",
  "Use load_skill when a relevant bundled playbook exists.",
  "Ask the user in chat for permission whenever an action is irreversible, involves spending money, or sends external communications.",
  "If a website requires sign-in, CAPTCHA, or MFA, call browser_request_takeover so the user can complete it in Live View.",
].join("\n");

function hasLocalDevBearerAuth(request: Request, env: Env): boolean {
  if (!env.AUTH_TOKEN) {
    return false;
  }
  return request.headers.get("Authorization") === `Bearer ${env.AUTH_TOKEN}`;
}

function withCors(response: Response): Response {
  if (response.webSocket) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, DELETE, OPTIONS",
  );
  headers.set(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Cf-Access-Jwt-Assertion",
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export class PersonalAgent extends DurableObject<Env> {
  readonly vault = new VaultCipher(
    this.ctx.storage.sql,
    () => this.env.VAULT_MASTER_KEY,
  );
  readonly memory = new MemoryStore(this.ctx.storage.sql, this.vault);
  readonly connectors = new ConnectorStore(this.ctx.storage.sql, this.vault);
  readonly browser = new BrowserStore(this.ctx.storage.sql, this.vault);
  readonly activities = new ActivityStore(this.ctx.storage.sql, this.vault);
  readonly registry = createRegistry();

  readonly harness = new PiHarness({
    harness: async ({ context, onWake }) => {
      this.#installExtensions();
      const encryptedDb = createEncryptedSqliteDatabase(
        this.ctx.storage,
        this.vault,
      );
      const encryptedStorage = await SqliteStorage.open(encryptedDb, {
        prefix: "pi_vault",
      });
      const { models } = this.createModelRegistry();
      return Harness.open(
        encryptedStorage,
        {
          models,
          registry: this.registry,
          onWake,
          settings: {
            retry: { maxRetries: 2, baseDelayMs: 250 },
          },
        },
        context,
      );
    },
    defaults: {
      model: this.resolveDefaultModel(),
    },
  });

  readonly sockets = new AgentSockets(
    this.harness,
    this.registry,
    (tag) => this.ctx.getWebSockets(tag),
    {
      onResumeTakeover: async (takeoverId, note) =>
        this.resumeTakeover(takeoverId, note),
      onClearWaitingTakeovers: () => this.browser.clearWaitingTakeovers(),
      listWaitingTakeovers: () => this.browser.listWaitingTakeovers(),
      listActivities: () => this.activities.listActivities(),
      onSteerActivity: (activityId, instruction) =>
        this.steerActivity(activityId, instruction),
      onToggleActivity: (activityId, collapsed) =>
        this.toggleActivity(activityId, collapsed),
      onCompactThread: (summary) => this.compactThread(summary),
    },
  );

  readonly webSockets = new WebSockets(this.sockets.options());

  readonly lifecycle = Lifecycle.install(this)
    .use(this.webSockets)
    .use(this.harness);

  #extensionsInstalled = false;

  protected createModelRegistry(): { models: MutableModels } {
    const models = createModels();
    models.setProvider(
      createNearAiProvider(
        () => this.env.NEARAI_API_KEY,
        () => this.env.NEARAI_BASE_URL,
      ),
    );
    return { models };
  }

  protected resolveDefaultModel(): PiModel {
    return {
      provider: "nearai",
      id: this.env.DEFAULT_MODEL ?? DEFAULT_NEARAI_MODEL.id,
    };
  }

  protected createFetcher(): HttpFetcher {
    return (input, init) => fetch(input, init);
  }

  #installExtensions(): void {
    if (this.#extensionsInstalled) {
      return;
    }
    this.#extensionsInstalled = true;
    this.registry.install({
      name: "personal-agent-core",
      sections: [
        {
          key: "preamble",
          render: () => SYSTEM_PREAMBLE,
          tag: false,
        },
      ],
    });
    this.registry.install(createMemoryExtension(this.memory));
    this.registry.install(createSkillsExtension());
    this.registry.install(
      createActivitiesExtension(this.activities, this.harness, (record) => {
        this.sockets.broadcastActivity(record);
      }),
    );
    const fetcher = this.createFetcher();
    this.registry.install(
      createConnectorsExtension(
        this.connectors,
        () => ({
          gmailAccessToken: this.env.GMAIL_ACCESS_TOKEN,
          calendarAccessToken: this.env.GOOGLE_CALENDAR_ACCESS_TOKEN,
          gmailApiBaseUrl: this.env.GMAIL_API_BASE_URL,
          calendarApiBaseUrl: this.env.CALENDAR_API_BASE_URL,
        }),
        fetcher,
      ),
    );
    this.registry.install(
      createBrowserExtension(
        this.browser,
        () => ({
          endpoint: this.env.BROWSER_RUN_ENDPOINT,
          token: this.env.BROWSER_RUN_TOKEN,
        }),
        (record) => {
          this.sockets.broadcastTakeover(record);
        },
        fetcher,
      ),
    );
  }

  async onStart(): Promise<void> {
    this.#installExtensions();
    await this.sockets.reattach();
  }

  async resumeTakeover(
    takeoverId: string,
    note?: string,
  ): Promise<{
    readonly takeoverId: string;
    readonly delivered: string;
  }> {
    const record = await this.browser.getTakeover(takeoverId);
    if (!record) {
      throw new Error(`Unknown takeoverId: ${takeoverId}`);
    }
    const signalResult = await this.harness.signal(
      record.taskId,
      BrowserTakeoverSignal,
      takeoverId,
      { resumed: true, ...(note !== undefined ? { note } : {}) },
    );
    this.browser.markResumed(takeoverId);
    return {
      takeoverId,
      delivered: signalResult,
    };
  }

  async steerActivity(
    activityId: string,
    instruction: string,
  ): Promise<{
    readonly activityId: string;
    readonly operationId: string;
  }> {
    const record = await this.activities.getActivity(activityId);
    if (!record) {
      throw new Error(`Unknown activityId: ${activityId}`);
    }
    const receipt = await this.harness
      .session(record.sessionId)
      .submit(instruction, { whenBusy: "steer" });
    const updated = await this.activities.updateActivity(activityId, {
      status: "running",
      collapsed: false,
    });
    if (updated) {
      this.sockets.broadcastActivity(updated);
    }
    return {
      activityId,
      operationId: receipt.operationId,
    };
  }

  async toggleActivity(
    activityId: string,
    collapsed: boolean,
  ): Promise<{ readonly activityId: string; readonly collapsed: boolean }> {
    const updated = await this.activities.updateActivity(activityId, {
      collapsed,
    });
    if (!updated) {
      throw new Error(`Unknown activityId: ${activityId}`);
    }
    this.sockets.broadcastActivity(updated);
    return { activityId, collapsed: updated.collapsed };
  }

  async compactThread(
    summary: string,
  ): Promise<{ readonly ok: true; readonly noteId: number }> {
    const note = await this.memory.addNote(summary, "compaction");
    await this.harness.session(ROOT_SESSION).reset(summary);
    return { ok: true, noteId: note.id };
  }

  async onRequest(request: Request): Promise<Response> {
    const bodyText =
      request.method !== "GET" && request.method !== "HEAD"
        ? await request.text()
        : "";
    return handleAgentHttpRequest(request, bodyText, this);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }));
    }

    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return withCors(Response.json({ ok: true }));
    }

    if (url.pathname === "/auth/config") {
      const enabled = Boolean(env.CF_ACCESS_TEAM_DOMAIN && env.CF_ACCESS_AUD);
      const payload = AuthConfigResponseSchema.parse({
        provider: enabled ? "cloudflare_access_oauth" : "none",
        teamDomain: env.CF_ACCESS_TEAM_DOMAIN ?? null,
        aud: env.CF_ACCESS_AUD ?? null,
        clientId: env.CF_ACCESS_OAUTH_CLIENT_ID ?? null,
      });
      return withCors(Response.json(payload));
    }

    const identity = await verifyCloudflareAccessJwt(request, {
      teamDomain: env.CF_ACCESS_TEAM_DOMAIN,
      aud: env.CF_ACCESS_AUD,
      jwksJson: env.CF_ACCESS_JWKS_JSON,
    });

    const isDevAuthed = !identity && hasLocalDevBearerAuth(request, env);

    if (!identity && !isDevAuthed) {
      return withCors(
        Response.json({ error: "Unauthorized" }, { status: 401 }),
      );
    }

    const meMatch = url.pathname.match(/^\/api\/me(\/.*)?$/);
    if (meMatch) {
      const agentId = identity?.sub ?? "personal";
      const stub = env.PersonalAgent.getByName(agentId);
      const response = await stub.fetch(request);
      return withCors(response);
    }

    const agentMatch = url.pathname.match(/^\/api\/agents\/([^/]+)(\/.*)?$/);
    if (!agentMatch?.[1]) {
      return withCors(Response.json({ error: "Not found" }, { status: 404 }));
    }

    const requestedId = decodeURIComponent(agentMatch[1]);
    if (identity && requestedId !== identity.sub) {
      return withCors(Response.json({ error: "Forbidden" }, { status: 403 }));
    }

    const stub = env.PersonalAgent.getByName(requestedId);
    const response = await stub.fetch(request);
    return withCors(response);
  },
};
