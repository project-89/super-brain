import type { CaptureEnvelope } from "@_89/fold";

export type TraceOutcome = "success" | "failure" | "unknown";

/** References describe canonical metadata; private byte availability requires a local witness. */
export interface TrajectoryArtifactRef {
  readonly artifactId: string;
  readonly kind: "task-spec" | "input" | "repository-snapshot" | "context" | "outcome";
  readonly sha256?: string;
  readonly byteLength?: number;
}
export interface TaskManifest {
  readonly version: 1;
  readonly taskId: string;
  readonly taskVersion: string;
  readonly goal?: string;
  readonly acceptanceCriteria?: readonly { readonly id: string; readonly description?: string }[];
  readonly specification?: TrajectoryArtifactRef;
  readonly inputs?: readonly TrajectoryArtifactRef[];
}
export interface AttemptRevisionRef {
  readonly fingerprintStatus: "available" | "unavailable";
  readonly revisionId?: string;
  readonly commit?: string;
  readonly snapshot?: TrajectoryArtifactRef;
  readonly reconstruction?: "complete" | "partial" | "unavailable";
}
export interface AttemptContext {
  readonly memoryRefs?: readonly { readonly memoryId: string; readonly revision: number }[];
  readonly artifacts?: readonly TrajectoryArtifactRef[];
  readonly lineage?: readonly {
    readonly kind: "compaction" | "handoff";
    readonly eventId: string;
    readonly previousAttemptId?: string;
    readonly previousTurnId?: string;
    readonly artifact?: TrajectoryArtifactRef;
  }[];
}
export interface TaskAcceptanceRef {
  readonly version: 1;
  readonly taskId: string;
  readonly attemptId: string;
  readonly revisionId: string;
  readonly verdict: "success" | "failure";
  readonly eventId: string;
  readonly artifactId: string;
  readonly criterionIds?: readonly string[];
}
export interface AttemptManifest {
  readonly version: 1;
  readonly attemptId: string;
  readonly taskId: string;
  readonly taskVersion: string;
  readonly parentAttemptId?: string;
  readonly conditionId?: string;
  readonly startedAt?: string;
  readonly startRevision: AttemptRevisionRef;
  readonly finalRevision?: AttemptRevisionRef;
  readonly context?: AttemptContext;
  readonly acceptance?: TaskAcceptanceRef;
}
export interface TrajectoryManifest {
  readonly version: 1;
  readonly task: TaskManifest;
  readonly attempt: AttemptManifest;
}
export interface TraceRuntimeObservation {
  readonly provenance: "native" | "hook-reported" | "configured";
  readonly usageInterpretation?: "incremental" | "cumulative" | "unknown";
  readonly usageScope?: "request" | "turn" | "session" | "unknown";
  readonly providerId?: string;
  readonly modelId?: string;
  readonly modelVersion?: string;
  readonly harness?: { readonly id: string; readonly version?: string };
  readonly configurationId?: string;
  readonly settings?: { readonly temperature?: number; readonly topP?: number; readonly maxOutputTokens?: number; readonly reasoningEffort?: string };
  readonly tools?: readonly { readonly name: string; readonly version?: string }[];
  readonly permissionMode?: string;
  readonly usage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly cachedInputTokens?: number;
    readonly reasoningTokens?: number;
    readonly durationMs?: number;
    readonly cost?: { readonly amount: number; readonly currency: string };
  };
}
export type TraceStepRole =
  | "model_thought"
  | "tool_call"
  | "tool_call_response"
  | "decision"
  | "model_output";

export interface TraceStep {
  readonly id: string;
  readonly stepNumber: number;
  readonly role: TraceStepRole;
  readonly content: string;
  readonly toolName?: string;
  readonly artifactId?: string;
  readonly eventId?: string;
  readonly turnId?: string;
  readonly startedAt?: string;
  readonly durationMs?: number;
  readonly runtime?: TraceRuntimeObservation;
  readonly context?: AttemptContext;
}

