import type { FoldEvent } from "@_89/fold";
import type { TrajectoryInput, TrajectoryTreeRecord, TrajectoryManifest, TraceRuntimeObservation, AttemptContext } from "@_89/fold-trajectory";
import type { EventStamp } from "@_89/super-brain-client";
import type { AnonymizationPolicy } from "@_89/super-brain-importer";

export type HookSource = "claude-code" | "codex" | "hermes" | "unknown";
export type ReasoningPolicy = "exclude" | "include";
export type ReasoningTreePolicy = "exclude" | "summaries";
export type TrajectoryFinalizationReason = "stop" | "prompt-boundary" | "session-end" | "orphan-timeout";

export interface RepositoryCapturePolicy {
  readonly mode: "metadata-only" | "snapshot";
  readonly roots: readonly string[];
  readonly maxBytes: number;
  readonly maxFiles: number;
  readonly includeUntracked: boolean;
  readonly includeBinary: boolean;
}

export interface CaptureConfig {
  readonly apiUrl: string;
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly apiToken: string;
  readonly sensorId: string;
  readonly hookToken: string;
  readonly operatorToken: string;
  readonly bindHost: "127.0.0.1" | "::1";
  readonly port: number;
  readonly heartbeatWindowMs: number;
  readonly heartbeatIntervalMs: number;
  readonly orphanAfterMs: number;
  readonly stateRoot: string;
  readonly vaultRoot: string;
  readonly vaultKeyPath?: string;
  readonly processingStatusFile?: string;
  readonly reasoningPolicy: ReasoningPolicy;
  readonly retainEncryptedReasoning: boolean;
  readonly reasoningTreePolicy: ReasoningTreePolicy;
  readonly treeSnapshotEveryEvents: number;
  readonly anonymizationPolicy: AnonymizationPolicy;
  readonly anonymizationKeyPath?: string;
  readonly repositoryCapture?: RepositoryCapturePolicy;
}

export interface CapturePolicySettings {
  readonly reasoningPolicy: ReasoningPolicy;
  readonly retainEncryptedReasoning: boolean;
  readonly reasoningTreePolicy: ReasoningTreePolicy;
  readonly treeSnapshotEveryEvents: number;
  readonly anonymizationPolicy: AnonymizationPolicy;
  readonly repositoryCapture?: RepositoryCapturePolicy;
}

export type CapturePolicyPatch = Partial<CapturePolicySettings>;

export interface ProjectIdentity {
  readonly id: string;
  readonly name: string;
  readonly root: string;
  readonly branch: string;
  readonly remote?: string;
  readonly head?: string;
  readonly worktreeDigest?: string;
  readonly fingerprintStatus?: "available" | "unavailable";
  readonly fingerprintReason?: "git-or-file-unavailable" | "unsupported-checkout";
  readonly changedPaths?: readonly string[];
  readonly dirty?: boolean;
}

export interface HookAuthority {
  readonly kind: "local-operator";
  readonly principalId: string;
  readonly authenticatedAt: string;
}

export interface TaskAcceptanceEvidence {
  readonly version: 1;
  readonly taskId: string;
  readonly attemptId: string;
  readonly revisionId: string;
  readonly verdict: "success" | "failure";
  readonly criterionIds?: readonly string[];
  readonly artifactId: string;
  readonly eventId?: string;
  readonly authority: HookAuthority;
}

export interface VerificationEvidence {
  readonly category: "test" | "build" | "lint" | "typecheck";
  readonly result: "success" | "failure" | "unknown";
  readonly artifactId: string;
  readonly eventId: string;
  readonly revisionId?: string;
}

export type CapturedStep = TrajectoryInput["steps"][number] & {
  readonly nodeKind: "decision" | "action" | "observation";
};

