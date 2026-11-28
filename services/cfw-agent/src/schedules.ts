import type { Extension, ToolRegistration } from "@earendil-works/pi-durable";
import {
  lit,
  num,
  obj,
  opt,
  str,
  union,
  unknown,
} from "@earendil-works/pi-schema";
import type { Schedule, Scheduler } from "agents/schedules";

import { errorToolResult, jsonToolResult } from "./http-tool";

export type SchedulePromptPayload = {
  readonly title: string;
  readonly prompt: string;
};

export type ScheduleModulePayload = {
  readonly path: string;
  readonly input?: unknown;
  readonly facet?: string;
  readonly className?: string;
};

export type PersonalScheduler = Scheduler<{
  readonly runPrompt: (
    payload: SchedulePromptPayload,
    schedule: Schedule<SchedulePromptPayload>,
  ) => Promise<void>;
  readonly runModule: (
    payload: ScheduleModulePayload,
    schedule: Schedule<ScheduleModulePayload>,
  ) => Promise<void>;
}>;

const TriggerSchema = union([
  obj({
    kind: lit("cron"),
    expression: str(),
  }),
  obj({
    kind: lit("interval"),
    intervalSeconds: num(),
  }),
  obj({
    kind: lit("delay"),
    delaySeconds: num(),
  }),
  obj({
    kind: lit("at"),
    isoDate: str(),
  }),
]);

const TargetSchema = union([
  obj({
    kind: lit("prompt"),
    title: str(),
    prompt: str(),
  }),
  obj({
    kind: lit("module"),
    path: str(),
    input: opt(unknown()),
    facet: opt(str()),
    className: opt(str()),
  }),
]);

const ScheduleCreateSchema = obj({
  trigger: TriggerSchema,
  target: TargetSchema,
});

const EmptySchema = obj({});

const ScheduleCancelSchema = obj({
  id: str(),
});

export function createSchedulesExtension(
  scheduler: PersonalScheduler,
): Extension {
  const scheduleCreateTool: ToolRegistration<typeof ScheduleCreateSchema> = {
    name: "schedule_create",
    description:
      "Create a durable background schedule (cron, interval, delay, or ISO date) that runs even while the user's device is offline. Target either an agent prompt (spawns a background activity) or an extension/ module.",
    parameters: ScheduleCreateSchema,
    replay: "unsafe",
    async execute({ trigger, target }) {
      try {
        const created = await (async () => {
          switch (trigger.kind) {
            case "cron":
              return target.kind === "prompt"
                ? scheduler.set(trigger.expression, "runPrompt", {
                    title: target.title,
                    prompt: target.prompt,
                  })
                : scheduler.set(trigger.expression, "runModule", {
                    path: target.path,
                    input: target.input,
                    facet: target.facet,
                    className: target.className,
                  });
            case "interval":
              if (trigger.intervalSeconds < 1) {
                throw new Error("intervalSeconds must be at least 1.");
              }
              return target.kind === "prompt"
                ? scheduler.every(trigger.intervalSeconds, "runPrompt", {
                    title: target.title,
                    prompt: target.prompt,
                  })
                : scheduler.every(trigger.intervalSeconds, "runModule", {
                    path: target.path,
                    input: target.input,
                    facet: target.facet,
                    className: target.className,
                  });
            case "delay":
              if (trigger.delaySeconds < 0) {
                throw new Error("delaySeconds must be non-negative.");
              }
              return target.kind === "prompt"
                ? scheduler.set(trigger.delaySeconds, "runPrompt", {
                    title: target.title,
                    prompt: target.prompt,
                  })
                : scheduler.set(trigger.delaySeconds, "runModule", {
                    path: target.path,
                    input: target.input,
                    facet: target.facet,
                    className: target.className,
                  });
            case "at": {
              const date = new Date(trigger.isoDate);
              if (Number.isNaN(date.getTime())) {
                throw new Error(`Invalid ISO date: "${trigger.isoDate}".`);
              }
              return target.kind === "prompt"
                ? scheduler.set(date, "runPrompt", {
                    title: target.title,
                    prompt: target.prompt,
                  })
                : scheduler.set(date, "runModule", {
                    path: target.path,
                    input: target.input,
                    facet: target.facet,
                    className: target.className,
                  });
            }
            default: {
              const exhaustive: never = trigger;
              throw new Error(`Unsupported trigger: ${String(exhaustive)}`);
            }
          }
        })();
        return jsonToolResult({ schedule: created });
      } catch (thrown) {
        return errorToolResult(
          thrown instanceof Error ? thrown.message : String(thrown),
        );
      }
    },
  };

  const scheduleListTool: ToolRegistration<typeof EmptySchema> = {
    name: "schedule_list",
    description: "List all active durable schedules for this agent.",
    parameters: EmptySchema,
    replay: "safe",
    async execute() {
      const schedules = await scheduler.list();
      return jsonToolResult({ schedules });
    },
  };

  const scheduleCancelTool: ToolRegistration<typeof ScheduleCancelSchema> = {
    name: "schedule_cancel",
    description: "Cancel a durable schedule by its id.",
    parameters: ScheduleCancelSchema,
    replay: "safe",
    async execute({ id }) {
      const cancelled = await scheduler.cancel(id);
      if (!cancelled) {
        return errorToolResult(`Schedule "${id}" not found.`);
      }
      return jsonToolResult({ ok: true, id });
    },
  };

  return {
    name: "schedules",
    tools: [scheduleCreateTool, scheduleListTool, scheduleCancelTool],
  };
}
