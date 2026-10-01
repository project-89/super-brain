import type { MemoryApplicability } from "./types";

/** UI-level classification of a memory's applicability, derived from the canonical structured value. */
export type MemoryApplicabilityKind = "project" | "general" | "unresolved";

interface ApplicableMemory {
  readonly applicability?: MemoryApplicability;
  readonly projectIds: readonly string[];
}

/** Legacy records without explicit applicability but with project ids remain project-scoped; nothing is presented as general implicitly. */
export function effectiveMemoryApplicability(memory: ApplicableMemory): MemoryApplicabilityKind {
  const applicability = memory.applicability;
  if (applicability === undefined) return memory.projectIds.length > 0 ? "project" : "unresolved";
  if (applicability.kind === "global") return "general";
  if (applicability.kind === "projects") return applicability.projectIds.length > 0 ? "project" : "unresolved";
  return "unresolved";
}

function applicableProjectIds(memory: ApplicableMemory): readonly string[] {
  return memory.applicability?.kind === "projects" ? memory.applicability.projectIds : memory.projectIds;
}

export function memoryApplicabilityLabel(memory: ApplicableMemory, projectNames: ReadonlyMap<string, string>): string {
  const applicability = effectiveMemoryApplicability(memory);
  if (applicability === "general") return "All projects (explicit)";
  if (applicability === "unresolved") return "Needs project review";
  return applicableProjectIds(memory).map((id) => projectNames.get(id) ?? id).join(", ");
}
