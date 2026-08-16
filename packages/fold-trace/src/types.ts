import type { CaptureEnvelope } from "@_89/fold";

export type TraceOutcome = "success" | "failure";
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
  readonly successRate: number;
}

export interface RouteOutcome {
  readonly nodeIds: readonly string[];
  readonly samples: number;
  readonly successes: number;
  readonly failures: number;
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
