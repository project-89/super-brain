import { parseEvent, type Change, type FoldEvent, type JsonValue } from "@_89/fold";

import { digestTerminalOutput } from "./normalize.js";
import type {
  ActivityEventStamp,
  TerminalClassification,
  TerminalObservation,
  TerminalSensorContext,
} from "./types.js";

export const ACTIVITY_OBSERVATION_NODE_KIND = "x.fold.activity-observation";
export const ACTIVITY_CLASSIFICATION_NODE_KIND = "x.fold.activity-classification";
export const SENSOR_LIFECYCLE_NODE_KIND = "x.fold.sensor-lifecycle";

const REQUIRED_IDENTITIES = ["agent", "task", "repo", "branch", "session"] as const;
const ACTIVITY_EVENT_NODE_KIND = {
  lifecycle: SENSOR_LIFECYCLE_NODE_KIND,
  "terminal.observation": ACTIVITY_OBSERVATION_NODE_KIND,
  "terminal.classification": ACTIVITY_CLASSIFICATION_NODE_KIND,
} as const;
const ACTIVITY_NODE_KINDS: ReadonlySet<string> = new Set(Object.values(ACTIVITY_EVENT_NODE_KIND));
const OBSERVATION_KINDS: ReadonlySet<string> = new Set([
  "status_changed",
  "prompt_submitted",
  "login_required",
  "auth_required",
  "blocking_prompt",
  "stall_detected",
  "tool_running",
  "tool_result",
  "file_changed",
  "repository_changed",
  "verification_result",
  "reasoning_checkpoint",
  "reasoning_observed",
  "human_decision",
  "task_complete",
  "output",
]);
const TERMINAL_STATES: ReadonlySet<string> = new Set([
  "unknown",
  "busy_streaming",
  "awaiting_input",
  "awaiting_auth",
  "awaiting_approval",
  "ready_for_input",
  "completed",
]);
type CreateChange = Extract<Change, { readonly verb: "create" }>;

function isActivityCreateChange(change: Change): change is CreateChange {
  return change.verb === "create" && ACTIVITY_NODE_KINDS.has(change.nodeKind);
}

export class ActivityEventError extends Error {
  override readonly name = "ActivityEventError";
}

function payloadString(
  payload: Readonly<Record<string, JsonValue>>,
  field: string,
  eventId: string,
): string {
  const value = payload[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ActivityEventError(`activity event ${eventId} requires ${field}`);
  }
  return value;
}

