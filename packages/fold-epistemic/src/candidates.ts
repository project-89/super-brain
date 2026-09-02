import { compareEventKeys, parseEvent, type FoldEvent, type JsonValue, type Provenance } from "@_89/fold";

import { validateAccessContext } from "./access.js";
import { normalizeMemoryProjectIds, normalizeMemoryTags } from "./events.js";
import type {
  EpistemicEventContext,
  EpistemicEventStamp,
  MemoryAudience,
  MemoryCandidate,
  MemoryCandidateDecision,
  MemoryCandidateEvidence,
  MemoryCandidateInput,
  MemoryCandidateProjection,
  MemoryCandidateView,
} from "./types.js";
import { assertUuidV7 } from "./uuidv7.js";

export const MEMORY_CANDIDATE_NODE_KIND = "x.fold.memory-candidate";
export const MEMORY_CANDIDATE_DECISION_NODE_KIND = "x.fold.memory-candidate-decision";

const AUTHORED_PROVENANCE: Provenance = { basis: "authored" };

export class MemoryCandidateError extends Error {
  override readonly name = "MemoryCandidateError";
}

type CandidateLogRecord =
  | { readonly recordType: "proposed"; readonly candidate: MemoryCandidate }
  | {
      readonly recordType: "accepted" | "rejected";
      readonly workspaceId: string;
      readonly spaceId?: string;
      readonly audience: MemoryAudience;
      readonly decision: MemoryCandidateDecision;
    };

function nonEmpty(value: string, label: string, maxLength?: number): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new MemoryCandidateError(`${label} must not be empty`);
  if (maxLength !== undefined && normalized.length > maxLength) {
    throw new MemoryCandidateError(`${label} must be at most ${maxLength} characters`);
  }
  return normalized;
}

function boundedScore(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new MemoryCandidateError(`${label} must be within [0, 1]`);
  }
  return value;
}

function objectValue(value: JsonValue | undefined, label: string): Record<string, JsonValue> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new MemoryCandidateError(`${label} must be an object`);
  }
  return value;
}

function stringValue(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string") throw new MemoryCandidateError(`${label} must be a string`);
  return nonEmpty(value, label);
}

function textValue(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string") throw new MemoryCandidateError(`${label} must be a string`);
  return value;
}

function numberValue(value: JsonValue | undefined, label: string): number {
  if (typeof value !== "number") throw new MemoryCandidateError(`${label} must be a number`);
  return value;
}

function stringArray(value: JsonValue | undefined, label: string): string[] {
  if (!Array.isArray(value)) throw new MemoryCandidateError(`${label} must be an array`);
  return value.map((item, index) => stringValue(item, `${label}[${index}]`));
}

function audienceValue(value: JsonValue | undefined): MemoryAudience {
  if (value !== "personal" && value !== "workspace") {
    throw new MemoryCandidateError("candidate audience must be personal or workspace");
  }
  return value;
}

function optionalString(value: JsonValue | undefined, label: string): string | undefined {
  return value === undefined ? undefined : stringValue(value, label);
}

function evidenceJson(evidence: readonly MemoryCandidateEvidence[]): JsonValue[] {
  return evidence.map((item) => ({
    eventId: item.eventId,
    ...(item.projectId === undefined ? {} : { projectId: item.projectId }),
    ...(item.runId === undefined ? {} : { runId: item.runId }),
    ...(item.turnId === undefined ? {} : { turnId: item.turnId }),
  }));
}

function parseEvidence(value: JsonValue | undefined): MemoryCandidateEvidence[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new MemoryCandidateError("candidate evidence must be a non-empty array");
  }
  return value.map((item, index) => {
    const record = objectValue(item, `candidate evidence ${index}`);
    return {
      eventId: stringValue(record.eventId, `candidate evidence ${index} eventId`),
      ...(record.projectId === undefined ? {} : { projectId: stringValue(record.projectId, `candidate evidence ${index} projectId`) }),
      ...(record.runId === undefined ? {} : { runId: stringValue(record.runId, `candidate evidence ${index} runId`) }),
      ...(record.turnId === undefined ? {} : { turnId: stringValue(record.turnId, `candidate evidence ${index} turnId`) }),
    };
  });
}

