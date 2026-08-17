import type {
  ComponentRegistry,
  FoldEvent,
  FoldLogEntry,
  FoldState,
} from "@_89/fold";
import type {
  EpistemicAccessContext,
  ForgottenMemory,
  PersonalMemory,
} from "@_89/fold-epistemic";

export type FoldSdkAccessContext = EpistemicAccessContext;

export interface FoldSdkStore {
  read(options?: { readonly missing?: "error" | "empty" }): Promise<{
    readonly entries: readonly FoldLogEntry[];
  }>;
  append(entry: FoldLogEntry): Promise<void>;
}

export interface FoldSdkCursor {
  readonly t: number;
  readonly eventId: string;
}

export interface FoldSdkReadOptions {
  readonly include?: "canon" | "canon+draft";
  readonly cursor?: FoldSdkCursor;
}

export interface FoldSdkListOptions extends FoldSdkReadOptions {
  readonly kinds?: readonly string[];
}

export interface FoldSdkProjectOptions extends FoldSdkReadOptions {
  readonly components?: ComponentRegistry;
}

export interface FoldSdkProjection {
  readonly entries: readonly FoldLogEntry[];
  readonly state: FoldState;
}

export type FoldEventAccessDenialReason =
  | "workspace-mismatch"
  | "creator-mismatch"
  | "space-inaccessible";

export type FoldEventAccessDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: FoldEventAccessDenialReason };

export interface MemoryMutationResult {
  readonly event: FoldEvent;
  readonly memory: PersonalMemory;
}

export interface MemoryForgetResult {
  readonly event: FoldEvent;
  readonly forgotten: ForgottenMemory;
}
