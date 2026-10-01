import { assertUuidV7, memoryValidity, normalizeMemoryEvidence, type MemoryProjection, type PersonalMemory } from "@_89/fold-epistemic";
import { immutable, sha256 } from "./cache.js";

export const MEMORY_CHECKPOINT_VERSION = "memory-projection-v3";
export const MAX_CHECKPOINT_BYTES = 8 * 1024 * 1024;
const canonicalJson = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item !== null && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
const object = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("invalid checkpoint object");
  return value as Record<string, unknown>;
};
function memory(value: unknown): PersonalMemory {
  const row = object(value);
  assertUuidV7(row.id as string, "checkpoint memory id");
  for (const key of ["workspaceId", "creatorId", "source", "summary"]) if (typeof row[key] !== "string") throw new TypeError("invalid checkpoint memory field");
  for (const key of ["revision", "createdAt", "updatedAt"]) if (!Number.isSafeInteger(row[key]) || Number(row[key]) < 0) throw new TypeError("invalid checkpoint memory revision/time");
  if (!["personal", "workspace"].includes(String(row.audience)) || (row.spaceId !== undefined && typeof row.spaceId !== "string")) throw new TypeError("invalid checkpoint audience");
  for (const key of ["tags", "projectIds"]) if (!Array.isArray(row[key]) || !(row[key] as unknown[]).every((item) => typeof item === "string")) throw new TypeError("invalid checkpoint list");
  if (!Array.isArray(row.entities)) throw new TypeError("invalid checkpoint entities");
  for (const entity of row.entities) for (const key of ["id", "name", "type"]) if (typeof object(entity)[key] !== "string") throw new TypeError("invalid checkpoint entity");
  if (row.evidence !== undefined) normalizeMemoryEvidence(row.evidence as Parameters<typeof normalizeMemoryEvidence>[0], 100_000);
  const typed = row as unknown as PersonalMemory;
  memoryValidity(typed, typed.projectIds);
  if (row.currentness !== undefined) {
    const state = object(row.currentness);
    if (!["current", "needs-review", "superseded"].includes(String(state.status)) || !Array.isArray(state.reasons) || !state.reasons.every((reason) => typeof reason === "string")) throw new TypeError("invalid checkpoint currentness");
  }
  return immutable(typed);
}

/** Lightweight read projection; mutation validation always uses the canonical log. */
export async function encodeMemoryCheckpoint(projection: MemoryProjection): Promise<unknown | undefined> {
  const payload = { memories: [...projection.memories.values()] };
  const text = canonicalJson(payload);
  if (new TextEncoder().encode(text).byteLength > MAX_CHECKPOINT_BYTES) return undefined;
  return { version: 1, sha256: await sha256(text), payload };
}

export async function decodeMemoryCheckpoint(value: unknown): Promise<MemoryProjection | undefined> {
  try {
    const envelope = object(value), payload = object(envelope.payload), text = canonicalJson(payload);
    if (envelope.version !== 1 || new TextEncoder().encode(text).byteLength > MAX_CHECKPOINT_BYTES || envelope.sha256 !== await sha256(text) || !Array.isArray(payload.memories)) return undefined;
    const rows = payload.memories.map(memory);
    if (new Set(rows.map(({ id }) => id)).size !== rows.length) return undefined;
    return { memories: new Map(rows.map((row) => [row.id, row])), forgotten: new Map() };
  } catch { return undefined; }
}
