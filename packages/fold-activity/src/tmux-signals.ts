import type { FoldEvent, JsonValue } from "@_89/fold";

import { makeSensorLifecycleEvent, makeTerminalObservationEvent } from "./events.js";
import type {
  ActivityEventStamp,
  TerminalManagerSignal,
  TerminalObservation,
  TerminalSensorContext,
} from "./types.js";

function withoutUndefined(values: Record<string, string | boolean | number | undefined>): Record<string, JsonValue> {
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, string | boolean | number] => entry[1] !== undefined),
  );
}

export function eventFromTerminalManagerSignal(
  context: TerminalSensorContext,
  stamp: ActivityEventStamp,
  signal: TerminalManagerSignal,
): FoldEvent {
  if (signal.type === "session_started") {
    return makeSensorLifecycleEvent(context, stamp, "online");
  }
  if (signal.type === "session_stopped") {
    return makeSensorLifecycleEvent(context, stamp, "offline", signal.reason);
  }
  if (signal.type === "session_error") {
    return makeSensorLifecycleEvent(context, stamp, "offline", signal.error);
  }
  if (signal.type === "heartbeat") {
    return makeSensorLifecycleEvent(context, stamp, "heartbeat");
  }
  if (signal.type === "sensor_degraded") {
    return makeSensorLifecycleEvent(context, stamp, "degraded", signal.detail);
  }

  let observation: TerminalObservation;
  switch (signal.type) {
    case "session_ready":
      observation = { kind: "status_changed", data: { status: "ready" } };
      break;
    case "session_status_changed":
      observation = { kind: "status_changed", data: { status: signal.status } };
      break;
    case "login_required":
      observation = {
        kind: "login_required",
        data: withoutUndefined({ instructions: signal.instructions, url: signal.url }),
      };
      break;
    case "auth_required":
      observation = {
        kind: "auth_required",
        data: withoutUndefined({
          method: signal.method,
          instructions: signal.instructions,
          url: signal.url,
        }),
      };
      break;
    case "blocking_prompt":
      observation = {
        kind: "blocking_prompt",
        data: withoutUndefined({
          promptType: signal.promptType,
          prompt: signal.prompt,
          autoResponded: signal.autoResponded,
        }),
      };
      break;
    case "stall_detected":
      observation = {
        kind: "stall_detected",
        data: { stallDurationMs: signal.stallDurationMs },
        output: signal.recentOutput,
      };
      break;
    case "task_complete":
      observation = { kind: "task_complete", ...(signal.output === undefined ? {} : { output: signal.output }) };
      break;
    case "tool_running":
      observation = { kind: "tool_running", data: { toolName: signal.toolName } };
      break;
    case "output":
      observation = { kind: "output", output: signal.output };
      break;
  }
  return makeTerminalObservationEvent(context, stamp, observation);
}
