export type TabId = "chat" | "memory" | "settings";

export type ConnectionState = "disconnected" | "connecting" | "connected";

export type ConnectionConfig = {
  readonly baseUrl: string;
  readonly agentId: string;
  readonly authToken: string;
};

type ChatRole = "user" | "assistant" | "system";

export type ChatMessage = {
  readonly id: string;
  readonly role: ChatRole;
  readonly text: string;
};

export type ApprovalItem = {
  readonly id: string;
  readonly action: string;
  readonly summary: string;
  readonly details: string;
  readonly status: "pending" | "approved" | "rejected";
};

export type TakeoverItem = {
  readonly id: string;
  readonly url: string;
  readonly liveViewUrl: string | null;
  readonly reason: string;
  readonly status: "waiting" | "resumed";
};

export type ProfileEntry = {
  readonly key: string;
  readonly value: string;
  readonly updatedAt: number;
};

export type MemoryNote = {
  readonly id: number;
  readonly date: string;
  readonly category: string;
  readonly content: string;
  readonly createdAt: number;
};

export type IncomingView = {
  readonly entries?: unknown[];
  readonly pi?: {
    readonly live?: {
      readonly status?: string;
      readonly message?: { readonly content?: unknown };
      readonly error?: string;
    } | null;
  };
};

export type IncomingSocketMessage =
  | { readonly type: "hello"; readonly session: string }
  | { readonly type: "view"; readonly view: IncomingView }
  | { readonly type: "ops"; readonly ops: readonly unknown[] }
  | { readonly type: "approval_requested"; readonly approval: ApprovalItem }
  | { readonly type: "takeover_requested"; readonly takeover: TakeoverItem }
  | { readonly type: "result"; readonly id: string; readonly result: unknown }
  | { readonly type: "error"; readonly id?: string; readonly message: string };
