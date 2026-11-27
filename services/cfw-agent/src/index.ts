import { createModels, type MutableModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { PiHarness, type PiModel, type PiReceipt } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import { createAI } from "agents/models/pi-ai";
import { WebSockets } from "agents/websockets";
import { DurableObject } from "cloudflare:workers";
import { z } from "zod";

import type { Env } from "../env";
import {
  BrowserStore,
  BrowserTakeoverSignal,
  createBrowserExtension,
} from "./browser";
import {
  type ConnectorProvider,
  ConnectorStore,
  createConnectorsExtension,
} from "./connectors";
import type { HttpFetcher } from "./http-tool";
import {
  createMemoryExtension,
  type MemoryNote,
  MemoryStore,
  type ProfileEntry,
} from "./memory";
import { createSkillsExtension } from "./skills";
import { AgentSockets } from "./sockets";

const DEFAULT_MODEL_ID = "@cf/moonshotai/kimi-k2.5";

const SYSTEM_PREAMBLE = [
  "You are a private, autonomous personal AI assistant running durably on Cloudflare.",
  "Use your memory tools to recall and update durable user preferences and dated notes.",
  "Use load_skill when a relevant bundled playbook exists.",
  "Ask the user in chat for permission whenever an action is irreversible, involves spending money, or sends external communications.",
  "If a website requires sign-in, CAPTCHA, or MFA, call browser_request_takeover so the user can complete it in Live View.",
].join("\n");

const PromptBodySchema = z.object({
  input: z.string().min(1),
  operationId: z.string().optional(),
  sessionId: z.string().optional(),
});

const ProfileBodySchema = z.object({
  key: z.string().min(1),
  value: z.string(),
});

const ConnectorBodySchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().optional(),
  expiresAt: z.number().optional(),
});

const NoteBodySchema = z.object({
  content: z.string().min(1),
  category: z.string().optional(),
});

const ResumeTakeoverBodySchema = z.object({
  note: z.string().optional(),
});

function parseConnectorProvider(value: string): ConnectorProvider | null {
  switch (value) {
    case "gmail":
    case "google_calendar":
      return value;
    default:
      return null;
  }
}

