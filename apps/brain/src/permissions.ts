import type { AuthorizedIdentity } from "@_89/super-brain-client";
import type { MemoryCandidate, PersonalMemory } from "@_89/fold-epistemic";
export function hasCapability(access: AuthorizedIdentity | undefined, capability: string): boolean { return access !== undefined && access.platformDataAccess !== true && access.capabilities.includes(capability); }
export function mayEditMemory(access: AuthorizedIdentity | undefined, memory: Pick<PersonalMemory, "workspaceId" | "spaceId" | "audience" | "creatorId">): boolean {
  if (!hasCapability(access, "memories:write") || access!.workspaceId !== memory.workspaceId || access!.workspaceRole === "viewer") return false;
  if (memory.audience === "personal" && memory.creatorId !== access!.principalId) return false;
  if (memory.spaceId !== undefined && (memory.audience === "workspace" ? !["admin", "writer"].includes(access!.spaceRoles[memory.spaceId] ?? "") : access!.spaceRoles[memory.spaceId] === undefined)) return false;
  return true;
}
export function mayReviewCandidate(access: AuthorizedIdentity | undefined, candidate: MemoryCandidate): boolean {
  return mayEditMemory(access, { ...candidate, creatorId: candidate.proposerId }) && (candidate.audience === "personal" || ["owner", "admin"].includes(access!.workspaceRole));
}
export function applicabilityLabel(memory: Pick<PersonalMemory, "applicability" | "projectIds">): string {
  if (memory.applicability?.kind === "global") return "All projects (explicit)";
  if (memory.applicability?.kind === "projects") return memory.applicability.projectIds.join(", ");
  return "Needs project review";
}

export function currentnessReasonLabel(reason: string): string {
  const labels: Readonly<Record<string, string>> = { "applicability-unresolved": "Project applicability needs review", "opposing-evidence": "A source disputes this memory", "source-revised": "A source memory has changed", "source-forgotten": "A source memory was forgotten", "source-superseded": "A source memory was superseded", "source-needs-review": "A source memory needs review", "source-revision-unavailable": "The referenced source revision is unavailable", "dependency-cycle": "The source references contain a cycle" };
  return labels[reason] ?? reason.replaceAll("-", " ");
}
