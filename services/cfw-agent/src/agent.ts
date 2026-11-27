import { createModels, type MutableModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { PiHarness, type PiModel } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import { createAI } from "agents/models/pi-ai";
import { WebSockets } from "agents/websockets";
import { DurableObject } from "cloudflare:workers";

import type { Env } from "../env";
import {
  type ApprovalRecord,
  ApprovalSignal,
  type ApprovalStatus,
  ApprovalStore,
  createApprovalExtension,
} from "./approvals";
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
import {
  createMemoryExtension,
  type MemoryNote,
  MemoryStore,
  type ProfileEntry,
} from "./memory";
import { createSkillsExtension } from "./skills";
import { AgentSockets } from "./sockets";

const DEFAULT_MODEL_ID = "@cf/deepseek-ai/deepseek-v4.1-flash-1017";

const SYSTEM_PREAMBLE = [
  "You are a private personal assistant running on a durable Cloudflare agent.",
  "Use memory tools to recall and persist standing user preferences and dated notes.",
  "Load a relevant skill playbook with load_skill before running multi-step workflows.",
  "Always call request_approval before checkout, booking, payment, or sending external messages.",
].join(" ");

export class PersonalAgent extends DurableObject<Env> {
  readonly memory = new MemoryStore(this.ctx.storage.sql);
  readonly approvals = new ApprovalStore(this.ctx.storage.sql);
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
      onResolveApproval: async (approvalId, approved, note) =>
        this.resolveApproval(approvalId, approved, note),
      onResumeTakeover: async (takeoverId, note) =>
        this.resumeTakeover(takeoverId, note),
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
    return ai(modelId as Parameters<typeof ai>[0]);
  }

  protected createFetcher(): typeof fetch {
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
      createApprovalExtension(this.approvals, (record) => {
        this.sockets.broadcastApproval(record);
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
    await this.sockets.reattach();
  }

  async ask(prompt: string): Promise<{
    readonly status: "done" | "unanswered";
    readonly text: string | undefined;
    readonly operationId: string;
  }> {
    const result = await this.harness.prompt(prompt);
    return {
      status: result.status,
      text: result.text,
      operationId: result.operationId,
    };
  }

  async submitPrompt(
    prompt: string,
    operationId?: string,
  ): Promise<{
    readonly operationId: string;
    readonly session: string;
    readonly accepted: boolean;
  }> {
    return this.harness.submit(prompt, { operationId });
  }

  async waitForOperation(operationId: string): Promise<{
    readonly status: "done" | "unanswered";
    readonly text: string | undefined;
    readonly operationId: string;
  }> {
    const result = await this.harness.wait(operationId);
    return {
      status: result.status,
      text: result.text,
      operationId: result.operationId,
    };
  }

  getProfile(): ProfileEntry[] {
    return this.memory.getProfile();
  }

  setProfileEntry(key: string, value: string): ProfileEntry {
    return this.memory.setProfileEntry(key, value);
  }

  addMemoryNote(content: string, category?: string, date?: string): MemoryNote {
    return this.memory.addNote(content, category, date);
  }

  searchMemoryNotes(query: string, limit?: number): MemoryNote[] {
    return this.memory.searchNotes(query, limit);
  }

  setConnectorToken(
    provider: ConnectorProvider,
    accessToken: string,
    refreshToken?: string,
    expiresAt?: number,
  ): void {
    this.connectors.setToken(provider, accessToken, refreshToken, expiresAt);
  }

  listApprovals(status?: ApprovalStatus): ApprovalRecord[] {
    return this.approvals.list(status);
  }

  async resolveApproval(
    approvalId: string,
    approved: boolean,
    note?: string,
  ): Promise<{
    readonly approvalId: string;
    readonly status: string;
    readonly delivered: string;
  }> {
    const record = this.approvals.get(approvalId);
    if (!record) {
      throw new Error(`Approval ${approvalId} not found`);
    }
    const updated = this.approvals.markResolved(approvalId, approved, note);
    const delivered = await this.harness.signal(
      record.taskId,
      ApprovalSignal,
      approvalId,
      { approved, note },
    );
    return {
      approvalId,
      status: updated?.status ?? record.status,
      delivered,
    };
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
    this.browser.markResumed(takeoverId);
    const delivered = await this.harness.signal(
      record.taskId,
      BrowserTakeoverSignal,
      takeoverId,
      { resumed: true, note },
    );
    return {
      takeoverId,
      delivered,
    };
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "POST" && path.endsWith("/prompt")) {
      const body = (await request.json()) as {
        prompt?: string;
        operationId?: string;
        async?: boolean;
      };
      if (!body.prompt || typeof body.prompt !== "string") {
        return Response.json(
          { error: "prompt string is required" },
          { status: 400 },
        );
      }
      if (body.async) {
        const receipt = await this.submitPrompt(body.prompt, body.operationId);
        return Response.json(receipt, { status: 202 });
      }
      const result = await this.ask(body.prompt);
      return Response.json(result);
    }

    if (request.method === "GET" && path.endsWith("/profile")) {
      return Response.json({ entries: this.getProfile() });
    }

    if (request.method === "PUT" && path.endsWith("/profile")) {
      const body = (await request.json()) as { key?: string; value?: string };
      if (!body.key || typeof body.value !== "string") {
        return Response.json(
          { error: "key and value are required" },
          { status: 400 },
        );
      }
      return Response.json(this.setProfileEntry(body.key, body.value));
    }

    if (request.method === "DELETE" && path.endsWith("/profile")) {
      const key = url.searchParams.get("key");
      if (!key) {
        return Response.json({ error: "key is required" }, { status: 400 });
      }
      return Response.json({ deleted: this.memory.deleteProfileEntry(key) });
    }

    const connectorMatch = path.match(/\/connectors\/(gmail|google_calendar)$/);
    if (request.method === "PUT" && connectorMatch?.[1]) {
      const body = (await request.json()) as {
        accessToken?: string;
        refreshToken?: string;
        expiresAt?: number;
      };
      if (!body.accessToken) {
        return Response.json(
          { error: "accessToken is required" },
          { status: 400 },
        );
      }
      this.setConnectorToken(
        connectorMatch[1] as ConnectorProvider,
        body.accessToken,
        body.refreshToken,
        body.expiresAt,
      );
      return Response.json({ ok: true });
    }

    if (request.method === "GET" && path.endsWith("/notes")) {
      const query = url.searchParams.get("q") ?? "";
      return Response.json({ notes: this.searchMemoryNotes(query) });
    }

    if (request.method === "POST" && path.endsWith("/notes")) {
      const body = (await request.json()) as {
        content?: string;
        category?: string;
        date?: string;
      };
      if (!body.content) {
        return Response.json({ error: "content is required" }, { status: 400 });
      }
      return Response.json(
        this.addMemoryNote(body.content, body.category, body.date),
        { status: 201 },
      );
    }

    if (request.method === "GET" && path.endsWith("/approvals")) {
      const status = url.searchParams.get("status") as ApprovalStatus | null;
      return Response.json({
        approvals: this.listApprovals(status ?? undefined),
      });
    }

    const approvalMatch = path.match(/\/approvals\/([^/]+)\/resolve$/);
    if (request.method === "POST" && approvalMatch?.[1]) {
      const body = (await request.json()) as {
        approved?: boolean;
        note?: string;
      };
      if (typeof body.approved !== "boolean") {
        return Response.json(
          { error: "approved boolean is required" },
          { status: 400 },
        );
      }
      const result = await this.resolveApproval(
        decodeURIComponent(approvalMatch[1]),
        body.approved,
        body.note,
      );
      return Response.json(result);
    }

    const takeoverMatch = path.match(/\/takeovers\/([^/]+)\/resume$/);
    if (request.method === "POST" && takeoverMatch?.[1]) {
      const body = (await request.json()) as { note?: string };
      const result = await this.resumeTakeover(
        decodeURIComponent(takeoverMatch[1]),
        body.note,
      );
      return Response.json(result);
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  }
}