function isAuthorized(request: Request, env: Env): boolean {
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
  headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export class PersonalAgent extends DurableObject<Env> {
  readonly memory = new MemoryStore(this.ctx.storage.sql);
  readonly connectors = new ConnectorStore(this.ctx.storage.sql);
  readonly browser = new BrowserStore(this.ctx.storage.sql);
  readonly registry = createRegistry();

  readonly harness = new PiHarness({
    harness: async ({ storage, context, onWake }) => {
      this.#installExtensions();
      const { models } = this.createModelRegistry();
      return Harness.open(
        storage,
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
    },
  );

  readonly webSockets = new WebSockets(this.sockets.options());

  readonly lifecycle = Lifecycle.install(this)
    .use(this.webSockets)
    .use(this.harness);

  #extensionsInstalled = false;

  protected createModelRegistry(): { models: MutableModels } {
    const ai = createAI({ binding: this.env.AI });
    const models = createModels();
    models.setProvider(ai.provider);
    return { models };
  }

  protected resolveDefaultModel(): PiModel {
    const ai = createAI({ binding: this.env.AI });
    const modelId = this.env.DEFAULT_MODEL ?? DEFAULT_MODEL_ID;
    return ai(modelId);
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

  submitPrompt(
    input: string,
    options?: { readonly operationId?: string; readonly session?: string },
  ): Promise<PiReceipt> {
    return this.harness.submit(input, {
      operationId: options?.operationId,
      session: options?.session,
    });
  }

  getProfile(): ProfileEntry[] {
    return this.memory.getProfile();
  }

  setProfileEntry(key: string, value: string): ProfileEntry {
    return this.memory.setProfileEntry(key, value);
  }

  searchMemoryNotes(query: string, limit = 10): MemoryNote[] {
    return this.memory.searchNotes(query, limit);
  }

  writeMemoryNote(content: string, category = "general"): MemoryNote {
    return this.memory.addNote(content, category);
  }

  setConnectorToken(
    provider: ConnectorProvider,
    accessToken: string,
    refreshToken?: string,
    expiresAt?: number,
  ): void {
    this.connectors.setToken(provider, accessToken, refreshToken, expiresAt);
  }

  async resumeTakeover(
    takeoverId: string,
    note?: string,
  ): Promise<{
    readonly takeoverId: string;
    readonly delivered: string;
  }> {
    const record = this.browser.getTakeover(takeoverId);
    if (!record) {
      throw new Error(`Takeover ${takeoverId} not found`);
    }
    const payload =
      note !== undefined ? { resumed: true, note } : { resumed: true };
    const delivered = await this.harness.signal(
      record.taskId,
      BrowserTakeoverSignal,
      takeoverId,
      payload,
    );
    this.browser.markResumed(takeoverId);
    return {
      takeoverId,
      delivered,
    };
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "POST" && path.endsWith("/prompt")) {
      const parsed = PromptBodySchema.safeParse(await request.json());
      if (!parsed.success) {
        return Response.json({ error: "input is required" }, { status: 400 });
      }
      const receipt = await this.submitPrompt(parsed.data.input, {
        operationId: parsed.data.operationId,
        session: parsed.data.sessionId,
      });
      return Response.json(receipt, { status: 202 });
    }

    if (request.method === "GET" && path.endsWith("/profile")) {
      return Response.json({ entries: this.getProfile() });
    }

    if (request.method === "PUT" && path.endsWith("/profile")) {
      const parsed = ProfileBodySchema.safeParse(await request.json());
      if (!parsed.success) {
        return Response.json(
          { error: "key and value are required" },
          { status: 400 },
        );
      }
      return Response.json(
        this.setProfileEntry(parsed.data.key, parsed.data.value),
      );
    }

    if (request.method === "DELETE" && path.endsWith("/profile")) {
      const key = url.searchParams.get("key");
      if (!key) {
        return Response.json({ error: "key is required" }, { status: 400 });
      }
      return Response.json({ deleted: this.memory.deleteProfileEntry(key) });
    }

    const connectorMatch = path.match(/\/connectors\/([^/]+)$/);
    if (request.method === "PUT" && connectorMatch?.[1]) {
      const provider = parseConnectorProvider(connectorMatch[1]);
      if (!provider) {
        return Response.json({ error: "Unknown provider" }, { status: 400 });
      }
      const parsed = ConnectorBodySchema.safeParse(await request.json());
      if (!parsed.success) {
        return Response.json(
          { error: "accessToken is required" },
          { status: 400 },
        );
      }
      this.setConnectorToken(
        provider,
        parsed.data.accessToken,
        parsed.data.refreshToken,
        parsed.data.expiresAt,
      );
      return Response.json({ ok: true });
    }

    if (request.method === "GET" && path.endsWith("/notes")) {
      const query = url.searchParams.get("q") ?? "";
      return Response.json({ notes: this.searchMemoryNotes(query) });
    }

    if (request.method === "POST" && path.endsWith("/notes")) {
      const parsed = NoteBodySchema.safeParse(await request.json());
      if (!parsed.success) {
        return Response.json({ error: "content is required" }, { status: 400 });
      }
      return Response.json(
        this.writeMemoryNote(parsed.data.content, parsed.data.category),
        { status: 201 },
      );
    }

    const takeoverMatch = path.match(/\/takeovers\/([^/]+)\/resume$/);
    if (request.method === "POST" && takeoverMatch?.[1]) {
      const parsed = ResumeTakeoverBodySchema.safeParse(
        await request.json().catch(() => ({})),
      );
      const note = parsed.success ? parsed.data.note : undefined;
      try {
        const result = await this.resumeTakeover(takeoverMatch[1], note);
        return Response.json(result);
      } catch (thrown) {
        return Response.json(
          { error: thrown instanceof Error ? thrown.message : String(thrown) },
          { status: 404 },
        );
      }
    }

    return Response.json({ error: "Not found" }, { status: 404 });
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

    if (!isAuthorized(request, env)) {
      return withCors(
        Response.json({ error: "Unauthorized" }, { status: 401 }),
      );
    }

    const agentMatch = url.pathname.match(/^\/api\/agents\/([^/]+)(\/.*)?$/);
    if (agentMatch?.[1]) {
      const agentId = decodeURIComponent(agentMatch[1]);
      const stub = env.PersonalAgent.getByName(agentId);
      const response = await stub.fetch(request);
      return withCors(response);
    }

    return withCors(Response.json({ error: "Not found" }, { status: 404 }));
  },
};
