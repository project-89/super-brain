import { compareEventKeys, parseEvent, type FoldEvent, type JsonValue, type Provenance } from "@_89/fold";

import type {
  DriveEventContext,
  DriveEventStamp,
  DriveSatiation,
  DriveSystemSnapshot,
  IntentionEnd,
  Satisfier,
  SurfacedCandidate,
  SurfacingTrigger,
  WearTransition,
} from "./types.js";

export const DRIVE_SAMPLE_NODE_KIND = "x.fold.drive-sample";
export const DRIVE_SATIATION_NODE_KIND = "x.fold.drive-satiation";
export const DRIVE_WEAR_TRANSITION_NODE_KIND = "x.fold.drive-wear-transition";
export const INTENTION_EVENT_NODE_KIND = "x.fold.intention-event";

const INTENTION_EVENT_TYPE_BY_KIND = {
  "intention.surfaced": "surfaced",
  "intention.committed": "committed",
  "intention.declined": "declined",
  "intention.acted": "acted",
  "intention.ended": "ended",
} as const;

const DERIVED_PROVENANCE: Provenance = {
  basis: "derived",
  method: { kind: "system", id: "@_89/fold-drives" },
};

const AUTHORED_PROVENANCE: Provenance = { basis: "authored" };

export type IntentionRecord =
  | {
      readonly actorId: string;
      readonly atMs: number;
      readonly eventType: "surfaced";
      readonly candidate: SurfacedCandidate;
    }
  | {
      readonly actorId: string;
      readonly atMs: number;
      readonly eventType: "committed";
      readonly candidateId: string;
      readonly intentionId: string;
    }
  | {
      readonly actorId: string;
      readonly atMs: number;
      readonly eventType: "declined";
      readonly candidateId: string;
      readonly reason: string;
    }
  | {
      readonly actorId: string;
      readonly atMs: number;
      readonly eventType: "acted";
      readonly intentionId: string;
    }
  | {
      readonly actorId: string;
      readonly atMs: number;
      readonly eventType: "ended";
      readonly intentionId: string;
      readonly end: IntentionEnd;
    };

export class DriveEventError extends Error {
  override readonly name = "DriveEventError";
}

function nonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) throw new DriveEventError(`${label} must not be empty`);
}

function validateContext(context: DriveEventContext): void {
  nonEmpty(context.actorId, "actorId");
  nonEmpty(context.author.id, "author id");
  if (context.capture.identity.actor !== context.actorId) {
    throw new DriveEventError("capture.identity.actor must match actorId");
  }
}

function validateStamp(stamp: DriveEventStamp): void {
  nonEmpty(stamp.id, "event id");
  if (!Number.isFinite(stamp.t) || stamp.t < 0) {
    throw new DriveEventError("event t must be finite and non-negative");
  }
}

function validateSatisfier(satisfier: Satisfier): void {
  nonEmpty(satisfier.kind, "satisfier kind");
  nonEmpty(satisfier.ref, "satisfier ref");
}

function validateTrigger(trigger: SurfacingTrigger): void {
  if (trigger.kind === "coincidence") nonEmpty(trigger.note, "coincidence note");
}

function validateEnd(end: IntentionEnd): void {
  if (end.kind === "abandoned") nonEmpty(end.reason, "abandon reason");
  if (end.kind === "superseded") nonEmpty(end.byIntentionId, "superseding intention id");
}