export function validateActivityEventEnvelope(event: FoldEvent): void {
  const activityChanges = event.changes.filter(isActivityCreateChange);
  const declaresActivityKind =
    event.kind === "terminal.observation" ||
    event.kind === "terminal.classification" ||
    (event.kind === "lifecycle" && activityChanges.length > 0);
  if (!declaresActivityKind && activityChanges.length === 0) return;
  const expectedNodeKind = ACTIVITY_EVENT_NODE_KIND[
    event.kind as keyof typeof ACTIVITY_EVENT_NODE_KIND
  ];
  const isActivityEvent = expectedNodeKind !== undefined;
  if (!isActivityEvent) {
    throw new ActivityEventError(`activity record ${event.id} requires an activity event kind`);
  }
  if (
    event.author.kind !== "sensor" ||
    event.changes.length !== 1 ||
    activityChanges.length !== 1 ||
    activityChanges[0]?.nodeKind !== expectedNodeKind
  ) {
    throw new ActivityEventError(
      `activity event ${event.id} requires one matching sensor-authored record`,
    );
  }
  const identity = event.capture.identity;
  for (const key of REQUIRED_IDENTITIES) {
    if (identity?.[key]?.trim().length === 0 || identity?.[key] === undefined) {
      throw new ActivityEventError(`activity event ${event.id} requires capture identity ${key}`);
    }
  }
  const payload = activityChanges[0].after;
  const sensor = payloadString(payload, "sensor", event.id);
  const sessionId = payloadString(payload, "sessionId", event.id);
  const observedAt = payloadString(payload, "observedAt", event.id);
  if (sensor !== event.author.id) {
    throw new ActivityEventError(`activity event ${event.id} sensor does not match author`);
  }
  if (sessionId !== identity?.session) {
    throw new ActivityEventError(`activity event ${event.id} session does not match capture identity`);
  }
  if (!Number.isFinite(Date.parse(observedAt))) {
    throw new ActivityEventError(`activity event ${event.id} observedAt must be an ISO timestamp`);
  }
  const provenance = activityChanges[0].provenance;
  if (provenance?.basis !== "observed") {
    throw new ActivityEventError(`activity event ${event.id} requires observed provenance`);
  }
  if (event.kind === "lifecycle") {
    if (
      event.lifecycle === undefined ||
      event.lifecycle.sensor !== sensor ||
      event.lifecycle.observedAt !== observedAt ||
      payload.phase !== event.lifecycle.phase ||
      payload.heartbeatWindowMs !== event.lifecycle.heartbeatWindowMs
    ) {
      throw new ActivityEventError(`activity event ${event.id} lifecycle metadata does not match its record`);
    }
    if (provenance.method?.kind !== "sensor" || provenance.method.id !== sensor) {
      throw new ActivityEventError(`activity event ${event.id} requires matching sensor provenance`);
    }
  } else if (event.lifecycle !== undefined) {
    throw new ActivityEventError(`activity event ${event.id} must not include lifecycle metadata`);
  } else if (event.kind === "terminal.observation") {
    if (!OBSERVATION_KINDS.has(payloadString(payload, "observation", event.id))) {
      throw new ActivityEventError(`activity event ${event.id} contains an unknown observation`);
    }
    if (provenance.method?.kind !== "sensor" || provenance.method.id !== sensor) {
      throw new ActivityEventError(`activity event ${event.id} requires matching sensor provenance`);
    }
  } else {
    if (!TERMINAL_STATES.has(payloadString(payload, "state", event.id))) {
      throw new ActivityEventError(`activity event ${event.id} contains an unknown terminal state`);
    }
    const classifierId = provenance.method?.id;
    if (
      provenance.method?.kind !== "classifier" ||
      typeof classifierId !== "string" ||
      classifierId.trim().length === 0 ||
      provenance.confidence === undefined ||
      provenance.confidence < 0 ||
      provenance.confidence > 1
    ) {
      throw new ActivityEventError(`activity event ${event.id} requires classifier provenance`);
    }
  }
}

function validateContext(context: TerminalSensorContext): void {
  if (!/^urn:sensor:[^\s]+$/.test(context.sensor)) {
    throw new TypeError("terminal sensor id must be a stable urn:sensor:* identifier");
  }
  if (context.sessionId !== context.capture.identity.session) {
    throw new TypeError("terminal sessionId must match capture.identity.session");
  }
  for (const key of REQUIRED_IDENTITIES) {
    if (context.capture.identity[key]?.trim().length === 0) {
      throw new TypeError(`terminal capture identity requires ${key}`);
    }
  }
  if (!Number.isInteger(context.heartbeatWindowMs) || context.heartbeatWindowMs <= 0) {
    throw new TypeError("heartbeatWindowMs must be a positive integer");
  }
}

function validateStamp(stamp: ActivityEventStamp): void {
  if (stamp.id.trim().length === 0) throw new TypeError("event id must not be empty");
  if (!Number.isFinite(stamp.t)) throw new TypeError("event t must be finite");
  if (!Number.isFinite(Date.parse(stamp.observedAt))) {
    throw new TypeError("observedAt must be an ISO timestamp");
  }
}

function baseEvent(context: TerminalSensorContext, stamp: ActivityEventStamp) {
  validateContext(context);
  validateStamp(stamp);
  return {
    specVersion: "0.7" as const,
    id: stamp.id,
    at: { t: stamp.t, worldDate: stamp.observedAt.slice(0, 10), granularity: "session" as const },
    author: { kind: "sensor" as const, id: context.sensor },
    capture: context.capture,
  };
}

