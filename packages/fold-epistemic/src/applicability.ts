import type { MemoryApplicability } from "./types.js";

interface ApplicableMemory {
  readonly applicability?: MemoryApplicability;
  readonly projectIds: readonly string[];
}

export function parseMemoryApplicability(value: unknown): MemoryApplicability {
  if (value !== "project" && value !== "general" && value !== "unresolved") {
    throw new TypeError("memory applicability must be project, general, or unresolved");
  }
  return value;
}

export function validateMemoryApplicability(memory: ApplicableMemory): void {
  if (memory.applicability === undefined) return;
  const applicability = parseMemoryApplicability(memory.applicability);
  if (applicability === "project" ? memory.projectIds.length === 0 : memory.projectIds.length > 0) {
    throw new TypeError(applicability === "project"
      ? "project applicability requires at least one projectId"
      : `${applicability} applicability requires empty projectIds`);
  }
}

// Legacy unassigned records remain unresolved; absence never implies general reuse.
export function effectiveMemoryApplicability(memory: ApplicableMemory): MemoryApplicability {
  return memory.applicability ?? (memory.projectIds.length > 0 ? "project" : "unresolved");
}

export function matchesMemoryProjects(memory: ApplicableMemory, projectIds: readonly string[] = []): boolean {
  if (projectIds.length === 0) return true;
  const applicability = effectiveMemoryApplicability(memory);
  if (applicability === "general") return true;
  return applicability === "project" && memory.projectIds.some((id) => projectIds.includes(id));
}