function candidateJson(candidate: MemoryCandidate): Record<string, JsonValue> {
  return {
    id: candidate.id,
    workspaceId: candidate.workspaceId,
    ...(candidate.spaceId === undefined ? {} : { spaceId: candidate.spaceId }),
    proposerId: candidate.proposerId,
    audience: candidate.audience,
    projectIds: [...candidate.projectIds],
    source: candidate.source,
    summary: candidate.summary,
    content: candidate.content,
    tags: [...candidate.tags],
    entities: candidate.entities.map((entity) => ({ ...entity })),
    evidence: evidenceJson(candidate.evidence),
    confidence: candidate.confidence,
    salience: candidate.salience,
    extractor: { ...candidate.extractor },
    proposedAt: candidate.proposedAt,
    proposalEventId: candidate.proposalEventId,
  };
}

function parseCandidate(value: JsonValue | undefined): MemoryCandidate {
  const candidate = objectValue(value, "memory candidate");
  const id = stringValue(candidate.id, "candidate id");
  assertUuidV7(id, "candidate id");
  const extractor = objectValue(candidate.extractor, "candidate extractor");
  const kind = stringValue(extractor.kind, "candidate extractor kind");
  if (kind !== "rule" && kind !== "model" && kind !== "human") {
    throw new MemoryCandidateError("candidate extractor kind is invalid");
  }
  const entities = Array.isArray(candidate.entities)
    ? candidate.entities.map((item, index) => {
        const entity = objectValue(item, `candidate entity ${index}`);
        return {
          id: stringValue(entity.id, `candidate entity ${index} id`),
          type: stringValue(entity.type, `candidate entity ${index} type`),
          name: stringValue(entity.name, `candidate entity ${index} name`),
        };
      })
    : (() => { throw new MemoryCandidateError("candidate entities must be an array"); })();
  if (candidate.content === undefined) throw new MemoryCandidateError("candidate content is required");
  const parsed: MemoryCandidate = {
    id,
    workspaceId: stringValue(candidate.workspaceId, "candidate workspaceId"),
    ...(candidate.spaceId === undefined ? {} : { spaceId: stringValue(candidate.spaceId, "candidate spaceId") }),
    proposerId: stringValue(candidate.proposerId, "candidate proposerId"),
    audience: audienceValue(candidate.audience),
    projectIds: normalizeMemoryProjectIds(stringArray(candidate.projectIds, "candidate projectIds")),
    source: nonEmpty(stringValue(candidate.source, "candidate source"), "candidate source", 200),
    summary: nonEmpty(textValue(candidate.summary, "candidate summary"), "candidate summary", 500),
    content: candidate.content,
    tags: normalizeMemoryTags(stringArray(candidate.tags, "candidate tags")),
    entities,
    evidence: parseEvidence(candidate.evidence),
    confidence: boundedScore(numberValue(candidate.confidence, "candidate confidence"), "candidate confidence"),
    salience: boundedScore(numberValue(candidate.salience, "candidate salience"), "candidate salience"),
    extractor: {
      kind,
      id: nonEmpty(stringValue(extractor.id, "candidate extractor id"), "candidate extractor id", 200),
      version: nonEmpty(stringValue(extractor.version, "candidate extractor version"), "candidate extractor version", 100),
    },
    proposedAt: numberValue(candidate.proposedAt, "candidate proposedAt"),
    proposalEventId: stringValue(candidate.proposalEventId, "candidate proposalEventId"),
  };
  return parsed;
}