function makeRecordEvent(
  context: DriveEventContext,
  stamp: DriveEventStamp,
  input: {
    readonly kind: string;
    readonly title: string;
    readonly nodeKind: string;
    readonly after: Record<string, JsonValue>;
    readonly provenance: Provenance;
    readonly causedBy?: readonly string[];
  },
): FoldEvent {
  validateContext(context);
  validateStamp(stamp);
  for (const eventId of input.causedBy ?? []) nonEmpty(eventId, "causedBy event id");
  return parseEvent({
    specVersion: "0.7",
    id: stamp.id,
    kind: input.kind,
    title: input.title,
    at: { t: stamp.t, worldDate: stamp.worldDate, granularity: "beat" },
    participants: [context.actorId],
    author: context.author,
    ...(input.causedBy === undefined || input.causedBy.length === 0
      ? {}
      : { causedBy: [...input.causedBy] }),
    capture: context.capture,
    changes: [
      {
        verb: "create",
        subject: `urn:fold-record:${stamp.id}`,
        nodeKind: input.nodeKind,
        after: input.after,
        provenance: input.provenance,
      },
    ],
  });
}

export function makeDriveSampleEvent(
  context: DriveEventContext,
  stamp: DriveEventStamp,
  snapshot: DriveSystemSnapshot,
): FoldEvent {
  if (snapshot.actorId !== context.actorId) throw new DriveEventError("sample actorId does not match context");
  if (snapshot.elapsedMs !== stamp.t) throw new DriveEventError("sample elapsedMs must match event t");
  const perDrive: Record<string, JsonValue> = {};
  for (const [driveId, tracker] of Object.entries(snapshot.wear.perDrive)) {
    perDrive[driveId] = {
      sustainedBelowMs: tracker.sustainedBelowMs,
      sustainedAboveMs: tracker.sustainedAboveMs,
    };
  }
  return makeRecordEvent(context, stamp, {
    kind: "drive.sampled",
    title: `Drive state sampled for ${context.actorId}`,
    nodeKind: DRIVE_SAMPLE_NODE_KIND,
    after: {
      actorId: snapshot.actorId,
      atMs: snapshot.elapsedMs,
      levels: snapshot.levels,
      wear: { perDrive, chronicLoad: snapshot.wear.chronicLoad },
    },
    provenance: DERIVED_PROVENANCE,
  });
}

export function makeDriveSatiationEvent(
  context: DriveEventContext,
  stamp: DriveEventStamp,
  satiation: DriveSatiation,
): FoldEvent {
  if (satiation.atMs !== stamp.t) throw new DriveEventError("satiation atMs must match event t");
  nonEmpty(satiation.driveId, "satiation drive id");
  if (satiation.requested < 0) throw new DriveEventError("satiation requested amount must not be negative");
  return makeRecordEvent(context, stamp, {
    kind: "drive.satiated",
    title: `${satiation.driveId} satiated for ${context.actorId}`,
    nodeKind: DRIVE_SATIATION_NODE_KIND,
    after: {
      actorId: context.actorId,
      atMs: satiation.atMs,
      driveId: satiation.driveId,
      before: satiation.before,
      after: satiation.after,
      requested: satiation.requested,
      entry: satiation.entry,
    },
    provenance: DERIVED_PROVENANCE,
    ...(satiation.causeEventId === undefined ? {} : { causedBy: [satiation.causeEventId] }),
  });
}

export function makeWearTransitionEvent(
  context: DriveEventContext,
  stamp: DriveEventStamp,
  transition: WearTransition,
): FoldEvent {
  if (transition.atMs !== stamp.t) throw new DriveEventError("wear transition atMs must match event t");
  nonEmpty(transition.driveId, "wear transition drive id");
  if (transition.from === transition.to) throw new DriveEventError("wear transition must change zones");
  return makeRecordEvent(context, stamp, {
    kind: "drive.wear-transition",
    title: `${transition.driveId} moved ${transition.from} to ${transition.to}`,
    nodeKind: DRIVE_WEAR_TRANSITION_NODE_KIND,
    after: {
      actorId: context.actorId,
      atMs: transition.atMs,
      driveId: transition.driveId,
      from: transition.from,
      to: transition.to,
      level: transition.level,
    },
    provenance: DERIVED_PROVENANCE,
    ...(transition.causeEventId === undefined ? {} : { causedBy: [transition.causeEventId] }),
  });
}