export interface CaptureSession {
  readonly sessionId: string;
  readonly source: HookSource;
  readonly agent: string;
  readonly startedAt: string;
  readonly project: ProjectIdentity;
  readonly transcriptPath?: string;
  readonly model?: string;
  readonly harnessVersion?: string;
  readonly permissionMode?: string;
  readonly currentTurnId?: string;
  readonly runtime?: TraceRuntimeObservation;
  readonly context?: AttemptContext;
  readonly manifest?: TrajectoryManifest;
  /** Private, never copied into canonical trajectory metadata. */
  readonly startSourceRevisionId?: string;
  readonly comparisonKey?: string;
  readonly taskKey?: string;
  readonly steeringIntentionIds?: readonly string[];
  readonly steps: readonly CapturedStep[];
  readonly stepCount?: number;
  readonly truncatedStepCount?: number;
  readonly recoveredStepCount?: number;
  readonly evaluationUnitVersion?: 2;
  readonly currentUnitStartStepNumber?: number;
  readonly currentUnitEndStepNumber?: number;
  readonly completedUnitCount?: number;
  readonly finalizedThroughStepNumber?: number;
  readonly pendingTools?: Readonly<Record<string, {
    readonly artifactId: string;
    readonly startedAt: string;
    readonly eventTime: number;
    readonly toolName: string;
    readonly eventId: string;
  }>>;
  readonly acceptance?: TaskAcceptanceEvidence;
  readonly checks?: readonly VerificationEvidence[];
  readonly lastVerification?: "success" | "failure";
  readonly explicitOutcome?: "success" | "failure";
  readonly reviewText?: string;
  readonly lastEventId?: string;
  readonly finalized: boolean;
  readonly active: boolean;
  readonly lastSeenAt: string;
  readonly finalizationReason?: "session-end" | "orphan-timeout";
  readonly observedEventCount?: number;
  readonly lastTreeSnapshotEventCount?: number;
  readonly reasoningCursor?: number;
  readonly runtimeCursor?: number;
  readonly seenReasoningIds?: readonly string[];
}

export interface CaptureState {
  readonly version: 1;
  readonly lastEventTime: number;
  readonly lastHookAt?: string;
  readonly receivedHooks?: number;
  readonly duplicateHooks?: number;
  readonly seenArtifacts: readonly string[];
  readonly seenArtifactTimes?: Readonly<Record<string, number>>;
  readonly sessions: Readonly<Record<string, CaptureSession>>;
}

export type SpoolJob =
  | {
      readonly version: 1;
      readonly kind: "trajectory-tree";
      readonly id: string;
      readonly createdAt: string;
      readonly treeStamp: EventStamp;
      readonly tree: TrajectoryTreeRecord["tree"];
      readonly captureIdentity: Readonly<Record<string, string>>;
    }
  | {
      readonly version: 1;
      readonly kind: "event";
      readonly id: string;
      readonly createdAt: string;
      readonly event: FoldEvent;
    }
  | {
      readonly version: 1;
      readonly kind: "trajectory";
      readonly id: string;
      readonly createdAt: string;
      readonly treeStamp: EventStamp;
      readonly runStamp: EventStamp;
      readonly tree: TrajectoryTreeRecord["tree"];
      readonly input: TrajectoryInput;
      readonly captureIdentity: Readonly<Record<string, string>>;
      readonly privateRevisionBinding?: {
        readonly startSourceRevisionId?: string;
        readonly startPublicRevisionId?: string;
        readonly finalSourceRevisionId?: string;
        readonly finalPublicRevisionId?: string;
      };
    }
  | {
      readonly version: 1;
      readonly kind: "transcript";
      readonly id: string;
      readonly createdAt: string;
      readonly notBefore: string;
      readonly deadlineAt: string;
      readonly source: HookSource;
      readonly path: string;
      readonly ownedSnapshot?: true;
    };

export interface VaultArtifact {
  readonly id: string;
  readonly receivedAt: string;
  readonly eventTime: number;
  readonly path: string;
  readonly receiptId?: string;
  readonly authority?: HookAuthority;
}

export interface StoredHookArtifact extends Omit<VaultArtifact, "path"> {
  readonly source: HookSource;
  readonly payload: Record<string, unknown>;
}
