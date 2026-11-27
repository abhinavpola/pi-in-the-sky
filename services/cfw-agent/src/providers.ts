import {
  type Api,
  type AssistantMessage,
  createAssistantMessageEventStream,
  type JsonObject,
  type Message,
  type Model,
  type TextContent,
  type ToolCall,
  type TranscriptContext,
  type Usage,
} from "@earendil-works/pi-ai";
import type { Provider } from "@earendil-works/pi-ai/models";
import type { InferenceClient } from "@nearai/inference-sdk";

const DEFAULT_NEAR_AI_CLOUD_BASE_URL = "https://cloud-api.near.ai/v1";

type NearChatCreateParams = Parameters<
  InferenceClient["chat"]["completions"]["create"]
>[0];

type NearMessageParam = NearChatCreateParams["messages"][number];
type NearToolParam = NonNullable<NearChatCreateParams["tools"]>[number];

export const DEFAULT_NEARAI_MODEL: Model<Api> = {
  id: "z-ai/glm-5.3-flash",
  name: "NEAR AI Cloud GLM 5.3 Flash (E2EE TEE)",
  api: "openai-completions",
  provider: "nearai",
  baseUrl: DEFAULT_NEAR_AI_CLOUD_BASE_URL,
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4096,
};

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractTextFromBlocks(
  content:
    string | readonly { readonly type: string; readonly text?: string }[],
): string {
  if (typeof content === "string") {
    return content;
  }
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}

function convertMessage(message: Message): NearMessageParam[] {
  switch (message.role) {
    case "system": {
      const parts: string[] = [];
      const base = extractTextFromBlocks(message.content);
      if (base) {
        parts.push(base);
      }
      if (message.sections) {
        for (const value of Object.values(message.sections)) {
          if (typeof value === "string" && value.length > 0) {
            parts.push(value);
          }
        }
      }
      return [
        {
          role: "system",
          content: parts.join("\n\n"),
        },
      ];
    }
    case "user":
      return [
        {
          role: "user",
          content: extractTextFromBlocks(message.content),
        },
      ];
    case "assistant": {
      const textParts: string[] = [];
      const toolCalls: {
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }[] = [];
      for (const block of message.content) {
        switch (block.type) {
          case "text":
            textParts.push(block.text);
            break;
          case "toolCall":
            toolCalls.push({
              id: block.id,
              type: "function",
              function: {
                name: block.name,
                arguments: JSON.stringify(block.arguments),
              },
            });
            break;
          case "thinking":
            break;
          default: {
            block satisfies never;
          }
        }
      }
      return [
        {
          role: "assistant",
          content: textParts.join("\n") || null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
      ];
    }
    case "toolResult":
      return [
        {
          role: "tool",
          tool_call_id: message.toolCallId,
          content: extractTextFromBlocks(message.content),
        },
      ];
    default: {
      message satisfies never;
      return [];
    }
  }
}

function toNearMessages(context: TranscriptContext): NearMessageParam[] {
  const out: NearMessageParam[] = [];
  for (const message of context.messages) {
    out.push(...convertMessage(message));
  }
  return out;
}

function toNearTools(context: TranscriptContext): NearToolParam[] {
  const byName = new Map<string, NearToolParam>();
  for (const message of context.messages) {
    if (message.role !== "system") {
      continue;
    }
    for (const tool of message.toolsAdded ?? []) {
      byName.set(tool.name, {
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: isJsonObject(tool.parameters) ? tool.parameters : {},
        },
      });
    }
    for (const removed of message.toolsRemoved ?? []) {
      byName.delete(removed.name);
    }
  }
  return Array.from(byName.values());
}

