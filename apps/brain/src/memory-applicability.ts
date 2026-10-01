import type { MemoryApplicability } from "./types";

interface ApplicableMemory {
  readonly applicability?: MemoryApplicability;
  readonly projectIds: readonly string[];
}

export function effectiveMemoryApplicability(memory: ApplicableMemory): MemoryApplicability {
  return memory.applicability ?? (memory.projectIds.length > 0 ? "project" : "unresolved");
}

export function memoryApplicabilityLabel(memory: ApplicableMemory, projectNames: ReadonlyMap<string, string>): string {
  const applicability = effectiveMemoryApplicability(memory);
  if (applicability === "general") return "General";
  if (applicability === "unresolved") return "Unresolved";
  return memory.projectIds.map((id) => projectNames.get(id) ?? id).join(", ");
}
