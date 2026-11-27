import { z } from "zod";

import type { ActivityRecord } from "./activities";
import type { ConnectorProvider } from "./connectors";
import type { MemoryNote, ProfileEntry } from "./memory";

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
  date: z.string().optional(),
});

const ResumeTakeoverBodySchema = z.object({
  note: z.string().optional(),
});

const SteerActivityBodySchema = z.object({
  instruction: z.string().min(1),
});

const CompactBodySchema = z.object({
  summary: z.string().min(1),
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

function parseJsonBody(bodyText: string): unknown {
  if (!bodyText) {
    return {};
  }
  try {
    return JSON.parse(bodyText);
  } catch {
    return null;
  }
}

type AgentRouteHandler = {
  readonly listActivities: () => Promise<ActivityRecord[]>;
  readonly steerActivity: (
    activityId: string,
    instruction: string,
  ) => Promise<{ readonly activityId: string; readonly operationId: string }>;
  readonly compactThread: (
    summary: string,
  ) => Promise<{ readonly ok: true; readonly noteId: number }>;
  readonly submitPrompt: (
    input: string,
    options?: { readonly operationId?: string; readonly session?: string },
  ) => Promise<unknown>;
  readonly getProfile: () => Promise<ProfileEntry[]>;
  readonly setProfileEntry: (
    key: string,
    value: string,
  ) => Promise<ProfileEntry>;
  readonly setConnectorToken: (
    provider: ConnectorProvider,
    accessToken: string,
    refreshToken?: string,
    expiresAt?: number,
  ) => Promise<void>;
  readonly searchMemoryNotes: (query: string) => Promise<MemoryNote[]>;
  readonly writeMemoryNote: (
    content: string,
    category?: string,
    date?: string,
  ) => Promise<MemoryNote>;
  readonly resumeTakeover: (
    takeoverId: string,
    note?: string,
  ) => Promise<{ readonly takeoverId: string; readonly delivered: string }>;
};

export async function handleAgentHttpRequest(
  request: Request,
  bodyText: string,
  agent: AgentRouteHandler,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === "GET" && path.endsWith("/activities")) {
    return Response.json({ activities: await agent.listActivities() });
  }

  const steerMatch = path.match(/\/activities\/([^/]+)\/steer$/);
  if (request.method === "POST" && steerMatch?.[1]) {
    const parsed = SteerActivityBodySchema.safeParse(parseJsonBody(bodyText));
    if (!parsed.success) {
      return Response.json(
        { error: "instruction is required" },
        { status: 400 },
      );
    }
    return Response.json(
      await agent.steerActivity(
        decodeURIComponent(steerMatch[1]),
        parsed.data.instruction,
      ),
    );
  }

  if (request.method === "POST" && path.endsWith("/compact")) {
    const parsed = CompactBodySchema.safeParse(parseJsonBody(bodyText));
    if (!parsed.success) {
      return Response.json({ error: "summary is required" }, { status: 400 });
    }
    return Response.json(await agent.compactThread(parsed.data.summary));
  }

  if (request.method === "POST" && path.endsWith("/prompt")) {
    const parsed = PromptBodySchema.safeParse(parseJsonBody(bodyText));
    if (!parsed.success) {
      return Response.json({ error: "input is required" }, { status: 400 });
    }
    const receipt = await agent.submitPrompt(parsed.data.input, {
      operationId: parsed.data.operationId,
      session: parsed.data.sessionId,
    });
    return Response.json(receipt, { status: 202 });
  }

  if (request.method === "GET" && path.endsWith("/profile")) {
    return Response.json({ entries: await agent.getProfile() });
  }

  if (request.method === "PUT" && path.endsWith("/profile")) {
    const parsed = ProfileBodySchema.safeParse(parseJsonBody(bodyText));
    if (!parsed.success) {
      return Response.json({ error: "key is required" }, { status: 400 });
    }
    return Response.json(
      await agent.setProfileEntry(parsed.data.key, parsed.data.value),
    );
  }

  const connectorMatch = path.match(/\/connectors\/([^/]+)\/token$/);
  if (request.method === "PUT" && connectorMatch?.[1]) {
    const provider = parseConnectorProvider(connectorMatch[1]);
    if (!provider) {
      return Response.json(
        { error: "Unknown connector provider" },
        { status: 400 },
      );
    }
    const parsed = ConnectorBodySchema.safeParse(parseJsonBody(bodyText));
    if (!parsed.success) {
      return Response.json(
        { error: "accessToken is required" },
        { status: 400 },
      );
    }
    await agent.setConnectorToken(
      provider,
      parsed.data.accessToken,
      parsed.data.refreshToken,
      parsed.data.expiresAt,
    );
    return Response.json({ ok: true });
  }

  if (request.method === "GET" && path.endsWith("/notes")) {
    const query = url.searchParams.get("q") ?? "";
    return Response.json({ notes: await agent.searchMemoryNotes(query) });
  }

  if (request.method === "POST" && path.endsWith("/notes")) {
    const parsed = NoteBodySchema.safeParse(parseJsonBody(bodyText));
    if (!parsed.success) {
      return Response.json({ error: "content is required" }, { status: 400 });
    }
    return Response.json(
      await agent.writeMemoryNote(
        parsed.data.content,
        parsed.data.category,
        parsed.data.date,
      ),
      { status: 201 },
    );
  }

  const takeoverMatch = path.match(/\/takeovers\/([^/]+)\/resume$/);
  if (request.method === "POST" && takeoverMatch?.[1]) {
    const parsed = ResumeTakeoverBodySchema.safeParse(parseJsonBody(bodyText));
    const note = parsed.success ? parsed.data.note : undefined;
    return Response.json(
      await agent.resumeTakeover(decodeURIComponent(takeoverMatch[1]), note),
    );
  }

  return Response.json({ error: "Not found" }, { status: 404 });
}
