import type { FoldEvent } from "@_89/fold";
import { canAccessSpace, validateAccessContext } from "@_89/fold-epistemic";

import type {
  FoldEventAccessDecision,
  FoldSdkAccessContext,
} from "./types.js";

export class FoldSdkAccessError extends Error {
  override readonly name = "FoldSdkAccessError";
}

export function authorizeEventAccess(
  event: Pick<FoldEvent, "capture">,
  access: FoldSdkAccessContext,
): FoldEventAccessDecision {
  validateAccessContext(access);
  if (event.capture.scope.workspace !== access.workspaceId) {
    return { allowed: false, reason: "workspace-mismatch" };
  }
  if (
    event.capture.scope.creator !== undefined &&
    event.capture.scope.creator !== access.principalId
  ) {
    return { allowed: false, reason: "creator-mismatch" };
  }
  if (
    event.capture.scope.space !== undefined &&
    !canAccessSpace(access, event.capture.scope.space)
  ) {
    return { allowed: false, reason: "space-inaccessible" };
  }
  return { allowed: true };
}

export function assertCanAppendEvent(
  event: Pick<FoldEvent, "capture">,
  access: FoldSdkAccessContext,
): void {
  const decision = authorizeEventAccess(event, access);
  if (!decision.allowed) {
    throw new FoldSdkAccessError(`event append denied: ${decision.reason}`);
  }
}
