import type { FoldEvent } from "@_89/fold";
import type { TrajectoryInput, TrajectoryTreeRecord } from "@_89/fold-trajectory";
import type { EventStamp } from "@_89/super-brain-client";

export type HookSource = "claude-code" | "codex" | "hermes" | "unknown";
export type ReasoningPolicy = "exclude" | "include";

export interface CaptureConfig {
  readonly apiUrl: string;
  readonly workspaceId: string;
  readonly apiToken: string;
  readonly sensorId: string;
  readonly hookToken: string;
  readonly bindHost: "127.0.0.1" | "::1";
  readonly port: number;
  readonly heartbeatWindowMs: number;
  readonly heartbeatIntervalMs: number;
  readonly stateRoot: string;
  readonly vaultRoot: string;
  readonly reasoningPolicy: ReasoningPolicy;
}

export interface ProjectIdentity {
  readonly id: string;
  readonly name: string;
  readonly root: string;
  readonly branch: string;
  readonly remote?: string;
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
  readonly comparisonKey?: string;
  readonly steps: readonly CapturedStep[];
  readonly lastVerification?: "success" | "failure";
  readonly explicitOutcome?: "success" | "failure";
  readonly reviewText?: string;
  readonly finalized: boolean;
  readonly active: boolean;
  readonly lastSeenAt: string;
}

export interface CaptureState {
  readonly version: 1;
  readonly lastEventTime: number;
  readonly seenArtifacts: readonly string[];
  readonly sessions: Readonly<Record<string, CaptureSession>>;
}

export type SpoolJob =
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
