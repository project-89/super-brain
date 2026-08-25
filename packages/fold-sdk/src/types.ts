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
import type {
  TrajectoryRunRecord,
  TrajectoryTaskReport,
  TrajectoryTreeRecord,
} from "@_89/fold-trajectory";
import type { FleetSessionSnapshot, OrphanRecoveryAction } from "@_89/fold-fleet";
import type { TerminalSensorContext } from "@_89/fold-activity";

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

export interface TrajectoryTreeMutationResult {
  readonly event: FoldEvent;
  readonly record: TrajectoryTreeRecord;
}

export interface TrajectoryMutationResult {
  readonly event: FoldEvent;
  readonly record: TrajectoryRunRecord;
}

export interface TrajectoryTaskSummary {
  readonly taskId: string;
  readonly tree: TrajectoryTreeRecord["tree"];
  readonly trajectoryCount: number;
  readonly successCount: number;
  readonly failureCount: number;
  readonly lastRecordedAt: number;
}

export interface ActivityMutationResult {
  readonly event: FoldEvent;
}

export interface FoldSdkActivityContext extends TerminalSensorContext {
  readonly access: FoldSdkAccessContext;
}

export interface FleetReadModel {
  readonly rebuiltAt: string;
  readonly sessions: readonly FleetSessionSnapshot[];
  readonly recoveryActions: readonly OrphanRecoveryAction[];
}

export type { TrajectoryTaskReport };
