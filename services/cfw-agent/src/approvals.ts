import {
  defineSignal,
  type Extension,
  type TaskId,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { bool, obj, opt, str } from "@earendil-works/pi-schema";

export type ApprovalStatus = "pending" | "approved" | "rejected";

export type ApprovalRecord = {
  readonly id: string;
  readonly sessionId: string;
  readonly taskId: TaskId;
  readonly action: string;
  readonly summary: string;
  readonly details: string;
  readonly status: ApprovalStatus;
  readonly decisionNote: string | null;
  readonly createdAt: number;
  readonly resolvedAt: number | null;
};

const ApprovalDecisionSchema = obj({
  approved: bool(),
  note: opt(str()),
});

export const ApprovalSignal = defineSignal({
  name: "approval.decision",
  version: 1,
  schema: ApprovalDecisionSchema,
});

export class ApprovalStore {
  readonly #sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
    this.#migrate();
  }

  #migrate(): void {
    this.#sql.exec(`
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        action TEXT NOT NULL,
        summary TEXT NOT NULL,
        details TEXT NOT NULL,
        status TEXT NOT NULL,
        decision_note TEXT,
        created_at INTEGER NOT NULL,
        resolved_at INTEGER
      );
    `);
  }

  create(input: {
    readonly id: string;
    readonly sessionId: string;
    readonly taskId: TaskId;
    readonly action: string;
    readonly summary: string;
    readonly details: string;
  }): ApprovalRecord {
    const createdAt = Date.now();
    this.#sql.exec(
      `INSERT OR IGNORE INTO approvals (
        id, session_id, task_id, action, summary, details, status, decision_note, created_at, resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, ?, NULL)`,
      input.id,
      input.sessionId,
      String(input.taskId),
      input.action,
      input.summary,
      input.details,
      createdAt,
    );
    return this.get(input.id)!;
  }

  get(id: string): ApprovalRecord | undefined {
    const rows = this.#sql
      .exec<{
        id: string;
        session_id: string;
        task_id: string;
        action: string;
        summary: string;
        details: string;
        status: ApprovalStatus;
        decision_note: string | null;
        created_at: number;
        resolved_at: number | null;
      }>(
        `SELECT id, session_id, task_id, action, summary, details, status, decision_note, created_at, resolved_at
         FROM approvals WHERE id = ?`,
        id,
      )
      .toArray();
    const row = rows[0];
    if (!row) {
      return undefined;
    }
    return this.#toRecord(row);
  }

  list(status?: ApprovalStatus): ApprovalRecord[] {
    const rows = status
      ? this.#sql
          .exec<{
            id: string;
            session_id: string;
            task_id: string;
            action: string;
            summary: string;
            details: string;
            status: ApprovalStatus;
            decision_note: string | null;
            created_at: number;
            resolved_at: number | null;
          }>(
            `SELECT id, session_id, task_id, action, summary, details, status, decision_note, created_at, resolved_at
             FROM approvals WHERE status = ? ORDER BY created_at DESC`,
            status,
          )
          .toArray()
      : this.#sql
          .exec<{
            id: string;
            session_id: string;
            task_id: string;
            action: string;
            summary: string;
            details: string;
            status: ApprovalStatus;
            decision_note: string | null;
            created_at: number;
            resolved_at: number | null;
          }>(
            `SELECT id, session_id, task_id, action, summary, details, status, decision_note, created_at, resolved_at
             FROM approvals ORDER BY created_at DESC`,
          )
          .toArray();
    return rows.map((row) => this.#toRecord(row));
  }

  markResolved(
    id: string,
    approved: boolean,
    note?: string,
  ): ApprovalRecord | undefined {
    const existing = this.get(id);
    if (!existing) {
      return undefined;
    }
    if (existing.status !== "pending") {
      return existing;
    }
    const resolvedAt = Date.now();
    const nextStatus: ApprovalStatus = approved ? "approved" : "rejected";
    this.#sql.exec(
      "UPDATE approvals SET status = ?, decision_note = ?, resolved_at = ? WHERE id = ?",
      nextStatus,
      note ?? null,
      resolvedAt,
      id,
    );
    return this.get(id);
  }

  #toRecord(row: {
    id: string;
    session_id: string;
    task_id: string;
    action: string;
    summary: string;
    details: string;
    status: ApprovalStatus;
    decision_note: string | null;
    created_at: number;
    resolved_at: number | null;
  }): ApprovalRecord {
    return {
      id: row.id,
      sessionId: row.session_id,
      taskId: row.task_id as unknown as TaskId,
      action: row.action,
      summary: row.summary,
      details: row.details,
      status: row.status,
      decisionNote: row.decision_note,
      createdAt: row.created_at,
      resolvedAt: row.resolved_at,
    };
  }
}

const RequestApprovalSchema = obj({
  action: str(),
  summary: str(),
  details: opt(str()),
});

type ApprovalCheckpoint = {
  readonly approvalId: string;
};

export function createApprovalExtension(
  store: ApprovalStore,
  onRequested?: (record: ApprovalRecord) => void,
): Extension {
  const requestApprovalTool: ToolRegistration<
    typeof RequestApprovalSchema,
    ApprovalCheckpoint,
    ApprovalCheckpoint
  > = {
    name: "request_approval",
    description:
      "Durably pause execution and ask the user to approve or reject a sensitive action such as checkout, booking, or sending an email.",
    parameters: RequestApprovalSchema,
    replay: "safe",
    async execute(args, api, context) {
      if (api.wake?.reason === "signal" && api.checkpoint) {
        const decision = await api.readSignal(
          ApprovalSignal,
          api.checkpoint.approvalId,
          context,
        );
        if (decision?.kind === "value") {
          store.markResolved(
            api.checkpoint.approvalId,
            decision.value.approved,
            decision.value.note,
          );
          return {
            output: [
              {
                type: "text",
                text: JSON.stringify({
                  approvalId: api.checkpoint.approvalId,
                  approved: decision.value.approved,
                  note: decision.value.note ?? null,
                }),
              },
            ],
          };
        }
        return {
          isError: true,
          output: [
            {
              type: "text",
              text: "Approval signal expired without a decision.",
            },
          ],
        };
      }

      const approvalId = api.callId;
      const record = store.create({
        id: approvalId,
        sessionId: String(api.conversationId),
        taskId: api.taskId,
        action: args.action,
        summary: args.summary,
        details: args.details ?? "",
      });
      onRequested?.(record);

      return {
        kind: "sleep",
        checkpoint: { approvalId },
        signals: [ApprovalSignal.key(approvalId)],
      };
    },
  };

  return {
    name: "approvals",
    tools: [requestApprovalTool],
  };
}
