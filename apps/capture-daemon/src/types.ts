import type { FoldEvent } from "@_89/fold";
import type { TrajectoryInput, TrajectoryTreeRecord } from "@_89/fold-trajectory";
import type { EventStamp } from "@_89/super-brain-client";
import type { AnonymizationPolicy } from "@_89/super-brain-importer";

export type HookSource = "claude-code" | "codex" | "hermes" | "unknown";
export type ReasoningPolicy = "exclude" | "include";
export type ReasoningTreePolicy = "exclude" | "summaries";

export interface CaptureConfig {
  readonly apiUrl: string;
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
  readonly reasoningPolicy: ReasoningPolicy;
  readonly retainEncryptedReasoning: boolean;
  readonly reasoningTreePolicy: ReasoningTreePolicy;
  readonly treeSnapshotEveryEvents: number;
  readonly anonymizationPolicy: AnonymizationPolicy;
  readonly anonymizationKeyPath?: string;
}

export interface CapturePolicySettings {
  readonly reasoningPolicy: ReasoningPolicy;
  readonly retainEncryptedReasoning: boolean;
  readonly reasoningTreePolicy: ReasoningTreePolicy;
  readonly treeSnapshotEveryEvents: number;
  readonly anonymizationPolicy: AnonymizationPolicy;
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
  readonly changedPaths?: readonly string[];
  readonly dirty?: boolean;
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
  readonly comparisonKey?: string;
  readonly taskKey?: string;
  readonly steps: readonly CapturedStep[];
  readonly truncatedStepCount?: number;
  readonly pendingTools?: Readonly<Record<string, {
    readonly artifactId: string;
    readonly startedAt: string;
    readonly eventTime: number;
    readonly toolName: string;
    readonly eventId: string;
  }>>;
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
  readonly seenReasoningIds?: readonly string[];
}

export interface CaptureState {
  readonly version: 1;
  readonly lastEventTime: number;
  readonly lastHookAt?: string;
  readonly receivedHooks?: number;
  readonly seenArtifacts: readonly string[];
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
    };

export interface VaultArtifact {
  readonly id: string;
  readonly receivedAt: string;
  readonly eventTime: number;
  readonly path: string;
}
