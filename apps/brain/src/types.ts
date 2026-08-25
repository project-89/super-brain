export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface ConnectionSettings {
  readonly baseUrl: string;
  readonly workspaceId: string;
  readonly token: string;
}

export interface EventAuthor {
  readonly kind: "human" | "simulation" | "agent" | "rule" | "generator" | "ingest" | "sensor";
  readonly id: string;
  readonly productionId?: string;
}

export interface FoldChange {
  readonly verb: string;
  readonly subject: string;
  readonly component?: string;
  readonly field?: string;
  readonly object?: string;
  readonly before?: JsonValue;
  readonly after?: JsonValue;
  readonly amount?: number;
  readonly nodeKind?: string;
  readonly edgeType?: string;
  readonly edgeId?: string;
  readonly [key: string]: JsonValue | undefined;
}

export interface FoldEvent {
  readonly specVersion: "0.7";
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly description?: string;
  readonly at: {
    readonly t: number;
    readonly worldDate: string;
    readonly granularity?: string;
  };
  readonly timelineId?: string;
  readonly participants?: readonly string[];
  readonly location?: string;
  readonly author: EventAuthor;
  readonly causedBy?: readonly string[];
  readonly capture: {
    readonly scope: {
      readonly workspace: string;
      readonly space?: string;
      readonly creator?: string;
    };
    readonly identity?: Readonly<Record<string, string>>;
  };
  readonly changes: readonly FoldChange[];
  readonly [key: string]: unknown;
}

export interface FoldLogEntry {
  readonly event: FoldEvent;
  readonly status: "canon" | "draft";
}

export interface PersonalMemory {
  readonly id: string;
  readonly workspaceId: string;
  readonly spaceId?: string;
  readonly creatorId: string;
  readonly source: string;
  readonly summary: string;
  readonly content: JsonValue;
  readonly tags: readonly string[];
  readonly entities: readonly {
    readonly id: string;
    readonly type: string;
    readonly name: string;
  }[];
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly revision: number;
}

export interface RecalledMemory {
  readonly memory: PersonalMemory;
  readonly score?: number;
}

export interface RankedMemoryRecallResult {
  readonly memories: readonly RecalledMemory[];
  readonly ranking: {
    readonly id: string;
    readonly kind: "lexical" | "semantic";
    readonly corpusSize: number;
  };
}

export interface SerializedFoldNode {
  readonly id: string;
  readonly nodeKind?: string;
  readonly exists: boolean;
  readonly properties: Readonly<Record<string, JsonValue>>;
}

export interface SerializedFoldEdge {
  readonly id: string;
  readonly subject: string;
  readonly object: string;
  readonly edgeType: string;
  readonly payload?: JsonValue;
}

export interface SerializedFoldState {
  readonly values: readonly [string, JsonValue][];
  readonly nodes: readonly [string, SerializedFoldNode][];
  readonly edges: readonly [string, SerializedFoldEdge][];
  readonly redirects: readonly [string, string][];
  readonly diagnostics: readonly Readonly<Record<string, JsonValue>>[];
  readonly appliedEvents: readonly FoldEvent[];
  readonly appliedChanges: readonly Readonly<Record<string, JsonValue>>[];
}

export interface ProjectionResponse {
  readonly entries: readonly FoldLogEntry[];
  readonly state: SerializedFoldState;
}

export interface BrainSnapshot {
  readonly events: readonly FoldLogEntry[];
  readonly memories: readonly RecalledMemory[];
  readonly trajectoryTasks: readonly TrajectoryTaskSummary[];
  readonly fleet: FleetResponse;
  readonly projection: ProjectionResponse;
  readonly workingProjection: ProjectionResponse;
  readonly loadedAt: number;
}

export type MemoryScope =
  | { readonly kind: "all" }
  | { readonly kind: "workspace" }
  | { readonly kind: "space"; readonly spaceId: string };

export interface MemoryDraft {
  readonly source: string;
  readonly summary: string;
  readonly content: JsonValue;
  readonly tags: readonly string[];
  readonly spaceId?: string;
}

export type TrajectoryOutcome = "success" | "failure";
export type TrajectoryStepRole =
  | "model_thought"
  | "tool_call"
  | "tool_call_response"
  | "decision"
  | "model_output";

export interface TrajectoryStep {
  readonly id: string;
  readonly stepNumber: number;
  readonly role: TrajectoryStepRole;
  readonly content: string;
  readonly toolName?: string;
}

export interface SharedTrajectoryNode {
  readonly id: string;
  readonly kind: "decision" | "action" | "observation" | "outcome";
  readonly label: string;
}

export interface SharedTrajectoryEdge {
  readonly id: string;
  readonly sourceId: string;
  readonly targetId: string;
  readonly label: string;
}

export interface SharedDecisionTree {
  readonly taskId: string;
  readonly rootNodeId: string;
  readonly nodes: readonly SharedTrajectoryNode[];
  readonly edges: readonly SharedTrajectoryEdge[];
}

export interface ProjectionMethod {
  readonly kind: "manual" | "rule" | "model";
  readonly id: string;
  readonly confidence?: number;
}

export type ProjectionAssignment =
  | { readonly kind: "mapped"; readonly nodeId: string; readonly method: ProjectionMethod }
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

