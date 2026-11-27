import type { Extension, ToolRegistration } from "@earendil-works/pi-durable";
import { obj, opt, str } from "@earendil-works/pi-schema";
import type { PiHarness, PiSessionId } from "agents/harness/pi";
import { z } from "zod";

import type { VaultCipher } from "./vault";

type ActivityStatus =
  "running" | "waiting_input" | "completed" | "failed" | "cancelled";

export type ActivityRecord = {
  readonly id: string;
  readonly sessionId: PiSessionId;
  readonly title: string;
  readonly summary: string;
  readonly status: ActivityStatus;
  readonly collapsed: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
};

type ActivityRow = {
  id: string;
  session_id: string;
  status: ActivityStatus;
  collapsed: number;
  payload_enc: string;
  created_at: number;
  updated_at: number;
};

const ActivityPayloadSchema = z.object({
  title: z.string(),
  summary: z.string(),
});

export class ActivityStore {
  readonly #sql: SqlStorage;
  readonly #vault: VaultCipher;

  constructor(sql: SqlStorage, vault: VaultCipher) {
    this.#sql = sql;
    this.#vault = vault;
    this.#sql.exec(`
      CREATE TABLE IF NOT EXISTS activities_vault (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        status TEXT NOT NULL,
        collapsed INTEGER NOT NULL,
        payload_enc TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  async createActivity(input: {
    readonly id: string;
    readonly sessionId: PiSessionId;
    readonly title: string;
    readonly summary: string;
  }): Promise<ActivityRecord> {
    const now = Date.now();
    const encrypted = await this.#vault.encryptText(
      JSON.stringify({ title: input.title, summary: input.summary }),
      `activities:${input.id}`,
    );
    this.#sql.exec(
      `INSERT INTO activities_vault (
        id, session_id, status, collapsed, payload_enc, created_at, updated_at
      ) VALUES (?, ?, 'running', 0, ?, ?, ?)`,
      input.id,
      input.sessionId,
      encrypted,
      now,
      now,
    );
    return {
      id: input.id,
      sessionId: input.sessionId,
      title: input.title,
      summary: input.summary,
      status: "running",
      collapsed: false,
      createdAt: now,
      updatedAt: now,
    };
  }

  async #toRecord(row: ActivityRow): Promise<ActivityRecord> {
    const decrypted = await this.#vault.decryptText(
      row.payload_enc,
      `activities:${row.id}`,
    );
    const payload = ActivityPayloadSchema.parse(JSON.parse(decrypted));
    return {
      id: row.id,
      sessionId: row.session_id,
      title: payload.title,
      summary: payload.summary,
      status: row.status,
      collapsed: row.collapsed === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async getActivity(id: string): Promise<ActivityRecord | undefined> {
    const row = this.#sql
      .exec<ActivityRow>(
        "SELECT id, session_id, status, collapsed, payload_enc, created_at, updated_at FROM activities_vault WHERE id = ?",
        id,
      )
      .toArray()[0];
    if (!row) {
      return undefined;
    }
    return this.#toRecord(row);
  }

  async listActivities(limit = 50): Promise<ActivityRecord[]> {
    const clamped = Math.max(1, Math.min(limit, 100));
    const rows = this.#sql
      .exec<ActivityRow>(
        "SELECT id, session_id, status, collapsed, payload_enc, created_at, updated_at FROM activities_vault ORDER BY updated_at DESC LIMIT ?",
        clamped,
      )
      .toArray();
    const results: ActivityRecord[] = [];
    for (const row of rows) {
      results.push(await this.#toRecord(row));
    }
    return results;
  }

  async updateActivity(
    id: string,
    patch: {
      readonly status?: ActivityStatus;
      readonly summary?: string;
      readonly collapsed?: boolean;
    },
  ): Promise<ActivityRecord | undefined> {
    const existing = await this.getActivity(id);
    if (!existing) {
      return undefined;
    }
    const nextStatus = patch.status ?? existing.status;
    const nextSummary = patch.summary ?? existing.summary;
    const nextCollapsed = patch.collapsed ?? existing.collapsed;
    const now = Date.now();
    const encrypted = await this.#vault.encryptText(
      JSON.stringify({ title: existing.title, summary: nextSummary }),
      `activities:${id}`,
    );
    this.#sql.exec(
      `UPDATE activities_vault
       SET status = ?, collapsed = ?, payload_enc = ?, updated_at = ?
       WHERE id = ?`,
      nextStatus,
      nextCollapsed ? 1 : 0,
      encrypted,
      now,
      id,
    );
    return {
      ...existing,
      status: nextStatus,
      summary: nextSummary,
      collapsed: nextCollapsed,
      updatedAt: now,
    };
  }

  async renderActivitiesSummary(): Promise<string> {
    const activities = await this.listActivities(15);
    if (activities.length === 0) {
      return "No background activities yet.";
    }
    return activities
      .map(
        (item) =>
          `- [${item.status}] (${item.id} / session ${item.sessionId}) ${item.title}: ${item.summary}`,
      )
      .join("\n");
  }
}

