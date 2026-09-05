import { compareEventKeys, type FoldEvent } from "@_89/fold";

import { forgottenMemoryFromRecord, memoryLogRecordsFromEvent } from "./events.js";
import type { ForgottenMemory, MemoryProjection, PersonalMemory } from "./types.js";
import { rebuildMemoryCandidates } from "./candidates.js";
import { memoryEvidenceContributionsFromEvent } from "./contributions.js";
import { validReplayMemoryAuthority } from "./access.js";
import { mergeMemoryEvidence, memoryValidity } from "./validity.js";
import { assertUuidV7 } from "./uuidv7.js";

export class MemoryProjectionError extends Error {
  override readonly name = "MemoryProjectionError";
}

export function rebuildMemories(events: readonly FoldEvent[]): MemoryProjection {
  const memories = new Map<string, PersonalMemory>();
  const forgotten = new Map<string, ForgottenMemory>();
  const revisions = new Map<string, Map<number, PersonalMemory>>();
  const claimRevisions = new Map<string, number>();
  const candidates = rebuildMemoryCandidates(events);
  const retain = (memory: PersonalMemory) => {
    memories.set(memory.id, memory);
    const history = revisions.get(memory.id) ?? new Map<number, PersonalMemory>();
    history.set(memory.revision, memory); revisions.set(memory.id, history);
  };
  for (const event of [...events].sort(compareEventKeys)) {
    for (const contribution of memoryEvidenceContributionsFromEvent(event).filter(({ target }) => target === "memory")) {
      const current = memories.get(contribution.targetId);
      if (current === undefined || current.revision !== contribution.baseRevision || contribution.atMs < current.updatedAt || contribution.workspaceId !== current.workspaceId || contribution.spaceId !== current.spaceId || contribution.audience !== current.audience || !validReplayMemoryAuthority(current, contribution.actorId, contribution.authority)) throw new MemoryProjectionError("memory evidence contribution does not match active revision or authority");
      retain({ ...current, evidence: mergeMemoryEvidence(current.evidence ?? [], contribution.evidence), revision: current.revision + 1, updatedAt: contribution.atMs });
    }
    for (const record of memoryLogRecordsFromEvent(event)) {
      if (record.recordType === "recorded") {
        if (record.actorId !== record.memory.creatorId) {
          throw new MemoryProjectionError(`memory ${record.memory.id} creator does not match event principal`);
        }
        if (record.workspaceId !== record.memory.workspaceId) {
          throw new MemoryProjectionError(`memory ${record.memory.id} workspace does not match event`);
        }
        if (record.spaceId !== record.memory.spaceId) {
          throw new MemoryProjectionError(`memory ${record.memory.id} space does not match event`);
        }
        if (memories.has(record.memory.id) || forgotten.has(record.memory.id)) {
          throw new MemoryProjectionError(`memory ${record.memory.id} was recorded more than once`);
        }
        const source = record.memory.sourceCandidate;
        let memory = record.memory;
        if (source !== undefined) {
          const candidate = candidates.candidates.get(source.candidateId);
          const decision = candidates.decisions.get(source.candidateId);
          if (candidate === undefined || decision?.kind !== "accepted" || decision.memoryId !== memory.id || decision.eventId !== source.decisionEventId || decision.candidateRevision !== source.revision || (candidate.revision ?? 0) !== source.revision || candidate.workspaceId !== memory.workspaceId || candidate.spaceId !== memory.spaceId || candidate.audience !== memory.audience || (candidate.audience === "personal" && candidate.proposerId !== memory.creatorId) || decision.atMs > event.at.t || !event.causedBy?.includes(decision.eventId)) throw new MemoryProjectionError("memory source candidate does not match exact authorized accepted snapshot");
          memory = { ...memory, evidence: mergeMemoryEvidence(candidate.evidence, memory.evidence ?? []) };
        }
        claimRevisions.set(memory.id, 0);
        retain(memory);
      } else {
        assertUuidV7(record.memoryId, "memory id");
        const current = memories.get(record.memoryId);
        if (current === undefined) {
          throw new MemoryProjectionError(`${record.recordType} references inactive memory ${record.memoryId}`);
        }
        if (
          !validReplayMemoryAuthority(current, record.actorId, record.authority) ||
          (record.baseRevision !== undefined && record.baseRevision !== current.revision) ||
          current.workspaceId !== record.workspaceId ||
          current.spaceId !== record.spaceId ||
          current.audience !== record.audience
        ) {
          throw new MemoryProjectionError(`${record.recordType} principal does not own memory ${record.memoryId}`);
        }
        if (record.atMs < current.updatedAt) {
          throw new MemoryProjectionError(`${record.recordType} predates memory ${record.memoryId}`);
        }
        if (record.recordType === "revised") {
          if (["summary", "content", "applicability", "sourceMemoryRefs", "supersedes", "contradicts"].some((key) => key in record.patch)) claimRevisions.set(current.id, current.revision + 1);
          retain({
            ...current,
            ...record.patch,
            ...(record.patch.applicability === undefined ? {} : { projectIds: record.patch.applicability.kind === "projects" ? [...record.patch.applicability.projectIds] : [] }),
            updatedAt: record.atMs,
            revision: current.revision + 1,
          });
        } else {
          memories.delete(record.memoryId);
          forgotten.set(record.memoryId, { ...forgottenMemoryFromRecord(record), creatorId: current.creatorId });
        }
      }
    }
  }
  const statuses = new Map<string, NonNullable<PersonalMemory["currentness"]>>();
  const currentness = (id: string, visiting: ReadonlySet<string>): NonNullable<PersonalMemory["currentness"]> => {
    const cached = statuses.get(id); if (cached !== undefined) return cached;
    if (visiting.has(id)) return { status: "needs-review", reasons: ["dependency-cycle"] };
    const memory = memories.get(id); if (memory === undefined) return { status: "needs-review", reasons: ["source-unavailable"] };
    const path = new Set([...visiting, id]);
    const reasons: string[] = [];
    const validity = memoryValidity(memory, memory.projectIds);
    if (validity.applicability.kind === "unresolved") reasons.push("applicability-unresolved");
    if (memory.source === "continuous-cognition" && validity.sourceMemoryRefs.length === 0) reasons.push("unversioned-derivation");
    for (const ref of validity.sourceMemoryRefs) {
      const source = memories.get(ref.memoryId);
      if (source === undefined) reasons.push("source-unavailable");
      else if (source.revision !== ref.revision) reasons.push("source-revised");
      else if (currentness(source.id, path).status !== "current") reasons.push("source-needs-review");
    }
    if (memory.evidence?.some((item) => !events.some((event) => event.id === item.eventId))) reasons.push("evidence-unavailable");
    if (memory.evidence?.some((item) => item.relation === "opposes")) reasons.push("opposing-evidence");
    const sameClaim = (ref: { memoryId: string; revision: number }, target: PersonalMemory) => ref.memoryId === target.id && ref.revision >= (claimRevisions.get(target.id) ?? target.revision) && ref.revision <= target.revision;
    let superseded = false;
    for (const other of memories.values()) {
      if (other.supersedes?.some((ref) => sameClaim(ref, memory))) superseded = true;
      if (other.contradicts?.some((ref) => sameClaim(ref, memory))) reasons.push("contradictory-memory");
    }
    if (validity.contradicts.some((ref) => { const target = memories.get(ref.memoryId); return target !== undefined && sameClaim(ref, target); })) reasons.push("contradictory-memory");
    const result = { status: superseded ? "superseded" as const : reasons.length ? "needs-review" as const : "current" as const, reasons: [...new Set(superseded ? [...reasons, "superseded"] : reasons)] };
    statuses.set(id, result); return result;
  };
  for (const [id, memory] of memories) memories.set(id, { ...memory, ...memoryValidity(memory, memory.projectIds), currentness: currentness(id, new Set()) });
  return { memories, forgotten, revisions };
}

export function activeMemoryById(
  projection: MemoryProjection,
  memoryId: string,
): PersonalMemory | undefined {
  assertUuidV7(memoryId, "memory id");
  return projection.memories.get(memoryId);
}
