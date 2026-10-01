import type { LegacyMemoryApplicability, MemoryApplicability } from "./types.js";
import { normalizeMemoryApplicability } from "./validity.js";

interface ApplicableMemory {
  readonly applicability?: MemoryApplicability | LegacyMemoryApplicability;
  readonly projectIds: readonly string[];
}

/**
 * Parses canonical applicability, also accepting the legacy string encoding
 * (`project` | `general` | `unresolved`) paired with separate project IDs.
 */
export function parseMemoryApplicability(value: unknown, projectIds: readonly string[] = []): MemoryApplicability {
  return normalizeMemoryApplicability(value, projectIds);
}

/** Rejects applicability that disagrees with the record's derived project IDs. */
export function validateMemoryApplicability(memory: ApplicableMemory): void {
  if (memory.applicability === undefined) return;
  const applicability = normalizeMemoryApplicability(memory.applicability, memory.projectIds);
  const expected = applicability.kind === "projects" ? applicability.projectIds : [];
  const actual = [...new Set(memory.projectIds.map((id) => id.trim()))].sort();
  if (expected.length !== actual.length || expected.some((id, index) => id !== actual[index])) {
    throw new TypeError(applicability.kind === "projects"
      ? "project applicability requires matching projectIds"
      : `${applicability.kind} applicability requires empty projectIds`);
  }
}

// Legacy unassigned records remain unresolved; absence never implies global reuse.
export function effectiveMemoryApplicability(memory: ApplicableMemory): MemoryApplicability {
  return normalizeMemoryApplicability(memory.applicability, memory.projectIds);
}

/** Project-filtered relevance: global records and intersecting project records match; unresolved never does. */
export function matchesMemoryProjects(memory: ApplicableMemory, projectIds: readonly string[] = []): boolean {
  if (projectIds.length === 0) return true;
  const applicability = effectiveMemoryApplicability(memory);
  if (applicability.kind === "global") return true;
  return applicability.kind === "projects" && applicability.projectIds.some((id) => projectIds.includes(id));
}
