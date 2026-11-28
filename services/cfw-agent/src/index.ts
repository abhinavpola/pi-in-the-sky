import { createModels, type MutableModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { AuthConfigResponseSchema } from "@pi-in-the-sky/client/protocol";
import { err, ok, type Result } from "@pi-in-the-sky/result-monad";
import { PiHarness, type PiModel, ROOT_SESSION } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import { WebSockets } from "agents/websockets";
import { DurableObject } from "cloudflare:workers";

import type { Env } from "../env";
import { verifyCloudflareAccessJwt } from "./access-auth";
import { ActivityStore, createActivitiesExtension } from "./activities";
import {
  type BrowserExecutor,
  BrowserStore,
  BrowserTakeoverSignal,
  createBrowserExtension,
  createPuppeteerBrowserExecutor,
} from "./browser";
import { ConnectorStore, createConnectorsExtension } from "./connectors";
import { createExtensionsExtension } from "./extensions";
import {
  forwardToDurableObject,
  hasWorkerBearerAuth,
  withCors,
} from "./http-auth";
import type { HttpFetcher } from "./http-tool";
import { createMemoryExtension, MemoryStore } from "./memory";
import { createNearAiProvider, DEFAULT_NEARAI_MODEL } from "./providers";
import { createSkillsExtension } from "./skills";
import { AgentSockets } from "./sockets";

const SYSTEM_PREAMBLE = [
  "You are a private, autonomous personal AI assistant running durably on Cloudflare with attested TEE inference.",
  "This is one continuous conversation with your user—never ask them to pick a thread or start a new chat.",
  "For multi-step or backgroundable tasks (trip research, inbox triage, bookings, monitoring), call activity_spawn to launch a dedicated subagent session so the main stream stays responsive.",
  "When the user sends a follow-up that could apply to more than one active activity, ask a brief clarifying question before steering.",
  "Use your memory tools to recall and update durable user preferences and dated notes.",
  "Use load_skill when a relevant bundled playbook exists.",
  "Ask the user in chat for permission whenever an action is irreversible, involves spending money, or sends external communications.",
  "If a website requires sign-in, CAPTCHA, or MFA, call browser_request_takeover so the user can complete it in Live View.",
  "When you need a reusable custom feature, tool, skill, or stateful handler, write TypeScript/Markdown files into your extension/ workspace via extension_write_file (Cloudflare Artifacts) and execute them in a Dynamic Worker (or Durable Object facet for persistent per-feature SQLite state) via extension_run.",
].join("\n");

export class PersonalAgent extends DurableObject<Env> {
  readonly memory = new MemoryStore(this.ctx.storage.sql);
  readonly connectors = new ConnectorStore(this.ctx.storage.sql);
  readonly browser = new BrowserStore(this.ctx.storage.sql);
  readonly activities = new ActivityStore(this.ctx.storage.sql);
  readonly registry = createRegistry();

  readonly harness = new PiHarness({
    harness: ({ storage, context, onWake }) => {
      this.#installExtensions();
      return Harness.open(
        storage,
        {
          models: this.createModelRegistry().models,
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
    (socket) => this.ctx.getTags(socket),
    {
      onResumeTakeover: async (takeoverId, note) =>
        this.resumeTakeover(takeoverId, note),
      onClearWaitingTakeovers: (conversationId) =>
        this.browser.clearWaitingTakeovers(conversationId),
      listWaitingTakeovers: async () => this.browser.listWaitingTakeovers(),
      listActivities: async () => this.activities.listActivities(),
      onSteerActivity: (activityId, instruction) =>
        this.steerActivity(activityId, instruction),
      onToggleActivity: (activityId, collapsed) =>
        this.toggleActivity(activityId, collapsed),
      onCompactThread: (summary) => this.compactThread(summary),
      onGetProfile: async () => ({
        entries: this.memory.getProfile(),
      }),
      onSetProfile: async (key, value) => {
        this.memory.setProfileEntry(key, value);
        return { ok: true };
      },
      onSearchNotes: async (query, limit) => ({
        notes: this.memory.searchNotes(query ?? "", limit ?? 20),
      }),
      onAddNote: async (content, category) =>
        this.memory.addNote(content, category ?? "general"),
      onSetConnectorToken: async (
        provider,
        accessToken,
        refreshToken,
        expiresAt,
      ) => {
        this.connectors.setToken(
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

  protected createBrowserExecutor(): BrowserExecutor {
    return createPuppeteerBrowserExecutor(() => this.env.BROWSER, this.browser);
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
    this.registry.install(
      createConnectorsExtension(this.connectors, this.createFetcher()),
    );
    this.registry.install(
      createBrowserExtension(
        this.browser,
        this.createBrowserExecutor(),
        (record) => {
          this.sockets.broadcastTakeover(record);
        },
      ),
    );
    this.registry.install(
      createExtensionsExtension(
        () => this.env.ARTIFACTS,
        () => this.env.LOADER,
        () => this.ctx.facets,
        this.ctx.id.toString(),
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
  ): Promise<
    Result<
      {
        readonly takeoverId: string;
        readonly delivered: string;
      },
      string
    >
  > {
    const record = this.browser.getTakeover(takeoverId);
    if (!record) {
      return err(`Unknown takeoverId: ${takeoverId}`);
    }
    const signalResult = await this.harness.signal(
      record.taskId,
      BrowserTakeoverSignal,
      takeoverId,
      { resumed: true, ...(note !== undefined ? { note } : {}) },
    );
    this.browser.markResumed(takeoverId);
    return ok({
      takeoverId,
      delivered: signalResult,
    });
  }

  async steerActivity(
    activityId: string,
    instruction: string,
  ): Promise<
    Result<
      {
        readonly activityId: string;
        readonly operationId: string;
      },
      string
    >
  > {
    const record = this.activities.getActivity(activityId);
    if (!record) {
      return err(`Unknown activityId: ${activityId}`);
    }
    const receipt = await this.harness
      .session(record.sessionId)
      .submit(instruction, { whenBusy: "steer" });
    const updated = this.activities.updateActivity(activityId, {
      status: "running",
      collapsed: false,
    });
    if (updated) {
      this.sockets.broadcastActivity(updated);
    }
    return ok({
      activityId,
      operationId: receipt.operationId,
    });
  }

  async toggleActivity(
    activityId: string,
    collapsed: boolean,
  ): Promise<
    Result<{ readonly activityId: string; readonly collapsed: boolean }, string>
  > {
    const updated = this.activities.updateActivity(activityId, {
      collapsed,
    });
    if (!updated) {
      return err(`Unknown activityId: ${activityId}`);
    }
    this.sockets.broadcastActivity(updated);
    return ok({ activityId, collapsed: updated.collapsed });
  }

  async compactThread(
    summary: string,
  ): Promise<{ readonly ok: true; readonly noteId: number }> {
    const note = this.memory.addNote(summary, "compaction");
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

    const isBearerAuthed = !identity && hasWorkerBearerAuth(request, env);

    if (!identity && !isBearerAuthed) {
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
