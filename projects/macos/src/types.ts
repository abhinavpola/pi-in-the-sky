export type ViewMode = "stream" | "memory" | "settings";

export type ConnectionState = "disconnected" | "connecting" | "connected";

export type ConnectionConfig = {
  readonly baseUrl: string;
  readonly agentId: string;
  readonly authToken: string;
};

type ChatRole = "user" | "assistant";

export type ChatMessage = {
  readonly id: string;
  readonly role: ChatRole;
  readonly text: string;
};

export type ActivityStatus =
  "running" | "waiting_input" | "completed" | "failed" | "cancelled";

export type ActivityItem = {
  readonly id: string;
  readonly sessionId: string;
  readonly title: string;
  readonly summary: string;
  readonly status: ActivityStatus;
  readonly collapsed: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
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
      readonly message?: { readonly content?: unknown };
      readonly error?: string;
    } | null;
  };
};

export type IncomingSocketMessage =
  | { readonly type: "hello"; readonly activities: readonly ActivityItem[] }
  | { readonly type: "view"; readonly view: IncomingView }
  | { readonly type: "ops" }
  | { readonly type: "takeover_requested"; readonly takeover: TakeoverItem }
  | { readonly type: "activity_updated"; readonly activity: ActivityItem }
  | { readonly type: "result" }
  | { readonly type: "error"; readonly message: string };