export function makeIntentionSurfacedEvent(
  context: DriveEventContext,
  stamp: DriveEventStamp,
  input: Omit<SurfacedCandidate, "surfacedAtMs">,
  causedBy?: readonly string[],
): FoldEvent {
  nonEmpty(input.id, "candidate id");
  nonEmpty(input.sourceDriveId, "source drive id");
  nonEmpty(input.aim, "candidate aim");
  validateSatisfier(input.satisfier);
  validateTrigger(input.trigger);
  const candidate: SurfacedCandidate = { ...input, surfacedAtMs: stamp.t };
  const candidateJson: Record<string, JsonValue> = {
    id: candidate.id,
    sourceDriveId: candidate.sourceDriveId,
    satisfier: {
      kind: candidate.satisfier.kind,
      ref: candidate.satisfier.ref,
      ...(candidate.satisfier.params === undefined ? {} : { params: candidate.satisfier.params }),
    },
    aim: candidate.aim,
    surfacedAtMs: candidate.surfacedAtMs,
    trigger:
      candidate.trigger.kind === "coincidence"
        ? { kind: "coincidence", note: candidate.trigger.note }
        : { kind: candidate.trigger.kind },
  };
  return makeRecordEvent(context, stamp, {
    kind: "intention.surfaced",
    title: `Intention candidate surfaced for ${context.actorId}`,
    nodeKind: INTENTION_EVENT_NODE_KIND,
    after: {
      actorId: context.actorId,
      atMs: stamp.t,
      eventType: "surfaced",
      candidate: candidateJson,
    },
    provenance: AUTHORED_PROVENANCE,
    ...(causedBy === undefined ? {} : { causedBy }),
  });
}

export function makeIntentionCommittedEvent(
  context: DriveEventContext,
  stamp: DriveEventStamp,
  candidateId: string,
  intentionId: string,
  causedBy?: readonly string[],
): FoldEvent {
  nonEmpty(candidateId, "candidate id");
  nonEmpty(intentionId, "intention id");
  return makeRecordEvent(context, stamp, {
    kind: "intention.committed",
    title: `Intention committed for ${context.actorId}`,
    nodeKind: INTENTION_EVENT_NODE_KIND,
    after: { actorId: context.actorId, atMs: stamp.t, eventType: "committed", candidateId, intentionId },
    provenance: AUTHORED_PROVENANCE,
    ...(causedBy === undefined ? {} : { causedBy }),
  });
}

export function makeIntentionDeclinedEvent(
  context: DriveEventContext,
  stamp: DriveEventStamp,
  candidateId: string,
  reason: string,
  causedBy?: readonly string[],
): FoldEvent {
  nonEmpty(candidateId, "candidate id");
  nonEmpty(reason, "decline reason");
  return makeRecordEvent(context, stamp, {
    kind: "intention.declined",
    title: `Intention candidate declined for ${context.actorId}`,
    nodeKind: INTENTION_EVENT_NODE_KIND,
    after: { actorId: context.actorId, atMs: stamp.t, eventType: "declined", candidateId, reason },
    provenance: AUTHORED_PROVENANCE,
    ...(causedBy === undefined ? {} : { causedBy }),
  });
}

export function makeIntentionActedEvent(
  context: DriveEventContext,
  stamp: DriveEventStamp,
  intentionId: string,
  causedBy?: readonly string[],
): FoldEvent {
  nonEmpty(intentionId, "intention id");
  return makeRecordEvent(context, stamp, {
    kind: "intention.acted",
    title: `Action recorded toward intention ${intentionId}`,
    nodeKind: INTENTION_EVENT_NODE_KIND,
    after: { actorId: context.actorId, atMs: stamp.t, eventType: "acted", intentionId },
    provenance: AUTHORED_PROVENANCE,
    ...(causedBy === undefined ? {} : { causedBy }),
  });
}