export interface TrajectoryInput {
  readonly id: string;
  readonly taskId: string;
  readonly model: { readonly id: string; readonly version?: string };
  readonly outcome: TrajectoryOutcome;
  readonly steps: readonly TrajectoryStep[];
  readonly assignments: Readonly<Record<string, ProjectionAssignment>>;
  readonly reviewText?: string;
}

export interface TrajectoryTaskSummary {
  readonly taskId: string;
  readonly tree: SharedDecisionTree;
  readonly trajectoryCount: number;
  readonly successCount: number;
  readonly failureCount: number;
  readonly lastRecordedAt: number;
}

export interface TrajectoryRunRecord {
  readonly recordType: "trajectory";
  readonly actorId: string;
  readonly workspaceId: string;
  readonly spaceId?: string;
  readonly recordedAt: number;
  readonly trajectory: Omit<TrajectoryInput, "assignments" | "reviewText"> & {
    readonly capture: FoldEvent["capture"];
  };
  readonly assignments: Readonly<Record<string, ProjectionAssignment>>;
  readonly reviewText?: string;
}

export interface ProjectedTrajectory {
  readonly id: string;
  readonly taskId: string;
  readonly model: TrajectoryInput["model"];
  readonly outcome: TrajectoryOutcome;
  readonly capture: FoldEvent["capture"];
  readonly steps: readonly {
    readonly raw: TrajectoryStep;
    readonly projection: ProjectionAssignment;
  }[];
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

export type TrajectoryDivergence =
  | { readonly kind: "aligned"; readonly comparedEdges: number }
  | {
      readonly kind: "divergent";
      readonly edgeIndex: number;
      readonly expectedEdge: SharedTrajectoryEdge;
      readonly actualEdge: SharedTrajectoryEdge;
      readonly expectedOutcome?: EdgeOutcome;
      readonly actualOutcome?: EdgeOutcome;
    }
  | {
      readonly kind: "indeterminate";
      readonly comparedEdges: number;
      readonly reason: "projection-gap" | "trace-ended" | "no-consensus" | "different-start-node";
      readonly stepId?: string;
    };

export interface TrajectoryTaskReport {
  readonly taskId: string;
  readonly tree: SharedDecisionTree;
  readonly records: readonly TrajectoryRunRecord[];
  readonly projected: readonly ProjectedTrajectory[];
  readonly analysis: {
    readonly traceCount: number;
    readonly routeEligibleTraceCount: number;
    readonly incompleteTraceCount: number;
    readonly coverage: {
      readonly total: number;
      readonly mapped: number;
      readonly ambiguous: number;
      readonly unmapped: number;
      readonly mappedRatio: number;
    };
    readonly routes: readonly RouteOutcome[];
    readonly mostSuccessfulPath: readonly string[];
    readonly edgeOutcomes: readonly EdgeOutcome[];
  };
  readonly divergences: readonly {
    readonly trajectoryId: string;
    readonly divergence: TrajectoryDivergence;
  }[];
  readonly evaluations: readonly {
    readonly trajectoryId: string;
    readonly review: {
      readonly confidence?: number;
      readonly verdict?: "approve" | "revise" | "reject";
      readonly detail: string;
    };
    readonly oracle: {
      readonly confidence: number;
      readonly combine: string;
      readonly executions: readonly unknown[];
      readonly detail?: string;
    };
  }[];
}

export interface TrajectoryImportBundle {
  readonly spaceId?: string;
  readonly tree: SharedDecisionTree;
  readonly trajectories: readonly TrajectoryInput[];
}

export type FleetSessionStatus =
  | "pending"
  | "starting"
  | "authenticating"
  | "ready"
  | "busy"
  | "blocked"
  | "stopping"
  | "stopped"
  | "error"
  | "unknown";

export interface FleetSession {
  readonly sessionId: string;
  readonly agentId: string;
  readonly taskId: string;
  readonly repo: string;
  readonly branch: string;
  readonly runtime?: string;
  readonly sensor: string;
  readonly status: FleetSessionStatus;
  readonly lastKnownStatus: FleetSessionStatus;
  readonly availability: "available" | "degraded" | "unavailable" | "unknown";
  readonly freshness: "current" | "stale" | "unknown";
  readonly orphaned: boolean;
  readonly lastSeenAt?: string;
  readonly lastObservedAt?: string;
  readonly heartbeatWindowMs?: number;
  readonly lastLifecyclePhase?: "online" | "heartbeat" | "degraded" | "offline";
  readonly lastDeclaredLifecyclePhase?: "online" | "degraded" | "offline";
}

export interface OrphanRecoveryAction {
  readonly kind: "reconcile_orphan";
  readonly sessionId: string;
  readonly sensor: string;
  readonly detectedAt: string;
  readonly lastSeenAt: string;
  readonly lastKnownStatus: FleetSessionStatus;
  readonly reason: string;
}

export interface FleetResponse {
  readonly fleet: {
    readonly rebuiltAt: string;
    readonly sessions: readonly FleetSession[];
    readonly recoveryActions: readonly OrphanRecoveryAction[];
  };
  readonly simulationEnabled: boolean;
}

export type FleetSimulationScenario = "active" | "blocked" | "degraded" | "orphaned" | "stopped";

export interface FleetSimulationDraft {
  readonly scenario: FleetSimulationScenario;
  readonly agentId: string;
  readonly taskId: string;
  readonly repo: string;
  readonly branch: string;
  readonly spaceId?: string;
}