const SpawnActivitySchema = obj({
  title: str(),
  instructions: str(),
  summary: opt(str()),
});

const SteerActivitySchema = obj({
  activityId: str(),
  instruction: str(),
});

const CompleteActivitySchema = obj({
  activityId: str(),
  summary: str(),
});

const ListActivitiesSchema = obj({
  status: opt(str()),
});

export function createActivitiesExtension(
  store: ActivityStore,
  harness: PiHarness,
  onActivityChanged: (record: ActivityRecord) => void,
): Extension {
  const spawnTool: ToolRegistration<typeof SpawnActivitySchema> = {
    name: "activity_spawn",
    description:
      "Spawn a dedicated background subagent Pi session for a multi-step task, posting an Activity card in the stream while keeping the main conversation free.",
    parameters: SpawnActivitySchema,
    replay: "unsafe",
    async execute({ title, instructions, summary }) {
      const childSession = await harness.sessions.create();
      const activityId = `act-${childSession.id}`;
      const record = await store.createActivity({
        id: activityId,
        sessionId: childSession.id,
        title,
        summary: summary ?? "Started background work.",
      });
      onActivityChanged(record);
      const subagentPrompt = [
        `Activity ID: ${activityId}`,
        `Title: ${title}`,
        `Task: ${instructions}`,
        `When finished, call activity_complete with activityId "${activityId}" and a concise summary of the result.`,
      ].join("\n");
      const receipt = await childSession.submit(subagentPrompt, {
        operationId: `spawn-${activityId}`,
      });
      return {
        output: [
          {
            type: "text",
            text: JSON.stringify({
              activity: record,
              operationId: receipt.operationId,
            }),
          },
        ],
      };
    },
  };

  const steerTool: ToolRegistration<typeof SteerActivitySchema> = {
    name: "activity_steer",
    description:
      "Send a follow-up or steering instruction to an existing background activity's subagent session.",
    parameters: SteerActivitySchema,
    replay: "unsafe",
    async execute({ activityId, instruction }) {
      const existing = await store.getActivity(activityId);
      if (!existing) {
        return {
          isError: true,
          output: [{ type: "text", text: `Unknown activityId: ${activityId}` }],
        };
      }
      const receipt = await harness
        .session(existing.sessionId)
        .submit(instruction, { whenBusy: "steer" });
      const updated = await store.updateActivity(activityId, {
        status: "running",
        collapsed: false,
      });
      if (updated) {
        onActivityChanged(updated);
      }
      return {
        output: [
          {
            type: "text",
            text: JSON.stringify({
              activityId,
              sessionId: existing.sessionId,
              operationId: receipt.operationId,
            }),
          },
        ],
      };
    },
  };

  const completeTool: ToolRegistration<typeof CompleteActivitySchema> = {
    name: "activity_complete",
    description:
      "Mark a background activity as completed with a concise summary so it collapses cleanly in the user's continuous stream.",
    parameters: CompleteActivitySchema,
    replay: "safe",
    async execute({ activityId, summary }) {
      const updated = await store.updateActivity(activityId, {
        status: "completed",
        summary,
        collapsed: true,
      });
      if (!updated) {
        return {
          isError: true,
          output: [{ type: "text", text: `Unknown activityId: ${activityId}` }],
        };
      }
      onActivityChanged(updated);
      return {
        output: [{ type: "text", text: JSON.stringify(updated) }],
      };
    },
  };

  const listTool: ToolRegistration<typeof ListActivitiesSchema> = {
    name: "activity_list",
    description:
      "List current and past background activities to check status, resolve ambiguous user references, or recall prior results.",
    parameters: ListActivitiesSchema,
    replay: "safe",
    async execute({ status }) {
      const all = await store.listActivities(30);
      const filtered = status
        ? all.filter((item) => item.status === status)
        : all;
      return {
        output: [
          { type: "text", text: JSON.stringify({ activities: filtered }) },
        ],
      };
    },
  };

  return {
    name: "activities",
    tools: [spawnTool, steerTool, completeTool, listTool],
    sections: [
      {
        key: "active-activities",
        render: () => store.renderActivitiesSummary(),
      },
    ],
  };
}