function validateContext(context: EpistemicEventContext, spaceId: string | undefined, audience: MemoryAudience): void {
  validateAccessContext(context.access);
  if (context.capture.scope.workspace !== context.access.workspaceId || context.capture.scope.space !== spaceId) {
    throw new MemoryCandidateError("candidate capture scope does not match access scope");
  }
  const creator = audience === "personal" ? context.access.principalId : undefined;
  if (context.capture.scope.creator !== creator) {
    throw new MemoryCandidateError("candidate audience does not match capture scope");
  }
  if (context.capture.identity.principal !== context.access.principalId || context.capture.identity.workspace !== context.access.workspaceId) {
    throw new MemoryCandidateError("candidate capture identity does not match access");
  }
}

function makeEvent(context: EpistemicEventContext, stamp: EpistemicEventStamp, input: {
  readonly kind: string;
  readonly title: string;
  readonly subject: string;
  readonly nodeKind: string;
  readonly after: Record<string, JsonValue>;
  readonly causedBy?: readonly string[];
}): FoldEvent {
  return parseEvent({
    specVersion: "0.7",
    id: stamp.id,
    kind: input.kind,
    title: input.title,
    at: { t: stamp.t, worldDate: stamp.worldDate, granularity: "beat" },
    participants: [context.access.principalId],
    author: context.author,
    ...(input.causedBy === undefined ? {} : { causedBy: [...input.causedBy] }),
    capture: context.capture,
    changes: [{ verb: "create", subject: input.subject, nodeKind: input.nodeKind, after: input.after, provenance: AUTHORED_PROVENANCE }],
  });
}

export function makeMemoryCandidateProposedEvent(
  context: EpistemicEventContext,
  stamp: EpistemicEventStamp,
  input: MemoryCandidateInput,
  causedBy?: readonly string[],
): FoldEvent {
  const audience = input.audience ?? "personal";
  validateContext(context, input.spaceId, audience);
  assertUuidV7(input.id, "candidate id");
  nonEmpty(input.source, "candidate source", 200);
  nonEmpty(input.summary, "candidate summary", 500);
  if (input.evidence.length === 0) throw new MemoryCandidateError("candidate evidence must not be empty");
  for (const evidence of input.evidence) nonEmpty(evidence.eventId, "candidate evidence eventId", 500);
  boundedScore(input.confidence, "candidate confidence");
  boundedScore(input.salience, "candidate salience");
  nonEmpty(input.extractor.id, "candidate extractor id", 200);
  nonEmpty(input.extractor.version, "candidate extractor version", 100);
  const candidate: MemoryCandidate = {
    ...input,
    workspaceId: context.access.workspaceId,
    proposerId: context.access.principalId,
    audience,
    projectIds: normalizeMemoryProjectIds(input.projectIds),
    tags: normalizeMemoryTags(input.tags),
    entities: [...(input.entities ?? [])],
    proposedAt: stamp.t,
    proposalEventId: stamp.id,
  };
  return makeEvent(context, stamp, {
    kind: "memory.candidate-proposed",
    title: `Memory candidate proposed from ${candidate.source}`,
    subject: candidate.id,
    nodeKind: MEMORY_CANDIDATE_NODE_KIND,
    after: { recordType: "proposed", candidate: candidateJson(candidate) },
    ...(causedBy === undefined ? {} : { causedBy }),
  });
}

