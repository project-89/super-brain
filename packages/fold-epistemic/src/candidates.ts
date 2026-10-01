import { compareEventKeys, parseEvent, type FoldEvent, type JsonValue, type Provenance } from "@_89/fold";

import { assertCanWritePersonalMemory, validReplayMemoryAuthority, validateAccessContext } from "./access.js";
import { effectiveMemoryApplicability, validateMemoryApplicability } from "./applicability.js";
import { normalizeMemoryProjectIds, normalizeMemoryTags } from "./events.js";
import type {
  MemoryApplicability,
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
import { memoryEvidenceContributionsFromEvent } from "./contributions.js";
import { memoryProjectIds, memoryValidity, memoryValidityJson, normalizeMemoryEvidence, mergeMemoryEvidence, memoryRevision } from "./validity.js";
import { assertUuidV7 } from "./uuidv7.js";

export const MEMORY_CANDIDATE_NODE_KIND = "x.fold.memory-candidate";
export const MEMORY_CANDIDATE_DECISION_NODE_KIND = "x.fold.memory-candidate-decision";
export const MEMORY_CANDIDATE_EVIDENCE_NODE_KIND = "x.fold.memory-candidate-evidence";

const AUTHORED_PROVENANCE: Provenance = { basis: "authored" };

export class MemoryCandidateError extends Error {
  override readonly name = "MemoryCandidateError";
}

type CandidateLogRecord =
  | { readonly recordType: "proposed"; readonly candidate: MemoryCandidate }
  | { readonly recordType: "evidence-added"; readonly candidateId: string; readonly proposalEventId: string;
      readonly workspaceId: string; readonly spaceId?: string; readonly audience: MemoryAudience;
    readonly actorId: string; readonly atMs: number; readonly eventId: string; readonly evidence: readonly MemoryCandidateEvidence[] }
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

function evidenceJson(evidence: readonly MemoryCandidateEvidence[], maximum = 100): JsonValue[] { return normalizeMemoryEvidence(evidence, maximum, 1).map((item) => ({ ...item })); }
function parseEvidence(value: JsonValue | undefined, maximum = 100): MemoryCandidateEvidence[] { return normalizeMemoryEvidence(value, maximum, 1); }

/** Deduplicates candidate evidence references; equivalent to `mergeMemoryEvidence`. */
export function mergeMemoryCandidateEvidence(...groups: readonly (readonly MemoryCandidateEvidence[])[]): MemoryCandidateEvidence[] {
  return mergeMemoryEvidence(...groups);
}

function canonical(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(",")}}`;
}

export function equivalentMemoryCandidateMeaning(left: MemoryCandidateInput, right: MemoryCandidateInput): boolean {
  const meaning = (candidate: MemoryCandidateInput): JsonValue => {
    const projectIds = normalizeMemoryProjectIds(candidate.projectIds);
    const applicability = effectiveMemoryApplicability({ ...candidate, projectIds });
    return {
      audience: candidate.audience ?? "personal", spaceId: candidate.spaceId ?? null,
      applicability: applicability.kind === "projects" ? { kind: "projects", projectIds: [...applicability.projectIds] } : { kind: applicability.kind },
      source: candidate.source,
      summary: candidate.summary, content: candidate.content,
      tags: normalizeMemoryTags(candidate.tags), entities: (candidate.entities ?? []).map((entity) => ({ ...entity })),
      confidence: candidate.confidence, salience: candidate.salience, extractor: { ...candidate.extractor },
    };
  };
  return canonical(meaning(left)) === canonical(meaning(right));
}

export function candidateSupportSourceMatches(candidate: MemoryCandidate, reference: MemoryCandidateEvidence, source: FoldEvent,
  projectIds: readonly string[] = candidate.projectIds, knownProjectIds: readonly string[] = []): boolean {
  if (source.capture.scope.workspace !== candidate.workspaceId || source.capture.scope.space !== candidate.spaceId ||
    source.capture.scope.creator !== (candidate.audience === "personal" ? candidate.proposerId : undefined)) return false;
  if (candidate.projectIds.length === 0) return true;
  const sourceProjects = new Set<string>();
  if (source.capture.identity?.repo !== undefined && knownProjectIds.includes(source.capture.identity.repo)) sourceProjects.add(source.capture.identity.repo);
  // `identity.project` may be a display name; only typed transcript IDs or capture repo IDs assert project identity.
  for (const change of source.changes) {
    if (change.verb !== "create" || source.kind !== "transcript.run-imported") continue;
    const run = change.after.run;
    if (run === null || typeof run !== "object" || Array.isArray(run)) continue;
    if (typeof run.projectId === "string") sourceProjects.add(run.projectId);
    if (Array.isArray(run.segments)) for (const segment of run.segments) {
      if (segment !== null && typeof segment === "object" && !Array.isArray(segment) && typeof segment.projectId === "string") sourceProjects.add(segment.projectId);
    }
  }
  return (reference.projectId === undefined || projectIds.includes(reference.projectId)) &&
    (sourceProjects.size === 0 || [...sourceProjects].some((id) => projectIds.includes(id)));
}

function candidateJson(candidate: MemoryCandidate): Record<string, JsonValue> {
  return {
    id: candidate.id,
    workspaceId: candidate.workspaceId,
    ...(candidate.spaceId === undefined ? {} : { spaceId: candidate.spaceId }),
    proposerId: candidate.proposerId,
    audience: candidate.audience,
    projectIds: [...candidate.projectIds],
    ...memoryValidityJson(candidate, candidate.projectIds),
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
  validateMemoryApplicability({
    projectIds: normalizeMemoryProjectIds(stringArray(candidate.projectIds, "candidate projectIds")),
    ...(candidate.applicability === undefined ? {} : { applicability: candidate.applicability as unknown as MemoryApplicability }),
  });
  const parsed: MemoryCandidate = {
    id,
    workspaceId: stringValue(candidate.workspaceId, "candidate workspaceId"),
    ...(candidate.spaceId === undefined ? {} : { spaceId: stringValue(candidate.spaceId, "candidate spaceId") }),
    proposerId: stringValue(candidate.proposerId, "candidate proposerId"),
    audience: audienceValue(candidate.audience),
    projectIds: memoryProjectIds(candidate, normalizeMemoryProjectIds(stringArray(candidate.projectIds, "candidate projectIds"))),
    ...memoryValidity(candidate, normalizeMemoryProjectIds(stringArray(candidate.projectIds, "candidate projectIds"))),
    revision: 0,
    updatedAt: numberValue(candidate.proposedAt, "candidate proposedAt"),
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
  assertCanWritePersonalMemory({ workspaceId: context.access.workspaceId, creatorId: context.access.principalId, audience, ...(input.spaceId === undefined ? {} : { spaceId: input.spaceId }) }, context.access);
  normalizeMemoryEvidence(input.evidence, 100, 1);
  if (input.applicability !== undefined && input.projectIds !== undefined && input.projectIds.length > 0) {
    validateMemoryApplicability({ applicability: input.applicability, projectIds: normalizeMemoryProjectIds(input.projectIds) });
  }
  const candidate: MemoryCandidate = {
    ...input,
    workspaceId: context.access.workspaceId,
    proposerId: context.access.principalId,
    audience,
    projectIds: memoryProjectIds(input, normalizeMemoryProjectIds(input.projectIds)),
    ...memoryValidity(input, input.projectIds),
    revision: 0,
    tags: normalizeMemoryTags(input.tags),
    entities: [...(input.entities ?? [])],
    proposedAt: stamp.t,
    updatedAt: stamp.t,
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

export function assertCanReviewMemoryCandidate(candidate: MemoryCandidate, access: EpistemicEventContext["access"]): void {
  assertCanWritePersonalMemory({ ...candidate, creatorId: candidate.proposerId }, access);
  if (candidate.audience === "workspace" && access.workspaceRole !== "owner" && access.workspaceRole !== "admin") throw new MemoryCandidateError("workspace candidate review requires an owner or admin role");
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
  assertCanReviewMemoryCandidate(candidate, context.access);
  const after: Record<string, JsonValue> = {
    recordType: decision.kind,
    reviewAuthority: candidate.audience === "personal" ? "creator" : "workspace-reviewer",
    candidateId: candidate.id,
    actorId: context.access.principalId,
    workspaceId: candidate.workspaceId,
    ...(candidate.spaceId === undefined ? {} : { spaceId: candidate.spaceId }),
    audience: candidate.audience,
    atMs: stamp.t,
    ...(decision.kind === "accepted" ? { memoryId: decision.memoryId, candidateRevision: candidate.revision ?? 0 } : { reason: decision.reason }),
  };
  return makeEvent(context, stamp, {
    kind: `memory.candidate-${decision.kind}`,
    title: `Memory candidate ${candidate.id} ${decision.kind}`,
    subject: `urn:fold-record:${stamp.id}`,
    nodeKind: MEMORY_CANDIDATE_DECISION_NODE_KIND,
    after,
    causedBy: [candidate.proposalEventId, ...(candidate.supportEventIds ?? [])],
  });
}

export function makeMemoryCandidateAcceptedEvent(context: EpistemicEventContext, stamp: EpistemicEventStamp, candidate: MemoryCandidate, memoryId: string): FoldEvent {
  assertUuidV7(memoryId, "accepted memory id");
  return makeDecisionEvent(context, stamp, candidate, { kind: "accepted", memoryId });
}

export function makeMemoryCandidateRejectedEvent(context: EpistemicEventContext, stamp: EpistemicEventStamp, candidate: MemoryCandidate, reason: string): FoldEvent {
  return makeDecisionEvent(context, stamp, candidate, { kind: "rejected", reason: nonEmpty(reason, "candidate rejection reason", 500) });
}

export function makeMemoryCandidateEvidenceAddedEvent(
  context: EpistemicEventContext, stamp: EpistemicEventStamp, candidate: MemoryCandidate,
  evidence: readonly MemoryCandidateEvidence[],
): FoldEvent {
  validateContext(context, candidate.spaceId, candidate.audience);
  if (candidate.workspaceId !== context.access.workspaceId) throw new MemoryCandidateError("candidate workspace mismatch");
  if (candidate.audience === "personal" && candidate.proposerId !== context.access.principalId) throw new MemoryCandidateError("personal candidate support requires its proposer");
  assertCanWritePersonalMemory({ ...candidate, creatorId: candidate.proposerId }, context.access);
  if (evidence.length < 1 || evidence.length > 1000) throw new MemoryCandidateError("candidate support must contain 1 to 1000 evidence references");
  const normalized = parseEvidence(evidenceJson(evidence, 1000), 1000);
  return makeEvent(context, stamp, {
    kind: "memory.candidate-evidence-added", title: "Memory candidate supporting evidence added",
    subject: `urn:fold-record:${stamp.id}`, nodeKind: MEMORY_CANDIDATE_EVIDENCE_NODE_KIND,
    after: { recordType: "evidence-added", candidateId: candidate.id, proposalEventId: candidate.proposalEventId,
      workspaceId: candidate.workspaceId, audience: candidate.audience,
      ...(candidate.spaceId === undefined ? {} : { spaceId: candidate.spaceId }),
      actorId: context.access.principalId, atMs: stamp.t, evidence: evidenceJson(normalized, 1000) },
    causedBy: [...new Set([candidate.proposalEventId, ...normalized.map(({ eventId }) => eventId)])],
  });
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
    } else if (change.nodeKind === MEMORY_CANDIDATE_EVIDENCE_NODE_KIND) {
      const payload = change.after;
      const candidateId = stringValue(payload.candidateId, "candidate support candidateId");
      assertUuidV7(candidateId, "candidate support candidateId");
      const workspaceId = stringValue(payload.workspaceId, "candidate support workspaceId");
      const spaceId = optionalString(payload.spaceId, "candidate support spaceId");
      const audience = audienceValue(payload.audience);
      const actorId = stringValue(payload.actorId, "candidate support actorId");
      const atMs = numberValue(payload.atMs, "candidate support timestamp");
      const proposalEventId = stringValue(payload.proposalEventId, "candidate support proposalEventId");
      const evidence = parseEvidence(payload.evidence, 1000);
      if (event.kind !== "memory.candidate-evidence-added" || payload.recordType !== "evidence-added" ||
        change.subject !== `urn:fold-record:${event.id}` || evidence.length > 1000 ||
        event.capture.identity?.principal !== actorId || event.capture.identity?.workspace !== workspaceId ||
        event.capture.scope.workspace !== workspaceId || event.capture.scope.space !== spaceId ||
        event.capture.scope.creator !== (audience === "personal" ? actorId : undefined) ||
        event.participants?.includes(actorId) !== true || change.provenance?.basis !== "authored" || atMs !== event.at.t ||
        ![proposalEventId, ...evidence.map(({ eventId }) => eventId)].every((id) => event.causedBy?.includes(id))) {
        throw new MemoryCandidateError("candidate support envelope is invalid");
      }
      records.push({ recordType: "evidence-added", candidateId, proposalEventId, workspaceId, audience, actorId, atMs, eventId: event.id, evidence,
        ...(spaceId === undefined ? {} : { spaceId }) });
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
      if (change.after.reviewAuthority !== undefined && change.after.reviewAuthority !== (audience === "personal" ? "creator" : "workspace-reviewer")) throw new MemoryCandidateError("candidate review authority does not match audience");
      const decision: MemoryCandidateDecision = recordType === "accepted"
        ? { ...base, kind: "accepted", ...(change.after.candidateRevision === undefined ? {} : { candidateRevision: memoryRevision(change.after.candidateRevision) }), memoryId: stringValue(change.after.memoryId, "candidate decision memoryId") }
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
  memoryEvidenceContributionsFromEvent(event);
  const isCandidateEvent = event.kind.startsWith("memory.candidate-") && event.kind !== "memory.candidate-evidence-contributed";
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
    for (const contribution of memoryEvidenceContributionsFromEvent(event).filter(({ target }) => target === "candidate")) {
      const candidate = candidates.get(contribution.targetId);
      if (candidate === undefined || decisions.has(candidate.id) || (candidate.revision ?? 0) !== contribution.baseRevision || contribution.atMs < (candidate.updatedAt ?? candidate.proposedAt) || candidate.workspaceId !== contribution.workspaceId || candidate.spaceId !== contribution.spaceId || candidate.audience !== contribution.audience || !validReplayMemoryAuthority({ ...candidate, creatorId: candidate.proposerId }, contribution.actorId, contribution.authority)) throw new MemoryCandidateError("candidate evidence contribution does not match pending candidate revision or authority");
      candidates.set(candidate.id, { ...candidate, revision: contribution.baseRevision + 1, updatedAt: contribution.atMs, evidence: mergeMemoryEvidence(candidate.evidence, contribution.evidence) });
    }
    for (const record of memoryCandidateLogRecordsFromEvent(event)) {
      if (record.recordType === "proposed") {
        if (candidates.has(record.candidate.id)) throw new MemoryCandidateError(`candidate ${record.candidate.id} was proposed more than once`);
        candidates.set(record.candidate.id, record.candidate);
      } else if (record.recordType === "evidence-added") {
        const candidate = candidates.get(record.candidateId);
        if (candidate === undefined || decisions.has(record.candidateId)) throw new MemoryCandidateError("support requires an undecided candidate");
        if (record.atMs < (candidate.updatedAt ?? candidate.proposedAt) || record.proposalEventId !== candidate.proposalEventId ||
          record.workspaceId !== candidate.workspaceId || record.spaceId !== candidate.spaceId || record.audience !== candidate.audience ||
          (candidate.audience === "personal" && record.actorId !== candidate.proposerId)) throw new MemoryCandidateError("candidate support scope does not match proposal");
        // Legacy support records advance the candidate revision exactly like evidence contributions.
        candidates.set(candidate.id, { ...candidate, evidence: mergeMemoryEvidence(candidate.evidence, record.evidence),
          revision: (candidate.revision ?? 0) + 1, updatedAt: record.atMs,
          supportEventIds: [...(candidate.supportEventIds ?? []), record.eventId] });
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
          ![candidate.proposalEventId, ...(candidate.supportEventIds ?? [])].every((id) =>
            event.causedBy?.includes(id))
        ) {
          throw new MemoryCandidateError(`decision scope does not match candidate ${candidate.id}`);
        }
        if (record.decision.kind === "accepted" && record.decision.candidateRevision !== undefined && record.decision.candidateRevision !== (candidate.revision ?? 0)) throw new MemoryCandidateError("accepted candidate evidence revision changed");
        decisions.set(candidate.id, record.decision);
        candidates.set(candidate.id, { ...candidate, updatedAt: record.decision.atMs });
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
