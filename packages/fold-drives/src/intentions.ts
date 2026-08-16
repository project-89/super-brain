import { compareEventKeys, type FoldEvent, type JsonValue } from "@_89/fold";

import { intentionRecordsFromEvent } from "./events.js";
import { drivePressure, weightedPressure } from "./state.js";
import type {
  DriveSystemState,
  Intention,
  IntentionDecline,
  IntentionProjection,
  Satisfier,
  SurfacedCandidate,
  SurfacingEligibility,
} from "./types.js";

export const MAX_COMMITTED_INTENTIONS = 3;
export const DEFAULT_SURFACING_THRESHOLD = 0.2;
export const DEFAULT_DECLINE_COOLDOWN_MS = 2 * 3_600_000;

const URGENCY_AGE_HALFLIFE_MS = 6 * 3_600_000;
const ATTEMPT_DECAY = 0.8;

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export class IntentionProjectionError extends Error {
  override readonly name = "IntentionProjectionError";
}

export function rebuildIntentions(
  events: readonly FoldEvent[],
  actorId: string,
  options: { readonly maxCommitted?: number } = {},
): IntentionProjection {
  if (actorId.trim().length === 0) throw new TypeError("actorId must not be empty");
  const maxCommitted = options.maxCommitted ?? MAX_COMMITTED_INTENTIONS;
  if (!Number.isInteger(maxCommitted) || maxCommitted < 1) {
    throw new TypeError("maxCommitted must be a positive integer");
  }
  const candidates = new Map<string, SurfacedCandidate>();
  const resolvedCandidates = new Set<string>();
  const intentions = new Map<string, Intention>();
  const usedIntentionIds = new Set<string>();
  const declines: IntentionDecline[] = [];

  for (const event of [...events].sort(compareEventKeys)) {
    for (const record of intentionRecordsFromEvent(event)) {
      if (record.actorId !== actorId) continue;
      if (record.eventType === "surfaced") {
        if (candidates.has(record.candidate.id)) {
          throw new IntentionProjectionError(`candidate ${record.candidate.id} was surfaced more than once`);
        }
        candidates.set(record.candidate.id, record.candidate);
      } else if (record.eventType === "committed") {
        const candidate = candidates.get(record.candidateId);
        if (candidate === undefined) {
          throw new IntentionProjectionError(`commit references unknown candidate ${record.candidateId}`);
        }
        if (resolvedCandidates.has(record.candidateId)) {
          throw new IntentionProjectionError(`candidate ${record.candidateId} was resolved more than once`);
        }
        if (usedIntentionIds.has(record.intentionId)) {
          throw new IntentionProjectionError(`intention id ${record.intentionId} was reused`);
        }
        if (intentions.size >= maxCommitted) {
          throw new IntentionProjectionError(`commitment cap of ${maxCommitted} was exceeded`);
        }
        resolvedCandidates.add(record.candidateId);
        usedIntentionIds.add(record.intentionId);
        intentions.set(record.intentionId, {
          id: record.intentionId,
          aim: candidate.aim,
          sourceDriveId: candidate.sourceDriveId,
          satisfier: candidate.satisfier,
          fromCandidateId: candidate.id,
          formedAtMs: record.atMs,
          attempts: 0,
        });
      } else if (record.eventType === "declined") {
        const candidate = candidates.get(record.candidateId);
        if (candidate === undefined) {
          throw new IntentionProjectionError(`decline references unknown candidate ${record.candidateId}`);
        }
        if (resolvedCandidates.has(record.candidateId)) {
          throw new IntentionProjectionError(`candidate ${record.candidateId} was resolved more than once`);
        }
        resolvedCandidates.add(record.candidateId);
        declines.push({ candidate, reason: record.reason, atMs: record.atMs });
      } else if (record.eventType === "acted") {
        const intention = intentions.get(record.intentionId);
        if (intention === undefined) {
          throw new IntentionProjectionError(`action references inactive intention ${record.intentionId}`);
        }
        intentions.set(record.intentionId, { ...intention, attempts: intention.attempts + 1 });
      } else {
        if (!intentions.has(record.intentionId)) {
          throw new IntentionProjectionError(`ending references inactive intention ${record.intentionId}`);
        }
        intentions.delete(record.intentionId);
      }
    }
  }

  return {
    actorId,
    candidates,
    pendingCandidates: [...candidates.values()].filter((candidate) => !resolvedCandidates.has(candidate.id)),
    intentions,
    declines,
  };
}

