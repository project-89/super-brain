import { parseEvent, type FoldEvent, type JsonValue } from "@_89/fold";

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
  return parseEvent({
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
}

export function makeTerminalObservationEvent(
  context: TerminalSensorContext,
  stamp: ActivityEventStamp,
  observation: TerminalObservation,
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
  return parseEvent({
    ...baseEvent(context, stamp),
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
  return parseEvent({
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
}