function makeDecisionEvent(
  context: EpistemicEventContext,
  stamp: EpistemicEventStamp,
  candidate: MemoryCandidate,
  decision: { readonly kind: "accepted"; readonly memoryId: string } | { readonly kind: "rejected"; readonly reason: string },
): FoldEvent {
  validateContext(context, candidate.spaceId, candidate.audience);
  if (candidate.audience === "personal" && context.access.principalId !== candidate.proposerId) {
    throw new MemoryCandidateError("only the proposer may decide a personal memory candidate");
  }
  const after: Record<string, JsonValue> = {
    recordType: decision.kind,
    candidateId: candidate.id,
    actorId: context.access.principalId,
    workspaceId: candidate.workspaceId,
    ...(candidate.spaceId === undefined ? {} : { spaceId: candidate.spaceId }),
    audience: candidate.audience,
    atMs: stamp.t,
    ...(decision.kind === "accepted" ? { memoryId: decision.memoryId } : { reason: decision.reason }),
  };
  return makeEvent(context, stamp, {
    kind: `memory.candidate-${decision.kind}`,
    title: `Memory candidate ${candidate.id} ${decision.kind}`,
    subject: `urn:fold-record:${stamp.id}`,
    nodeKind: MEMORY_CANDIDATE_DECISION_NODE_KIND,
    after,
    causedBy: [candidate.proposalEventId],
  });
}

export function makeMemoryCandidateAcceptedEvent(context: EpistemicEventContext, stamp: EpistemicEventStamp, candidate: MemoryCandidate, memoryId: string): FoldEvent {
  assertUuidV7(memoryId, "accepted memory id");
  return makeDecisionEvent(context, stamp, candidate, { kind: "accepted", memoryId });
}

export function makeMemoryCandidateRejectedEvent(context: EpistemicEventContext, stamp: EpistemicEventStamp, candidate: MemoryCandidate, reason: string): FoldEvent {
  return makeDecisionEvent(context, stamp, candidate, { kind: "rejected", reason: nonEmpty(reason, "candidate rejection reason", 500) });
}

export function memoryCandidateLogRecordsFromEvent(event: FoldEvent): CandidateLogRecord[] {
  const records: CandidateLogRecord[] = [];
  for (const change of event.changes) {
    if (change.verb !== "create") continue;
    if (change.nodeKind === MEMORY_CANDIDATE_NODE_KIND) {
      if (event.kind !== "memory.candidate-proposed" || change.after.recordType !== "proposed") {
        throw new MemoryCandidateError("candidate proposal envelope is invalid");
      }
      const candidate = parseCandidate(change.after.candidate);
      if (candidate.id !== change.subject || candidate.proposalEventId !== event.id || candidate.proposedAt !== event.at.t) {
        throw new MemoryCandidateError("candidate proposal payload does not match event");
      }
      if (candidate.workspaceId !== event.capture.scope.workspace || candidate.spaceId !== event.capture.scope.space) {
        throw new MemoryCandidateError("candidate proposal scope does not match event");
      }
      if ((candidate.audience === "personal" ? candidate.proposerId : undefined) !== event.capture.scope.creator) {
        throw new MemoryCandidateError("candidate proposal audience does not match event");
      }
      if (
        event.participants?.includes(candidate.proposerId) !== true ||
        event.capture.identity?.principal !== candidate.proposerId ||
        event.capture.identity?.workspace !== candidate.workspaceId ||
        change.provenance?.basis !== "authored"
      ) {
        throw new MemoryCandidateError("candidate proposal identity or provenance does not match event");
      }
      records.push({ recordType: "proposed", candidate });
    } else if (change.nodeKind === MEMORY_CANDIDATE_DECISION_NODE_KIND) {
      const recordType = change.after.recordType;
      if ((recordType !== "accepted" && recordType !== "rejected") || event.kind !== `memory.candidate-${recordType}` || change.subject !== `urn:fold-record:${event.id}`) {
        throw new MemoryCandidateError("candidate decision envelope is invalid");
      }
      const base = {
        kind: recordType,
        candidateId: stringValue(change.after.candidateId, "candidate decision candidateId"),
        actorId: stringValue(change.after.actorId, "candidate decision actorId"),
        atMs: numberValue(change.after.atMs, "candidate decision atMs"),
        eventId: event.id,
      } as const;
      const workspaceId = stringValue(change.after.workspaceId, "candidate decision workspaceId");
      const spaceId = optionalString(change.after.spaceId, "candidate decision spaceId");
      const audience = audienceValue(change.after.audience);
      const decision: MemoryCandidateDecision = recordType === "accepted"
        ? { ...base, kind: "accepted", memoryId: stringValue(change.after.memoryId, "candidate decision memoryId") }
        : { ...base, kind: "rejected", reason: stringValue(change.after.reason, "candidate decision reason") };
      assertUuidV7(decision.candidateId, "candidate decision candidateId");
      if (decision.kind === "accepted") assertUuidV7(decision.memoryId, "candidate decision memoryId");
      if (
        decision.actorId !== event.capture.identity?.principal ||
        event.capture.identity?.workspace !== workspaceId ||
        event.capture.scope.workspace !== workspaceId ||
        event.capture.scope.space !== spaceId ||
        event.capture.scope.creator !== (audience === "personal" ? decision.actorId : undefined) ||
        event.participants?.includes(decision.actorId) !== true ||
        change.provenance?.basis !== "authored" ||
        decision.atMs !== event.at.t
      ) {
        throw new MemoryCandidateError("candidate decision payload does not match event");
      }
      records.push({ recordType, workspaceId, ...(spaceId === undefined ? {} : { spaceId }), audience, decision });
    }
  }
  return records;
}

