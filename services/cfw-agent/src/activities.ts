import type { Extension, ToolRegistration } from "@earendil-works/pi-durable";
import { obj, opt, str } from "@earendil-works/pi-schema";
import {
  type ActivityRecord,
  type ActivityStatus,
} from "@pi-in-the-sky/client/protocol";
import type { PiHarness, PiSessionId } from "agents/harness/pi";

import { errorToolResult, jsonToolResult } from "./http-tool";

type ActivityRow = {
  id: string;
  session_id: string;
  title: string;
  summary: string;
  status: ActivityStatus;
  collapsed: number;
  created_at: number;
  updated_at: number;
};

export class ActivityStore {
  readonly #sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
    this.#sql.exec(`
      CREATE TABLE IF NOT EXISTS activities (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        status TEXT NOT NULL,
        collapsed INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  createActivity(input: {
    readonly id: string;
    readonly sessionId: PiSessionId;
    readonly title: string;
    readonly summary: string;
  }): ActivityRecord {
    const now = Date.now();
    this.#sql.exec(
      `INSERT INTO activities (
        id, session_id, title, summary, status, collapsed, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'running', 0, ?, ?)`,
      input.id,
      input.sessionId,
      input.title,
      input.summary,
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

  #toRecord(row: ActivityRow): ActivityRecord {
    return {
      id: row.id,
      sessionId: row.session_id,
      title: row.title,
      summary: row.summary,
      status: row.status,
      collapsed: row.collapsed === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  getActivity(id: string): ActivityRecord | undefined {
    const row = this.#sql
      .exec<ActivityRow>(
        "SELECT id, session_id, title, summary, status, collapsed, created_at, updated_at FROM activities WHERE id = ?",
        id,
      )
      .toArray()[0];
    return row ? this.#toRecord(row) : undefined;
  }

  listActivities(limit = 50): ActivityRecord[] {
    const clamped = Math.max(1, Math.min(limit, 100));
    return this.#sql
      .exec<ActivityRow>(
        "SELECT id, session_id, title, summary, status, collapsed, created_at, updated_at FROM activities ORDER BY updated_at DESC LIMIT ?",
        clamped,
      )
      .toArray()
      .map((row) => this.#toRecord(row));
  }

  updateActivity(
    id: string,
    patch: {
      readonly status?: ActivityStatus;
      readonly summary?: string;
      readonly collapsed?: boolean;
    },
  ): ActivityRecord | undefined {
    const existing = this.getActivity(id);
    if (!existing) {
      return undefined;
    }
    const nextStatus = patch.status ?? existing.status;
    const nextSummary = patch.summary ?? existing.summary;
    const nextCollapsed = patch.collapsed ?? existing.collapsed;
    const now = Date.now();
    this.#sql.exec(
      `UPDATE activities
       SET status = ?, summary = ?, collapsed = ?, updated_at = ?
       WHERE id = ?`,
      nextStatus,
      nextSummary,
      nextCollapsed ? 1 : 0,
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

  renderActivitiesSummary(): string {
    const activities = this.listActivities(15);
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
      return jsonToolResult({
        activity: record,
        operationId: receipt.operationId,
      });
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
        return errorToolResult(`Unknown activityId: ${activityId}`);
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
      return jsonToolResult({
        activityId,
        sessionId: existing.sessionId,
        operationId: receipt.operationId,
      });
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
        return errorToolResult(`Unknown activityId: ${activityId}`);
      }
      onActivityChanged(updated);
      return jsonToolResult(updated);
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
      return jsonToolResult({ activities: filtered });
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
