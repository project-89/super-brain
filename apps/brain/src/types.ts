export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface ConnectionSettings {
  readonly baseUrl: string;
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly token: string;
  readonly captureBaseUrl: string;
  readonly captureOperatorToken: string;
}

export interface CapturePolicySettings {
  readonly reasoningPolicy: "exclude" | "include";
  readonly retainEncryptedReasoning: boolean;
  readonly reasoningTreePolicy: "exclude" | "summaries";
  readonly treeSnapshotEveryEvents: number;
  readonly anonymizationPolicy: "none" | "pseudonymous" | "strict";
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
  readonly audience: "personal" | "workspace";
  readonly projectIds: readonly string[];
  readonly source: string;
  readonly summary: string;
  readonly content: JsonValue;
  readonly tags: readonly string[];
  readonly entities: readonly {
    readonly id: string;
    readonly type: string;
    readonly name: string;
  }[];
  readonly evidence?: readonly {
    readonly eventId: string;
    readonly projectId?: string;
    readonly runId?: string;
    readonly turnId?: string;
  }[];
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly revision: number;
}

export interface RecalledMemory {
  readonly memory: PersonalMemory;
  readonly score?: number;
}

export interface MemoryCandidate {
  readonly id: string;
  readonly workspaceId: string;
  readonly spaceId?: string;
  readonly proposerId: string;
  readonly audience: "personal" | "workspace";
  readonly projectIds: readonly string[];
  readonly source: string;
  readonly summary: string;
  readonly content: JsonValue;
  readonly tags: readonly string[];
  readonly entities: PersonalMemory["entities"];
  readonly evidence: readonly {
    readonly eventId: string;
    readonly projectId?: string;
    readonly runId?: string;
    readonly turnId?: string;
  }[];
  readonly confidence: number;
  readonly salience: number;
  readonly extractor: { readonly kind: "rule" | "model" | "human"; readonly id: string; readonly version: string };
  readonly proposedAt: number;
  readonly proposalEventId: string;
}

export interface MemoryCandidateView {
  readonly candidate: MemoryCandidate;
  readonly status: "proposed" | "accepted" | "rejected";
  readonly decision?: Readonly<Record<string, JsonValue>>;
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
  readonly appliedEventCount?: number;
  readonly appliedChangeCount?: number;
}

export interface ProjectionResponse {
  readonly entries: readonly FoldLogEntry[];
  readonly state: SerializedFoldState;
  readonly total?: number;
  readonly projected?: number;
}

export type BrainPage = "overview" | "memory" | "history" | "trajectories" | "fleet" | "steering" | "events" | "state";

export interface BrainSnapshot {
  readonly events: readonly FoldLogEntry[];
  readonly memories: readonly RecalledMemory[];
  readonly memoryCandidates: readonly MemoryCandidateView[];
  readonly trajectoryTasks: readonly TrajectoryTaskSummary[];
  readonly transcriptProjects: readonly TranscriptProjectSummary[];
  readonly transcriptRuns: readonly TranscriptRun[];
  readonly fleet: FleetResponse;
  readonly steering: SteeringResponse;
  readonly projection: ProjectionResponse;
  readonly workingProjection: ProjectionResponse;
  readonly loadedAt: number;
}

export type TranscriptSource = "claude-code" | "codex";
export type TranscriptIdentityResolution = "resolved" | "estimated" | "unassigned";

export interface TranscriptProject {
  readonly id: string;
  readonly name: string;
  readonly identityKeyHash: string;
  readonly resolution: TranscriptIdentityResolution;
  readonly roots: readonly string[];
  readonly remote?: string;
}

export interface TranscriptProjectSummary {
  readonly project: TranscriptProject;
  readonly runCount: number;
  readonly lastRunAt?: string;
}

export interface TranscriptContextSegment {
  readonly id: string;
  readonly ordinal: number;
  readonly projectId?: string;
  readonly resolution: TranscriptIdentityResolution;
  readonly cwd?: string;
  readonly repo?: string;
  readonly branch?: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
}

export interface TranscriptRun {
  readonly id: string;
  readonly nativeId: string;
  readonly source: TranscriptSource;
  readonly artifactId: string;
  readonly projectId?: string;
  readonly projectResolution: TranscriptIdentityResolution;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly cwd?: string;
  readonly branch?: string;
  readonly model?: string;
  readonly clientVersion?: string;
  readonly counts: {
    readonly records: number;
    readonly turns: number;
    readonly messages: number;
    readonly actions: number;
    readonly unknown: number;
  };
  readonly segments: readonly TranscriptContextSegment[];
}

