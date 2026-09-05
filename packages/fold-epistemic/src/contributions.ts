import { parseEvent, type FoldEvent } from "@_89/fold";
import { memoryWriteAuthority } from "./access.js";
import { memoryRevision, normalizeMemoryEvidence } from "./validity.js";
import type { EpistemicEventContext, EpistemicEventStamp, MemoryAudience, MemoryCandidate, MemoryCandidateEvidence, MemoryWriteAuthority, PersonalMemory } from "./types.js";

export interface MemoryEvidenceContribution {
  readonly target: "memory" | "candidate";
  readonly targetId: string;
  readonly actorId: string;
  readonly workspaceId: string;
  readonly spaceId?: string;
  readonly audience: MemoryAudience;
  readonly authority: MemoryWriteAuthority;
  readonly baseRevision: number;
  readonly evidence: readonly MemoryCandidateEvidence[];
  readonly atMs: number;
  readonly eventId: string;
}
export function makeMemoryEvidenceContributedEvent(context: EpistemicEventContext, stamp: EpistemicEventStamp, memory: PersonalMemory, evidence: readonly MemoryCandidateEvidence[]): FoldEvent {
  return makeContribution(context, stamp, "memory", memory.id, memory, memory.revision, evidence);
}
export function makeMemoryCandidateEvidenceContributedEvent(context: EpistemicEventContext, stamp: EpistemicEventStamp, candidate: MemoryCandidate, evidence: readonly MemoryCandidateEvidence[]): FoldEvent {
  return makeContribution(context, stamp, "candidate", candidate.id, { ...candidate, creatorId: candidate.proposerId }, candidate.revision ?? 0, evidence);
}
function makeContribution(context: EpistemicEventContext, stamp: EpistemicEventStamp, target: MemoryEvidenceContribution["target"], targetId: string, scope: Pick<PersonalMemory, "creatorId" | "workspaceId" | "spaceId" | "audience">, baseRevision: number, evidence: readonly MemoryCandidateEvidence[]): FoldEvent {
  const authority = memoryWriteAuthority(scope, context.access);
  const normalized = normalizeMemoryEvidence(evidence, 100, 1);
  const event = parseEvent({ specVersion: "0.7", id: stamp.id, kind: target === "memory" ? "memory.evidence-contributed" : "memory.candidate-evidence-contributed", title: `Evidence contributed to ${target} ${targetId}`, at: { t: stamp.t, worldDate: stamp.worldDate, granularity: "beat" }, participants: [context.access.principalId], author: context.author, capture: context.capture, changes: [{ verb: "create", subject: `urn:fold-record:${stamp.id}`, nodeKind: "x.fold.memory-evidence-contribution", provenance: { basis: "authored" }, after: { target, targetId, actorId: context.access.principalId, workspaceId: scope.workspaceId, ...(scope.spaceId === undefined ? {} : { spaceId: scope.spaceId }), audience: scope.audience, authority, baseRevision, evidence: normalized.map((item) => ({ ...item })), atMs: stamp.t } }] });
  memoryEvidenceContributionsFromEvent(event);
  return event;
}
export function memoryEvidenceContributionsFromEvent(event: FoldEvent): MemoryEvidenceContribution[] {
  const result: MemoryEvidenceContribution[] = [];
  for (const change of event.changes) {
    if (change.verb !== "create" || change.nodeKind !== "x.fold.memory-evidence-contribution") continue;
    const p = change.after;
    const target = p.target;
    const audience = p.audience;
    const authority = p.authority;
    const expectedKind = target === "memory" ? "memory.evidence-contributed" : "memory.candidate-evidence-contributed";
    if ((target !== "memory" && target !== "candidate") || (audience !== "personal" && audience !== "workspace") || (authority !== "creator" && authority !== "workspace-writer" && authority !== "space-writer") || event.kind !== expectedKind || change.subject !== `urn:fold-record:${event.id}` || change.provenance?.basis !== "authored") throw new TypeError("invalid evidence contribution envelope");
    const { targetId, actorId, workspaceId, spaceId, atMs } = p;
    if (typeof targetId !== "string" || !targetId || typeof actorId !== "string" || !actorId || typeof workspaceId !== "string" || (spaceId !== undefined && typeof spaceId !== "string") || typeof atMs !== "number" || atMs !== event.at.t || workspaceId !== event.capture.scope.workspace || spaceId !== event.capture.scope.space || event.capture.scope.creator !== (audience === "personal" ? actorId : undefined) || event.capture.identity?.principal !== actorId || event.capture.identity.workspace !== workspaceId || !event.participants?.includes(actorId)) throw new TypeError("evidence contributor identity or scope does not match event");
    result.push({ target, targetId, actorId, workspaceId, ...(spaceId === undefined ? {} : { spaceId }), audience, authority, atMs, eventId: event.id, baseRevision: memoryRevision(p.baseRevision), evidence: normalizeMemoryEvidence(p.evidence, 100, 1) });
  }
  if ((event.kind === "memory.evidence-contributed" || event.kind === "memory.candidate-evidence-contributed") && (result.length !== 1 || event.changes.length !== 1)) throw new TypeError("evidence contribution must contain exactly one record");
  return result;
}