export function validateMemoryCandidateEnvelope(event: FoldEvent): void {
  const records = memoryCandidateLogRecordsFromEvent(event);
  const isCandidateEvent = event.kind.startsWith("memory.candidate-");
  if (isCandidateEvent && (records.length !== 1 || event.changes.length !== 1)) {
    throw new MemoryCandidateError(`candidate event ${event.id} must contain exactly one candidate record`);
  }
  if (!isCandidateEvent && records.length > 0) {
    throw new MemoryCandidateError(`candidate record ${event.id} requires a candidate event kind`);
  }
}

export function rebuildMemoryCandidates(events: readonly FoldEvent[]): MemoryCandidateProjection {
  const candidates = new Map<string, MemoryCandidate>();
  const decisions = new Map<string, MemoryCandidateDecision>();
  for (const event of [...events].sort(compareEventKeys)) {
    for (const record of memoryCandidateLogRecordsFromEvent(event)) {
      if (record.recordType === "proposed") {
        if (candidates.has(record.candidate.id)) throw new MemoryCandidateError(`candidate ${record.candidate.id} was proposed more than once`);
        candidates.set(record.candidate.id, record.candidate);
      } else {
        const candidate = candidates.get(record.decision.candidateId);
        if (candidate === undefined) throw new MemoryCandidateError(`decision references unknown candidate ${record.decision.candidateId}`);
        if (decisions.has(candidate.id)) throw new MemoryCandidateError(`candidate ${candidate.id} was already decided`);
        if (record.decision.atMs < candidate.proposedAt) throw new MemoryCandidateError(`decision predates candidate ${candidate.id}`);
        if (
          record.workspaceId !== candidate.workspaceId ||
          record.spaceId !== candidate.spaceId ||
          record.audience !== candidate.audience ||
          (candidate.audience === "personal" && record.decision.actorId !== candidate.proposerId) ||
          !events.find(({ id }) => id === record.decision.eventId)?.causedBy?.includes(candidate.proposalEventId)
        ) {
          throw new MemoryCandidateError(`decision scope does not match candidate ${candidate.id}`);
        }
        decisions.set(candidate.id, record.decision);
      }
    }
  }
  return { candidates, decisions };
}

export function listMemoryCandidateViews(projection: MemoryCandidateProjection): MemoryCandidateView[] {
  return [...projection.candidates.values()]
    .map((candidate) => {
      const decision = projection.decisions.get(candidate.id);
      return {
        candidate,
        status: decision?.kind ?? "proposed",
        ...(decision === undefined ? {} : { decision }),
      } as MemoryCandidateView;
    })
    .sort((left, right) => right.candidate.proposedAt - left.candidate.proposedAt || left.candidate.id.localeCompare(right.candidate.id));
}
