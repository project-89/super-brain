import type {
  EpistemicAccessContext,
  PersonalMemory,
  RecallDecision,
} from "./types.js";

export class EpistemicAccessError extends Error {
  override readonly name = "EpistemicAccessError";
}

function nonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) throw new EpistemicAccessError(`${label} must not be empty`);
}

export function validateAccessContext(access: EpistemicAccessContext): void {
  nonEmpty(access.principalId, "principalId");
  nonEmpty(access.workspaceId, "workspaceId");
  if (!(["owner", "admin", "member"] as const).includes(access.workspaceRole)) {
    throw new EpistemicAccessError(`unsupported workspace role: ${access.workspaceRole}`);
  }
  for (const [spaceId, role] of Object.entries(access.spaceRoles)) {
    nonEmpty(spaceId, "space id");
    if (!(["admin", "writer", "reader"] as const).includes(role)) {
      throw new EpistemicAccessError(`unsupported role for space ${spaceId}: ${role}`);
    }
  }
}

export function canAccessSpace(access: EpistemicAccessContext, spaceId: string): boolean {
  validateAccessContext(access);
  nonEmpty(spaceId, "spaceId");
  return access.spaceRoles[spaceId] !== undefined;
}

export function authorizeRecall(
  memory: Pick<PersonalMemory, "workspaceId" | "spaceId" | "creatorId"> & {
    readonly audience?: PersonalMemory["audience"];
  },
  access: EpistemicAccessContext,
): RecallDecision {
  validateAccessContext(access);
  if (memory.workspaceId !== access.workspaceId) {
    return { allowed: false, reason: "workspace-mismatch" };
  }
  if ((memory.audience ?? "personal") === "personal" && memory.creatorId !== access.principalId) {
    return { allowed: false, reason: "creator-mismatch" };
  }
  if (memory.spaceId !== undefined && !canAccessSpace(access, memory.spaceId)) {
    return { allowed: false, reason: "space-inaccessible" };
  }
  return { allowed: true };
}

export function assertCanWritePersonalMemory(
  scope: {
    readonly workspaceId: string;
    readonly spaceId?: string;
    readonly creatorId: string;
    readonly audience?: PersonalMemory["audience"];
  },
  access: EpistemicAccessContext,
): void {
  if (scope.creatorId !== access.principalId) {
    throw new EpistemicAccessError("creator-mismatch: memory writes require the originating creator");
  }
  const decision = authorizeRecall(scope, access);
  if (!decision.allowed) {
    throw new EpistemicAccessError(`personal memory access denied: ${decision.reason}`);
  }
}
