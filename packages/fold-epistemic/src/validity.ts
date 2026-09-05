import type { MemoryApplicability, MemoryCandidateEvidence, MemorySourceCandidateRef, MemoryValidityInput, MemoryRevisionRef } from "./types.js";
import { assertUuidV7 } from "./uuidv7.js";

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) throw new TypeError("invalid memory metadata object");
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 500) throw new TypeError("invalid memory metadata identifier");
  return value;
}
export function memoryRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new TypeError("memory revision must be a nonnegative safe integer");
  return value;
}
export function normalizeMemoryApplicability(value: unknown, legacyProjects: readonly string[] = []): MemoryApplicability {
  if (value === undefined) return legacyProjects.length ? { kind: "projects", projectIds: [...new Set(legacyProjects)].sort() } : { kind: "unresolved" };
  const record = object(value, ["kind", "projectIds"]);
  if (record.kind === "global" || record.kind === "unresolved") {
    if (record.projectIds !== undefined) throw new TypeError("only project applicability may contain projectIds");
    return { kind: record.kind };
  }
  if (record.kind !== "projects" || !Array.isArray(record.projectIds) || record.projectIds.length < 1 || record.projectIds.length > 100) throw new TypeError("project applicability requires 1 to 100 project IDs");
  return { kind: "projects", projectIds: [...new Set(record.projectIds.map(text))].sort() };
}
export function normalizeMemoryRefs(value: unknown): MemoryRevisionRef[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) throw new TypeError("memory references must be an array of at most 100 revisions");
  const refs = value.map((item) => {
    const record = object(item, ["memoryId", "revision"]);
    const memoryId = text(record.memoryId); assertUuidV7(memoryId, "referenced memory id");
    return { memoryId, revision: memoryRevision(record.revision) };
  });
  if (new Set(refs.map(({ memoryId }) => memoryId)).size !== refs.length) throw new TypeError("memory references must name each memory once");
  return refs;
}
export function memoryValidity(value: { applicability?: unknown; sourceMemoryRefs?: unknown; supersedes?: unknown; contradicts?: unknown }, legacyProjects: readonly string[] = []): Required<MemoryValidityInput> {
  return { applicability: normalizeMemoryApplicability(value.applicability, legacyProjects), sourceMemoryRefs: normalizeMemoryRefs(value.sourceMemoryRefs), supersedes: normalizeMemoryRefs(value.supersedes), contradicts: normalizeMemoryRefs(value.contradicts) };
}
export function parseMemorySourceCandidate(value: unknown): MemorySourceCandidateRef | undefined {
  if (value === undefined) return undefined;
  const record = object(value, ["candidateId", "revision", "decisionEventId"]);
  const candidateId = text(record.candidateId); assertUuidV7(candidateId, "source candidate id");
  return { candidateId, revision: memoryRevision(record.revision), decisionEventId: text(record.decisionEventId) };
}
export function normalizeMemoryEvidence(value: unknown, maximum: number, minimum = 0): MemoryCandidateEvidence[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) throw new TypeError(`evidence must contain ${minimum} to ${maximum} entries`);
  return value.map((item) => {
    const record = object(item, ["eventId", "projectId", "runId", "turnId", "relation"]);
    if (record.relation !== undefined && record.relation !== "supports" && record.relation !== "opposes") throw new TypeError("evidence relation must be supports or opposes");
    return { eventId: text(record.eventId), ...(record.projectId === undefined ? {} : { projectId: text(record.projectId) }), ...(record.runId === undefined ? {} : { runId: text(record.runId) }), ...(record.turnId === undefined ? {} : { turnId: text(record.turnId) }), ...(record.relation === undefined ? {} : { relation: record.relation }) };
  });
}
export function mergeMemoryEvidence(...groups: readonly (readonly MemoryCandidateEvidence[])[]): MemoryCandidateEvidence[] {
  const merged = new Map<string, MemoryCandidateEvidence>();
  for (const item of groups.flat()) merged.set(JSON.stringify([item.eventId, item.projectId ?? null, item.runId ?? null, item.turnId ?? null, item.relation ?? "supports"]), item);
  return [...merged.values()];
}

export function memoryValidityJson(value: MemoryValidityInput, legacyProjects: readonly string[] = []): Record<string, import("@_89/fold").JsonValue> {
  const normalized = memoryValidity(value, legacyProjects);
  return { applicability: normalized.applicability.kind === "projects" ? { kind: "projects", projectIds: [...normalized.applicability.projectIds] } : { kind: normalized.applicability.kind }, sourceMemoryRefs: normalized.sourceMemoryRefs.map((ref) => ({ ...ref })), supersedes: normalized.supersedes.map((ref) => ({ ...ref })), contradicts: normalized.contradicts.map((ref) => ({ ...ref })) };
}

export function memoryProjectIds(value: { applicability?: unknown }, legacyProjects: readonly string[] = []): string[] {
  const applicability = normalizeMemoryApplicability(value.applicability, legacyProjects);
  return applicability.kind === "projects" ? [...applicability.projectIds] : [];
}