export function makeSensorLifecycleEvent(
  context: TerminalSensorContext,
  stamp: ActivityEventStamp,
  phase: "online" | "heartbeat" | "degraded" | "offline",
  detail?: string,
): FoldEvent {
  const payload: Record<string, JsonValue> = {
    sensor: context.sensor,
    sessionId: context.sessionId,
    phase,
    observedAt: stamp.observedAt,
    heartbeatWindowMs: context.heartbeatWindowMs,
    ...(detail === undefined ? {} : { detail }),
  };
  const event = parseEvent({
    ...baseEvent(context, stamp),
    kind: "lifecycle",
    title: `Terminal sensor ${phase}`,
    ...(detail === undefined ? {} : { description: detail }),
    lifecycle: {
      sensor: context.sensor,
      phase,
      observedAt: stamp.observedAt,
      heartbeatWindowMs: context.heartbeatWindowMs,
    },
    changes: [
      {
        verb: "create",
        subject: `urn:fold:lifecycle:${stamp.id}`,
        nodeKind: SENSOR_LIFECYCLE_NODE_KIND,
        after: payload,
        provenance: {
          basis: "observed",
          method: { kind: "sensor", id: context.sensor },
        },
      },
    ],
  });
  validateActivityEventEnvelope(event);
  return event;
}

export function makeTerminalObservationEvent(
  context: TerminalSensorContext,
  stamp: ActivityEventStamp,
  observation: TerminalObservation,
  causedBy?: readonly string[],
): FoldEvent {
  const digest = observation.output === undefined ? undefined : digestTerminalOutput(observation.output);
  const after: Record<string, JsonValue> = {
    sensor: context.sensor,
    sessionId: context.sessionId,
    observation: observation.kind,
    observedAt: stamp.observedAt,
    ...(observation.data === undefined ? {} : { data: { ...observation.data } }),
    ...(digest === undefined
      ? {}
      : {
          output: {
            normalizedText: digest.normalizedText,
            runs: digest.runs.map((run) => ({ text: run.text, count: run.count })),
            sampleCount: digest.sampleCount,
            sourceCharacters: digest.sourceCharacters,
          },
        }),
  };
  const event = parseEvent({
    ...baseEvent(context, stamp),
    ...(causedBy === undefined || causedBy.length === 0 ? {} : { causedBy: [...causedBy] }),
    kind: "terminal.observation",
    title: `Terminal ${observation.kind.replaceAll("_", " ")}`,
    changes: [
      {
        verb: "create",
        subject: `urn:fold:activity:${stamp.id}`,
        nodeKind: ACTIVITY_OBSERVATION_NODE_KIND,
        after,
        provenance: {
          basis: "observed",
          method: { kind: "sensor", id: context.sensor },
        },
      },
    ],
  });
  validateActivityEventEnvelope(event);
  return event;
}

export function makeTerminalClassificationEvent(
  context: TerminalSensorContext,
  stamp: ActivityEventStamp,
  classification: TerminalClassification,
  classifierId: string,
  normalizedTail: string,
): FoldEvent {
  if (classifierId.trim().length === 0) throw new TypeError("classifierId must not be empty");
  const after: Record<string, JsonValue> = {
    sensor: context.sensor,
    sessionId: context.sessionId,
    state: classification.state,
    observedAt: stamp.observedAt,
    normalizedTail,
    ...(classification.ruleId === undefined ? {} : { ruleId: classification.ruleId }),
  };
  const event = parseEvent({
    ...baseEvent(context, stamp),
    kind: "terminal.classification",
    title: `Terminal classified ${classification.state.replaceAll("_", " ")}`,
    changes: [
      {
        verb: "create",
        subject: `urn:fold:activity-classification:${stamp.id}`,
        nodeKind: ACTIVITY_CLASSIFICATION_NODE_KIND,
        after,
        provenance: {
          basis: "observed",
          confidence: classification.confidence,
          method: { kind: "classifier", id: classifierId },
        },
      },
    ],
  });
  validateActivityEventEnvelope(event);
  return event;
}