export interface ToolCallResult {
  readonly output?: unknown;
  readonly success?: boolean;
  readonly durationMs?: number;
  readonly [key: string]: unknown;
}

export interface ToolCall {
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly result?: ToolCallResult;
}

export type ToolTrace = readonly ToolCall[];

export interface RawTrajectory {
  readonly id: string;
  readonly taskId: string;
  readonly model: {
    readonly id: string;
    readonly version?: string;
  };
  readonly outcome: TraceOutcome;
  readonly capture: CaptureEnvelope;
  readonly steps: readonly TraceStep[];
  readonly manifest?: TrajectoryManifest;
}

export type SharedNodeKind = "decision" | "action" | "observation" | "outcome";

export interface SharedNode {
  readonly id: string;
  readonly kind: SharedNodeKind;
  readonly label: string;
}

export interface SharedEdge {
  readonly id: string;
  readonly sourceId: string;
  readonly targetId: string;
  readonly label: string;
}

export interface SharedDecisionTree {
  readonly taskId: string;
  readonly rootNodeId: string;
  readonly nodes: readonly SharedNode[];
  readonly edges: readonly SharedEdge[];
}

export interface ProjectionMethod {
  readonly kind: "manual" | "rule" | "model";
  readonly id: string;
  readonly confidence?: number;
  readonly basis?: "structural" | "semantic";
}

export type ProjectionAssignment =
  | {
      readonly kind: "mapped";
      readonly nodeId: string;
      readonly method: ProjectionMethod;
    }
  | {
      readonly kind: "ambiguous";
      readonly candidates: readonly [string, string, ...string[]];
      readonly reason: string;
      readonly method: ProjectionMethod;
    }
  | {
      readonly kind: "unmapped";
      readonly reason: string;
      readonly method: ProjectionMethod;
    };

export interface ProjectedStep {
  readonly raw: TraceStep;
  readonly projection: ProjectionAssignment;
}

export interface ProjectedTrajectory {
  readonly id: string;
  readonly taskId: string;
  readonly model: RawTrajectory["model"];
  readonly outcome: TraceOutcome;
  readonly capture: CaptureEnvelope;
  readonly steps: readonly ProjectedStep[];
  readonly manifest?: TrajectoryManifest;
}

export interface ProjectionCoverage {
  readonly total: number;
  readonly mapped: number;
  readonly ambiguous: number;
  readonly unmapped: number;
  readonly mappedRatio: number;
}

export interface EdgeOutcome {
  readonly edgeId: string;
  readonly sourceId: string;
  readonly targetId: string;
  readonly traversals: number;
  readonly successes: number;
  readonly failures: number;
  readonly unknowns: number;
  readonly classifiedSamples: number;
  readonly successRate: number;
}

export interface RouteOutcome {
  readonly nodeIds: readonly string[];
  readonly samples: number;
  readonly successes: number;
  readonly failures: number;
  readonly unknowns: number;
  readonly classifiedSamples: number;
  readonly successRate: number;
}

export interface ProjectionAnalysis {
  readonly traceCount: number;
  readonly routeEligibleTraceCount: number;
  readonly incompleteTraceCount: number;
  readonly coverage: ProjectionCoverage;
  readonly routes: readonly RouteOutcome[];
  readonly mostSuccessfulPath: readonly string[];
  readonly edgeOutcomes: ReadonlyMap<string, EdgeOutcome>;
}

export type FirstDivergence =
  | {
      readonly kind: "divergent";
      readonly edgeIndex: number;
      readonly expectedEdge: SharedEdge;
      readonly actualEdge: SharedEdge;
      readonly expectedOutcome?: EdgeOutcome;
      readonly actualOutcome?: EdgeOutcome;
    }
  | {
      readonly kind: "aligned";
      readonly comparedEdges: number;
    }
  | {
      readonly kind: "indeterminate";
      readonly comparedEdges: number;
      readonly reason:
        | "projection-gap"
        | "trace-ended"
        | "no-consensus"
        | "different-start-node";
      readonly stepId?: string;
    };
