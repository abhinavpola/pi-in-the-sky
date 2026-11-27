import type { PiHarness } from "agents/harness/pi";
import { z } from "zod";

import type { ActivityStore } from "./activities";
import { ConnectorProviderSchema, type ConnectorStore } from "./connectors";
import type { MemoryStore } from "./memory";

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

function parseBody<T>(
  schema: z.ZodType<T>,
  bodyText: string,
  errorMessage: string,
):
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly response: Response } {
  let raw: unknown = {};
  if (bodyText) {
    try {
      raw = JSON.parse(bodyText);
    } catch {
      return {
        ok: false,
        response: Response.json({ error: errorMessage }, { status: 400 }),
      };
    }
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      response: Response.json({ error: errorMessage }, { status: 400 }),
    };
  }
  return { ok: true, data: parsed.data };
}

type AgentRouteContext = {
  readonly activities: ActivityStore;
  readonly memory: MemoryStore;
  readonly connectors: ConnectorStore;
  readonly harness: PiHarness;
  steerActivity(
    activityId: string,
    instruction: string,
  ): Promise<{ readonly activityId: string; readonly operationId: string }>;
  compactThread(
    summary: string,
  ): Promise<{ readonly ok: true; readonly noteId: number }>;
  resumeTakeover(
    takeoverId: string,
    note?: string,
  ): Promise<{ readonly takeoverId: string; readonly delivered: string }>;
};

export async function handleAgentHttpRequest(
  request: Request,
  bodyText: string,
  agent: AgentRouteContext,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === "GET" && path.endsWith("/activities")) {
    return Response.json({
      activities: await agent.activities.listActivities(),
    });
  }

  const steerMatch = path.match(/\/activities\/([^/]+)\/steer$/);
  if (request.method === "POST" && steerMatch?.[1]) {
    const body = parseBody(
      SteerActivityBodySchema,
      bodyText,
      "instruction is required",
    );
    if (!body.ok) {
      return body.response;
    }
    return Response.json(
      await agent.steerActivity(
        decodeURIComponent(steerMatch[1]),
        body.data.instruction,
      ),
    );
  }

  if (request.method === "POST" && path.endsWith("/compact")) {
    const body = parseBody(CompactBodySchema, bodyText, "summary is required");
    if (!body.ok) {
      return body.response;
    }
    return Response.json(await agent.compactThread(body.data.summary));
  }

  if (request.method === "POST" && path.endsWith("/prompt")) {
    const body = parseBody(PromptBodySchema, bodyText, "input is required");
    if (!body.ok) {
      return body.response;
    }
    const receipt = await agent.harness.submit(body.data.input, {
      operationId: body.data.operationId,
      session: body.data.sessionId,
    });
    return Response.json(receipt, { status: 202 });
  }

  if (request.method === "GET" && path.endsWith("/profile")) {
    return Response.json({ entries: await agent.memory.getProfile() });
  }

  if (request.method === "PUT" && path.endsWith("/profile")) {
    const body = parseBody(ProfileBodySchema, bodyText, "key is required");
    if (!body.ok) {
      return body.response;
    }
    return Response.json(
      await agent.memory.setProfileEntry(body.data.key, body.data.value),
    );
  }

  const connectorMatch = path.match(/\/connectors\/([^/]+)\/token$/);
  if (request.method === "PUT" && connectorMatch?.[1]) {
    const provider = ConnectorProviderSchema.safeParse(connectorMatch[1]);
    if (!provider.success) {
      return Response.json(
        { error: "Unknown connector provider" },
        { status: 400 },
      );
    }
    const body = parseBody(
      ConnectorBodySchema,
      bodyText,
      "accessToken is required",
    );
    if (!body.ok) {
      return body.response;
    }
    await agent.connectors.setToken(
      provider.data,
      body.data.accessToken,
      body.data.refreshToken,
      body.data.expiresAt,
    );
    return Response.json({ ok: true });
  }

  if (request.method === "GET" && path.endsWith("/notes")) {
    const query = url.searchParams.get("q") ?? "";
    return Response.json({ notes: await agent.memory.searchNotes(query) });
  }

  if (request.method === "POST" && path.endsWith("/notes")) {
    const body = parseBody(NoteBodySchema, bodyText, "content is required");
    if (!body.ok) {
      return body.response;
    }
    return Response.json(
      await agent.memory.addNote(
        body.data.content,
        body.data.category,
        body.data.date,
      ),
      { status: 201 },
    );
  }

  const takeoverMatch = path.match(/\/takeovers\/([^/]+)\/resume$/);
  if (request.method === "POST" && takeoverMatch?.[1]) {
    const body = parseBody(ResumeTakeoverBodySchema, bodyText, "Invalid body");
    const note = body.ok ? body.data.note : undefined;
    return Response.json(
      await agent.resumeTakeover(decodeURIComponent(takeoverMatch[1]), note),
    );
  }

  return Response.json({ error: "Not found" }, { status: 404 });
}