function parseToolArguments(raw: string): JsonObject {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isJsonObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function toUsage(usage?: {
  readonly prompt_tokens?: number;
  readonly completion_tokens?: number;
  readonly total_tokens?: number;
}): Usage {
  const input = usage?.prompt_tokens ?? 0;
  const output = usage?.completion_tokens ?? 0;
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: usage?.total_tokens ?? input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function emitContentBlock(
  stream: ReturnType<typeof createAssistantMessageEventStream>,
  item: TextContent | ToolCall,
  contentIndex: number,
  partial: AssistantMessage,
): void {
  if (item.type === "toolCall") {
    stream.push({ type: "toolcall_start", contentIndex, partial });
    stream.push({
      type: "toolcall_end",
      contentIndex,
      toolCall: item,
      partial,
    });
    return;
  }
  const text = item.text;
  stream.push({ type: "text_start", contentIndex, partial });
  stream.push({ type: "text_delta", contentIndex, delta: text, partial });
  stream.push({ type: "text_end", contentIndex, content: text, partial });
}

export function createNearAiProvider(
  resolveApiKey: () => string | undefined,
): Provider {
  const runStream = (
    model: Model<Api>,
    context: TranscriptContext,
    signal?: AbortSignal,
  ) => {
    const stream = createAssistantMessageEventStream();
    const apiKey = resolveApiKey();
    const messages = toNearMessages(context);
    const tools = toNearTools(context);

    const partial: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: toUsage(),
      stopReason: "stop",
      timestamp: Date.now(),
    };

    void (async () => {
      try {
        if (!apiKey) {
          throw new Error("NEARAI_API_KEY is not configured.");
        }
        stream.push({ type: "start", partial });
        const { InferenceClient: NearInferenceClient } =
          await import("@nearai/inference-sdk");
        const client = new NearInferenceClient({
          apiKey,
          baseUrl: DEFAULT_NEAR_AI_CLOUD_BASE_URL,
          e2ee: true,
        });
        const completion = await client.chat.completions.create(
          {
            model: model.id,
            messages,
            stream: false,
            ...(tools.length > 0 ? { tools } : {}),
          },
          signal ? { signal } : undefined,
        );
        await client.verifyResponse(completion.id);
        const choice = completion.choices[0];
        const content: Array<TextContent | ToolCall> = [];
        const text = choice?.message.content ?? "";
        if (text) {
          content.push({ type: "text", text });
        }
        for (const call of choice?.message.tool_calls ?? []) {
          if (call.type === "function") {
            content.push({
              type: "toolCall",
              id: call.id,
              name: call.function.name,
              arguments: parseToolArguments(call.function.arguments),
            });
          }
        }
        const stopReason = content.some((item) => item.type === "toolCall")
          ? "toolUse"
          : "stop";
        const finalMessage: AssistantMessage = {
          ...partial,
          content,
          usage: toUsage(completion.usage),
          stopReason,
        };
        for (const [index, item] of content.entries()) {
          emitContentBlock(stream, item, index, partial);
        }
        stream.push({
          type: "done",
          reason: stopReason,
          message: finalMessage,
        });
        stream.end(finalMessage);
      } catch (thrown) {
        const messageText =
          thrown instanceof Error ? thrown.message : String(thrown);
        const errorMessage: AssistantMessage = {
          ...partial,
          stopReason: "error",
          errorMessage: messageText,
        };
        stream.push({
          type: "error",
          reason: "error",
          error: errorMessage,
        });
        stream.end(errorMessage);
      }
    })();

    return stream;
  };

  return {
    id: "nearai",
    name: "NEAR AI Cloud (E2EE TEE)",
    auth: {
      apiKey: {
        name: "NEARAI_API_KEY",
        resolve: async () => {
          const apiKey = resolveApiKey();
          if (!apiKey) {
            return undefined;
          }
          return {
            auth: { apiKey },
            source: "env",
          };
        },
      },
    },
    getModels: () => [DEFAULT_NEARAI_MODEL],
    stream: (model, context, options) =>
      runStream(model, context, options?.signal),
    streamSimple: (model, context, options) =>
      runStream(model, context, options?.signal),
  };
}