export function makeIntentionEndedEvent(
  context: DriveEventContext,
  stamp: DriveEventStamp,
  intentionId: string,
  end: IntentionEnd,
  causedBy?: readonly string[],
): FoldEvent {
  nonEmpty(intentionId, "intention id");
  validateEnd(end);
  return makeRecordEvent(context, stamp, {
    kind: "intention.ended",
    title: `Intention ${intentionId} ended`,
    nodeKind: INTENTION_EVENT_NODE_KIND,
    after: { actorId: context.actorId, atMs: stamp.t, eventType: "ended", intentionId, end },
    provenance: AUTHORED_PROVENANCE,
    ...(causedBy === undefined ? {} : { causedBy }),
  });
}

function objectValue(value: JsonValue | undefined, label: string): Record<string, JsonValue> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DriveEventError(`${label} must be an object`);
  }
  return value;
}

function stringValue(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DriveEventError(`${label} must be a non-empty string`);
  }
  return value;
}

function numberValue(value: JsonValue | undefined, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new DriveEventError(`${label} must be a finite number`);
  }
  return value;
}

function parseSatisfier(value: JsonValue | undefined): Satisfier {
  const object = objectValue(value, "satisfier");
  const paramsValue = object.params;
  return {
    kind: stringValue(object.kind, "satisfier.kind"),
    ref: stringValue(object.ref, "satisfier.ref"),
    ...(paramsValue === undefined ? {} : { params: objectValue(paramsValue, "satisfier.params") }),
  };
}

function parseTrigger(value: JsonValue | undefined): SurfacingTrigger {
  const object = objectValue(value, "trigger");
  const kind = stringValue(object.kind, "trigger.kind");
  if (kind === "quiet" || kind === "threshold") return { kind };
  if (kind === "coincidence") return { kind, note: stringValue(object.note, "trigger.note") };
  throw new DriveEventError(`unknown surfacing trigger: ${kind}`);
}

function parseEnd(value: JsonValue | undefined): IntentionEnd {
  const object = objectValue(value, "intention end");
  const kind = stringValue(object.kind, "intention end kind");
  if (kind === "satisfied" || kind === "expired") return { kind };
  if (kind === "abandoned") return { kind, reason: stringValue(object.reason, "abandon reason") };
  if (kind === "superseded") {
    return { kind, byIntentionId: stringValue(object.byIntentionId, "superseding intention id") };
  }
  throw new DriveEventError(`unknown intention end: ${kind}`);
}

function validateRecordEnvelope(event: FoldEvent, actorId: string, atMs: number): void {
  if (event.capture.identity?.actor !== actorId) {
    throw new DriveEventError(`event ${event.id} actor does not match capture identity`);
  }
  if (event.at.t !== atMs) throw new DriveEventError(`event ${event.id} atMs does not match event t`);
}