export function urgency(
  state: DriveSystemState,
  intention: Intention,
  nowMs = state.elapsedMs,
): number {
  if (!Number.isFinite(nowMs)) throw new TypeError("nowMs must be finite");
  const drive = state.drives.get(intention.sourceDriveId);
  if (drive === undefined) return 0;
  const ageMs = Math.max(0, nowMs - intention.formedAtMs);
  const ageFactor = 0.5 ** (ageMs / URGENCY_AGE_HALFLIFE_MS);
  return weightedPressure(drive) * ageFactor * ATTEMPT_DECAY ** intention.attempts;
}

export function sourcePressure(state: DriveSystemState, intention: Intention): number {
  const drive = state.drives.get(intention.sourceDriveId);
  return drive === undefined ? 0 : drivePressure(drive);
}

export function currentIntentions(
  projection: IntentionProjection,
  state: DriveSystemState,
  nowMs = state.elapsedMs,
): Intention[] {
  if (projection.actorId !== state.actorId) {
    throw new IntentionProjectionError("intention projection actor does not match drive state");
  }
  return [...projection.intentions.values()].sort(
    (left, right) =>
      urgency(state, right, nowMs) - urgency(state, left, nowMs) || compareCodeUnits(left.id, right.id),
  );
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

function pairKey(driveId: string, satisfier: Satisfier): string {
  const params = satisfier.params === undefined ? "" : canonicalJson(satisfier.params);
  return `${driveId}\u0000${satisfier.kind}\u0000${satisfier.ref}\u0000${params}`;
}

export function eligibleToSurface(
  state: DriveSystemState,
  projection: IntentionProjection,
  options: {
    readonly nowMs?: number;
    readonly declineCooldownMs?: number;
  } = {},
): SurfacingEligibility[] {
  if (projection.actorId !== state.actorId) {
    throw new IntentionProjectionError("intention projection actor does not match drive state");
  }
  const nowMs = options.nowMs ?? state.elapsedMs;
  const cooldownMs = options.declineCooldownMs ?? DEFAULT_DECLINE_COOLDOWN_MS;
  if (!Number.isFinite(nowMs)) throw new TypeError("nowMs must be finite");
  if (!Number.isFinite(cooldownMs) || cooldownMs < 0) {
    throw new TypeError("declineCooldownMs must be finite and non-negative");
  }
  const committed = new Set(
    [...projection.intentions.values()].map((value) => pairKey(value.sourceDriveId, value.satisfier)),
  );
  const suppressed = new Set<string>();
  if (cooldownMs > 0) {
    for (const decline of projection.declines) {
      if (nowMs - decline.atMs < cooldownMs) {
        suppressed.add(pairKey(decline.candidate.sourceDriveId, decline.candidate.satisfier));
      }
    }
  }
  const eligible: SurfacingEligibility[] = [];
  for (const drive of state.drives.values()) {
    const pressure = weightedPressure(drive);
    for (const pursuable of drive.pursuableBy ?? []) {
      const threshold = pursuable.threshold ?? DEFAULT_SURFACING_THRESHOLD;
      const key = pairKey(drive.id, pursuable.satisfier);
      if (pressure <= threshold || committed.has(key) || suppressed.has(key)) continue;
      eligible.push({
        driveId: drive.id,
        satisfier: pursuable.satisfier,
        ...(pursuable.hint === undefined ? {} : { hint: pursuable.hint }),
        pressure,
        threshold,
      });
    }
  }
  return eligible.sort(
    (left, right) =>
      right.pressure - left.pressure ||
      compareCodeUnits(pairKey(left.driveId, left.satisfier), pairKey(right.driveId, right.satisfier)),
  );
}

export function recentDeclines(
  projection: IntentionProjection,
  limit = 20,
): readonly IntentionDecline[] {
  if (!Number.isInteger(limit) || limit < 0) throw new TypeError("limit must be a non-negative integer");
  return [...projection.declines].reverse().slice(0, limit);
}