export interface TranscriptArtifact {
  readonly id: string;
  readonly source: TranscriptSource;
  readonly sha256: string;
  readonly sourcePathHash: string;
  readonly byteLength: number;
  readonly mediaType: string;
  readonly parser: { readonly id: string; readonly version: string };
  readonly modifiedAt?: string;
  readonly contentPolicy: "metadata-only" | "redacted";
  readonly reasoningPolicy?: "excluded" | "included";
  readonly encryptedReasoningPolicy?: "excluded" | "retained";
  readonly anonymizationPolicy?: "none" | "pseudonymous" | "strict";
  readonly stored: boolean;
  readonly redactionCount: number;
}

export interface TranscriptTurn {
  readonly id: string;
  readonly ordinal: number;
  readonly nativeId?: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly messageCount: number;
  readonly actionCount: number;
  readonly roles: readonly ("user" | "assistant" | "developer" | "system" | "tool" | "other")[];
}

export interface TranscriptAction {
  readonly id: string;
  readonly ordinal: number;
  readonly turnId?: string;
  readonly at?: string;
  readonly kind: "tool-call" | "tool-result" | "command" | "file-change" | "test" | "other";
  readonly name?: string;
  readonly status?: "started" | "completed" | "failed" | "unknown";
}

export interface TranscriptChunk {
  readonly runId: string;
  readonly sequence: number;
  readonly turns: readonly TranscriptTurn[];
  readonly actions: readonly TranscriptAction[];
}

export interface TranscriptRunDetail {
  readonly run: TranscriptRun;
  readonly artifact: TranscriptArtifact;
  readonly projects: readonly TranscriptProject[];
  readonly chunks: readonly TranscriptChunk[];
}

export type MemoryScope =
  | { readonly kind: "all" }
  | { readonly kind: "workspace" }
  | { readonly kind: "space"; readonly spaceId: string };

export interface MemoryDraft {
  readonly audience: "personal" | "workspace";
  readonly projectIds: readonly string[];
  readonly source: string;
  readonly summary: string;
  readonly content: JsonValue;
  readonly tags: readonly string[];
  readonly spaceId?: string;
}

export type TrajectoryOutcome = "success" | "failure" | "unknown";
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
  readonly artifactId?: string;
  readonly eventId?: string;
  readonly turnId?: string;
  readonly startedAt?: string;
  readonly durationMs?: number;
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
  readonly unknownCount: number;
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
}

export interface SteeringSatisfier {
  readonly kind: string;
  readonly ref: string;
  readonly params?: Readonly<Record<string, JsonValue>>;
}

export type SurfacingTrigger =
  | { readonly kind: "coincidence"; readonly note: string }
  | { readonly kind: "quiet" }
  | { readonly kind: "threshold" };

export interface SteeringCandidate {
  readonly id: string;
  readonly sourceDriveId: string;
  readonly satisfier: SteeringSatisfier;
  readonly aim: string;
  readonly surfacedAtMs: number;
  readonly trigger: SurfacingTrigger;
}

export interface SteeringIntention {
  readonly id: string;
  readonly aim: string;
  readonly sourceDriveId: string;
  readonly satisfier: SteeringSatisfier;
  readonly fromCandidateId: string;
  readonly formedAtMs: number;
  readonly attempts: number;
}

export interface SteeringDecline {
  readonly candidate: SteeringCandidate;
  readonly reason: string;
  readonly atMs: number;
}

export interface SteeringActorSnapshot {
  readonly actorId: string;
  readonly pendingCandidates: readonly SteeringCandidate[];
  readonly intentions: readonly SteeringIntention[];
  readonly recentDeclines: readonly SteeringDecline[];
  readonly driveSample?: {
    readonly actorId: string;
    readonly elapsedMs: number;
    readonly levels: Readonly<Record<string, number>>;
    readonly wear: {
      readonly perDrive: Readonly<Record<string, { readonly sustainedBelowMs: number; readonly sustainedAboveMs: number }>>;
      readonly chronicLoad: number;
    };
  };
}

export interface SteeringResponse {
  readonly actors: readonly SteeringActorSnapshot[];
  readonly steeringEnabled: boolean;
}

export interface SteeringCandidateDraft {
  readonly actorId: string;
  readonly sourceDriveId: string;
  readonly satisfierKind: string;
  readonly satisfierRef: string;
  readonly aim: string;
  readonly trigger: SurfacingTrigger;
}

export type SteeringIntentionEnd =
  | { readonly kind: "satisfied" }
  | { readonly kind: "expired" }
  | { readonly kind: "abandoned"; readonly reason: string }
  | { readonly kind: "superseded"; readonly byIntentionId: string };

export interface ReasoningResponse {
  readonly answer: string;
  readonly citations: readonly string[];
  readonly provider: { readonly id: string; readonly kind: "extractive" | "model" };
  readonly ranking: { readonly id: string; readonly kind: "lexical" | "semantic"; readonly corpusSize: number };
  readonly evidence: readonly {
    readonly memoryId: string;
    readonly source: string;
    readonly summary: string;
    readonly score?: number;
  }[];
  readonly steering?: SteeringActorSnapshot;
}