export function intentionRecordsFromEvent(event: FoldEvent): IntentionRecord[] {
  const records: IntentionRecord[] = [];
  for (const change of event.changes) {
    if (change.verb !== "create" || change.nodeKind !== INTENTION_EVENT_NODE_KIND) continue;
    const payload = change.after;
    const actorId = stringValue(payload.actorId, "intention actorId");
    const atMs = numberValue(payload.atMs, "intention atMs");
    validateRecordEnvelope(event, actorId, atMs);
    const eventType = stringValue(payload.eventType, "intention eventType");
    if (eventType === "surfaced") {
      const value = objectValue(payload.candidate, "candidate");
      const surfacedAtMs = numberValue(value.surfacedAtMs, "candidate surfacedAtMs");
      if (surfacedAtMs !== atMs) throw new DriveEventError("candidate surfacedAtMs must match record atMs");
      records.push({
        actorId,
        atMs,
        eventType,
        candidate: {
          id: stringValue(value.id, "candidate id"),
          sourceDriveId: stringValue(value.sourceDriveId, "candidate sourceDriveId"),
          satisfier: parseSatisfier(value.satisfier),
          aim: stringValue(value.aim, "candidate aim"),
          surfacedAtMs,
          trigger: parseTrigger(value.trigger),
        },
      });
    } else if (eventType === "committed") {
      records.push({
        actorId,
        atMs,
        eventType,
        candidateId: stringValue(payload.candidateId, "candidate id"),
        intentionId: stringValue(payload.intentionId, "intention id"),
      });
    } else if (eventType === "declined") {
      records.push({
        actorId,
        atMs,
        eventType,
        candidateId: stringValue(payload.candidateId, "candidate id"),
        reason: stringValue(payload.reason, "decline reason"),
      });
    } else if (eventType === "acted") {
      records.push({
        actorId,
        atMs,
        eventType,
        intentionId: stringValue(payload.intentionId, "intention id"),
      });
    } else if (eventType === "ended") {
      records.push({
        actorId,
        atMs,
        eventType,
        intentionId: stringValue(payload.intentionId, "intention id"),
        end: parseEnd(payload.end),
      });
    } else {
      throw new DriveEventError(`unknown intention event type: ${eventType}`);
    }
  }
  return records;
}

export function validateIntentionEventEnvelope(event: FoldEvent): void {
  const records = intentionRecordsFromEvent(event);
  const expected = INTENTION_EVENT_TYPE_BY_KIND[
    event.kind as keyof typeof INTENTION_EVENT_TYPE_BY_KIND
  ];
  if (expected === undefined) {
    if (records.length > 0) {
      throw new DriveEventError(`intention record ${event.id} requires an intention event kind`);
    }
    return;
  }
  if (event.changes.length !== 1 || records.length !== 1) {
    throw new DriveEventError(`intention event ${event.id} must contain exactly one intention record`);
  }
  if (records[0]?.eventType !== expected) {
    throw new DriveEventError(`intention event ${event.id} contains the wrong record type`);
  }
}

function snapshotFromPayload(event: FoldEvent, payload: Record<string, JsonValue>): DriveSystemSnapshot {
  const actorId = stringValue(payload.actorId, "sample actorId");
  const atMs = numberValue(payload.atMs, "sample atMs");
  validateRecordEnvelope(event, actorId, atMs);
  const levelValues = objectValue(payload.levels, "sample levels");
  const levels: Record<string, number> = {};
  for (const [id, level] of Object.entries(levelValues)) {
    levels[id] = numberValue(level, `sample level ${id}`);
  }
  const wearValue = objectValue(payload.wear, "sample wear");
  const perDriveValue = objectValue(wearValue.perDrive, "sample wear.perDrive");
  const perDrive: Record<string, { sustainedBelowMs: number; sustainedAboveMs: number }> = {};
  for (const [id, trackerValue] of Object.entries(perDriveValue)) {
    const tracker = objectValue(trackerValue, `sample wear tracker ${id}`);
    perDrive[id] = {
      sustainedBelowMs: numberValue(tracker.sustainedBelowMs, `sample ${id} sustainedBelowMs`),
      sustainedAboveMs: numberValue(tracker.sustainedAboveMs, `sample ${id} sustainedAboveMs`),
    };
  }
  return {
    actorId,
    elapsedMs: atMs,
    levels,
    wear: { perDrive, chronicLoad: numberValue(wearValue.chronicLoad, "sample chronicLoad") },
  };
}

export function latestDriveSample(
  events: readonly FoldEvent[],
  actorId: string,
): DriveSystemSnapshot | undefined {
  let latest: DriveSystemSnapshot | undefined;
  for (const event of [...events].sort(compareEventKeys)) {
    for (const change of event.changes) {
      if (change.verb !== "create" || change.nodeKind !== DRIVE_SAMPLE_NODE_KIND) continue;
      const sample = snapshotFromPayload(event, change.after);
      if (sample.actorId === actorId) latest = sample;
    }
  }
  return latest;
}
