import { createModels, type MutableModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import {
  AuthConfigResponseSchema,
  LOCAL_DEV_AUTH_TOKEN,
} from "@pi-in-the-sky/client/protocol";
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
import { createSkillsExtension } from "./skills";
import { ACCESS_TOKEN_EXP_HEADER, AgentSockets } from "./sockets";
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

function timingSafeEqualText(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.length !== right.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

function hasLocalDevBearerAuth(request: Request, env: Env): boolean {
  if (env.CF_ACCESS_TEAM_DOMAIN || env.CF_ACCESS_AUD) {
    return false;
  }
  const provided = request.headers.get("Authorization");
  if (!provided) {
    return false;
  }
  return timingSafeEqualText(provided, `Bearer ${LOCAL_DEV_AUTH_TOKEN}`);
}

function forwardToDurableObject(
  stub: DurableObjectStub<PersonalAgent>,
  request: Request,
  tokenExpSec: number | null,
): Promise<Response> {
  const headers = new Headers(request.headers);
  headers.delete(ACCESS_TOKEN_EXP_HEADER);
  if (tokenExpSec !== null) {
    headers.set(ACCESS_TOKEN_EXP_HEADER, String(tokenExpSec));
  }
  return stub.fetch(new Request(request, { headers }));
}

function allowedCorsOrigin(request: Request): string | null {
  const origin = request.headers.get("Origin");
  if (!origin) {
    return null;
  }
  try {
    const parsed = new URL(origin);
    const reqOrigin = new URL(request.url).origin;
    if (origin === reqOrigin) {
      return origin;
    }
    if (
      parsed.protocol === "http:" &&
      (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")
    ) {
      return origin;
    }
    return null;
  } catch {
    return null;
  }
}

function withCors(request: Request, response: Response): Response {
  if (response.webSocket) {
    return response;
  }
  const origin = allowedCorsOrigin(request);
  if (!origin) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Vary", "Origin");
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
      onClearWaitingTakeovers: (conversationId) =>
        this.browser.clearWaitingTakeovers(conversationId),
      listWaitingTakeovers: () => this.browser.listWaitingTakeovers(),
      listActivities: () => this.activities.listActivities(),
      onSteerActivity: (activityId, instruction) =>
        this.steerActivity(activityId, instruction),
      onToggleActivity: (activityId, collapsed) =>
        this.toggleActivity(activityId, collapsed),
      onCompactThread: (summary) => this.compactThread(summary),
      onGetProfile: async () => ({
        entries: await this.memory.getProfile(),
      }),
      onSetProfile: async (key, value) => {
        await this.memory.setProfileEntry(key, value);
        return { ok: true };
      },
      onSearchNotes: async (query, limit) => ({
        notes: await this.memory.searchNotes(query ?? "", limit ?? 20),
      }),
      onAddNote: (content, category) =>
        this.memory.addNote(content, category ?? "general"),
      onSetConnectorToken: async (
        provider,
        accessToken,
        refreshToken,
        expiresAt,
      ) => {
        await this.connectors.setToken(
          provider,
          accessToken,
          refreshToken,
          expiresAt,
        );
        return { ok: true };
      },
    },
  );

  readonly webSockets = new WebSockets(this.sockets.options());

  readonly lifecycle = Lifecycle.install(this)
    .use(this.webSockets)
    .use(this.harness);

  #extensionsInstalled = false;

  protected createModelRegistry(): { models: MutableModels } {
    const models = createModels();
    models.setProvider(createNearAiProvider(() => this.env.NEARAI_API_KEY));
    return { models };
  }

  protected resolveDefaultModel(): PiModel {
    return {
      provider: "nearai",
      id: DEFAULT_NEARAI_MODEL.id,
    };
  }

  protected createFetcher(): HttpFetcher {
    return (input, init) => fetch(input, init);
  }

  protected resolveBrowserBinding(): Pick<Fetcher, "fetch"> | undefined {
    return this.env.BROWSER;
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
    this.registry.install(createConnectorsExtension(this.connectors, fetcher));
    this.registry.install(
      createBrowserExtension(
        this.browser,
        () => this.resolveBrowserBinding(),
        this.ctx.id.toString(),
        (record) => {
          this.sockets.broadcastTakeover(record);
        },
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
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return withCors(request, new Response(null, { status: 204 }));
    }

    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return withCors(request, Response.json({ ok: true }));
    }

    if (url.pathname === "/auth/config") {
      const enabled = Boolean(env.CF_ACCESS_TEAM_DOMAIN && env.CF_ACCESS_AUD);
      const payload = AuthConfigResponseSchema.parse({
        provider: enabled ? "cloudflare_access_oauth" : "none",
        teamDomain: env.CF_ACCESS_TEAM_DOMAIN ?? null,
        aud: env.CF_ACCESS_AUD ?? null,
        clientId: env.CF_ACCESS_OAUTH_CLIENT_ID ?? null,
      });
      return withCors(request, Response.json(payload));
    }

    const identity = await verifyCloudflareAccessJwt(request, {
      teamDomain: env.CF_ACCESS_TEAM_DOMAIN,
      aud: env.CF_ACCESS_AUD,
    });

    const isDevAuthed = !identity && hasLocalDevBearerAuth(request, env);

    if (!identity && !isDevAuthed) {
      return withCors(
        request,
        Response.json({ error: "Unauthorized" }, { status: 401 }),
      );
    }

    if (url.pathname !== "/api/me/ws") {
      return withCors(
        request,
        Response.json({ error: "Not found" }, { status: 404 }),
      );
    }

    const agentId = identity?.sub ?? "personal";
    const stub = env.PersonalAgent.getByName(agentId);
    const response = await forwardToDurableObject(
      stub,
      request,
      identity?.exp ?? null,
    );
    return withCors(request, response);
  },
};
