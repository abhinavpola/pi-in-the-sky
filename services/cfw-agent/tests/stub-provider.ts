import {
  type Api,
  type AssistantMessage,
  createAssistantMessageEventStream,
  type JsonObject,
  type Model,
  type TextContent,
  type ToolCall,
  type TranscriptContext,
  type Usage,
} from "@earendil-works/pi-ai";
import type { Provider } from "@earendil-works/pi-ai/models";

type ScriptedToolCall = {
  readonly id: string;
  readonly name: string;
  readonly arguments: JsonObject;
};

export type ScriptedTurn = {
  readonly text?: string;
  readonly toolCalls?: readonly ScriptedToolCall[];
};

const ZERO_USAGE: Usage = {
  input: 10,
  output: 10,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 20,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

export const STUB_MODEL: Model<Api> = {
  id: "stub-model",
  name: "Stub Model",
  api: "openai-completions",
  provider: "stub",
  baseUrl: "https://stub.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4096,
};

export function createStubProvider(
  nextTurn: (context: TranscriptContext) => ScriptedTurn,
): Provider {
  const runStream = (model: Model<Api>, context: TranscriptContext) => {
    const stream = createAssistantMessageEventStream();
    const turn = nextTurn(context);
    const content: Array<TextContent | ToolCall> = [];

    if (turn.text) {
      content.push({ type: "text", text: turn.text });
    }
    for (const call of turn.toolCalls ?? []) {
      content.push({
        type: "toolCall",
        id: call.id,
        name: call.name,
        arguments: call.arguments,
      });
    }

    const stopReason =
      turn.toolCalls && turn.toolCalls.length > 0 ? "toolUse" : "stop";

    const partial: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: ZERO_USAGE,
      stopReason,
      timestamp: Date.now(),
    };

    const finalMessage: AssistantMessage = {
      ...partial,
      content,
    };

    queueMicrotask(() => {
      stream.push({ type: "start", partial });
      content.forEach((item, index) => {
        if (item.type === "text") {
          stream.push({ type: "text_start", contentIndex: index, partial });
          stream.push({
            type: "text_delta",
            contentIndex: index,
            delta: item.text,
            partial,
          });
          stream.push({
            type: "text_end",
            contentIndex: index,
            content: item.text,
            partial,
          });
        } else {
          stream.push({ type: "toolcall_start", contentIndex: index, partial });
          stream.push({
            type: "toolcall_end",
            contentIndex: index,
            toolCall: item,
            partial,
          });
        }
      });
      stream.push({ type: "done", reason: stopReason, message: finalMessage });
      stream.end(finalMessage);
    });

    return stream;
  };

  return {
    id: "stub",
    name: "Stub Inference Provider",
    auth: {
      apiKey: {
        name: "Stub API key",
        resolve: async () => ({
          auth: { apiKey: "stub-key" },
          source: "stub",
        }),
      },
    },
    getModels: () => [STUB_MODEL],
    stream: (model, context) => runStream(model, context),
    streamSimple: (model, context) => runStream(model, context),
  };
}
