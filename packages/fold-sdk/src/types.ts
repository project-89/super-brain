import type {
  ComponentRegistry,
  FoldEvent,
  FoldLogEntry,
  FoldState,
} from "@_89/fold";
import type {
  EpistemicAccessContext,
  EpistemicEventStamp,
  ForgottenMemory,
  MemoryCandidate,
  MemoryCandidateDecision,
  MemoryCandidateView,
  MemoryFeedbackRecord,
  PersonalMemory,
  RecallRequest,
  RecalledMemory,
  SemanticMemoryCandidate,
} from "@_89/fold-epistemic";
import type {
  TrajectoryRunRecord,
  TrajectoryTaskReport,
  TrajectoryTreeRecord,
} from "@_89/fold-trajectory";
import type { FleetSessionSnapshot, OrphanRecoveryAction } from "@_89/fold-fleet";
import type { TerminalSensorContext } from "@_89/fold-activity";
import type {
  DriveEventContext,
  DriveSystemSnapshot,
  Intention,
  IntentionDecline,
  SurfacedCandidate,
} from "@_89/fold-drives";
import type {
  TranscriptArtifact,
  TranscriptChunk,
  TranscriptEventContext,
  TranscriptImportBundle,
  TranscriptProject,
  TranscriptRun,
  TranscriptSource,
} from "@_89/fold-transcript";

export type FoldSdkAccessContext = EpistemicAccessContext;

export interface FoldSdkStore {
  readonly stableReads?: boolean;
  read(options?: { readonly missing?: "error" | "empty" }): Promise<{
    readonly entries: readonly FoldLogEntry[];
    readonly revision?: string;
  }>;
  append(entry: FoldLogEntry): Promise<void>;
  appendMany?(entries: readonly FoldLogEntry[]): Promise<void>;
  revision?(): Promise<string>;
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

export interface MemoryFeedbackResult {
  readonly event: FoldEvent;
  readonly feedback: MemoryFeedbackRecord;
}

export interface MemoryCandidateMutationResult {
  readonly event: FoldEvent;
  readonly candidate: MemoryCandidate;
}

export interface MemoryCandidateAcceptanceResult {
  readonly decisionEvent: FoldEvent;
  readonly memoryEvent: FoldEvent;
  readonly decision: Extract<MemoryCandidateDecision, { readonly kind: "accepted" }>;
  readonly memory: PersonalMemory;
}

export interface MemoryCandidateAcceptanceInput {
  readonly decisionStamp: EpistemicEventStamp;
  readonly memoryStamp: EpistemicEventStamp;
  readonly candidateId: string;
  readonly memoryId: string;
}

export interface MemoryCandidateRejectionResult {
  readonly event: FoldEvent;
  readonly decision: Extract<MemoryCandidateDecision, { readonly kind: "rejected" }>;
}

export interface MemoryCandidateListOptions {
  readonly status?: MemoryCandidateView["status"];
  readonly projectIds?: readonly string[];
  readonly offset?: number;
  readonly limit?: number;
}

export interface MemoryPageCursor {
  readonly createdAt: number;
  readonly memoryId: string;
}

export interface MemoryPage {
  readonly memories: readonly RecalledMemory[];
  readonly total: number;
  readonly nextCursor?: MemoryPageCursor;
}

export type MemoryRankingKind = "lexical" | "semantic";

export interface MemoryRankerDescriptor {
  readonly id: string;
  readonly kind: MemoryRankingKind;
}

export interface MemoryRankingDocument {
  readonly memoryId: string;
  readonly source: string;
  readonly summary: string;
  readonly content: PersonalMemory["content"];
  readonly tags: readonly string[];
  readonly entities: PersonalMemory["entities"];
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly revision: number;
}

export interface MemoryEmbeddingProvider {
  readonly descriptor: {
    readonly id: string;
    readonly dimensions: number;
  };
  embed(inputs: readonly string[]): Promise<readonly (readonly number[])[]>;
}

export interface MemoryRankingRequest {
  readonly organizationId?: string;
  readonly workspaceId: string;
  readonly query: string;
  readonly documents: readonly MemoryRankingDocument[];
  readonly limit: number;
}

export interface MemoryRanker {
  readonly descriptor: MemoryRankerDescriptor;
  rank(request: MemoryRankingRequest): Promise<readonly SemanticMemoryCandidate[]>;
}

export type RankedMemoryRecallRequest = Omit<RecallRequest, "candidates"> & {
  readonly query: string;
};

export interface RankedMemoryRecallResult {
  readonly memories: readonly RecalledMemory[];
  readonly ranking: MemoryRankerDescriptor & {
    readonly corpusSize: number;
  };
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
  readonly unknownCount: number;
  readonly lastRecordedAt: number;
}

export interface ActivityMutationResult {
  readonly event: FoldEvent;
}

export interface FoldSdkTranscriptContext extends TranscriptEventContext {
  readonly access: FoldSdkAccessContext;
}

export interface TranscriptImportOptions {
  readonly importId: string;
  readonly importedAt: number;
}

export interface TranscriptImportResult {
  readonly events: readonly FoldEvent[];
  readonly run: TranscriptRun;
}

export interface TranscriptProjectSummary {
  readonly project: TranscriptProject;
  readonly runCount: number;
  readonly lastRunAt?: string;
}

export interface TranscriptRunFilters {
  readonly projectId?: string;
  readonly source?: TranscriptSource;
}

export interface TranscriptRunDetail {
  readonly run: TranscriptRun;
  readonly artifact: TranscriptArtifact;
  readonly projects: readonly TranscriptProject[];
  readonly chunks: readonly TranscriptChunk[];
}

export interface FoldSdkActivityContext extends TerminalSensorContext {
  readonly access: FoldSdkAccessContext;
}

export interface FoldSdkSteeringContext extends DriveEventContext {
  readonly access: FoldSdkAccessContext;
}

export interface FleetReadModel {
  readonly rebuiltAt: string;
  readonly sessions: readonly FleetSessionSnapshot[];
  readonly recoveryActions: readonly OrphanRecoveryAction[];
}

export interface SteeringSnapshot {
  readonly actorId: string;
  readonly pendingCandidates: readonly SurfacedCandidate[];
  readonly intentions: readonly Intention[];
  readonly recentDeclines: readonly IntentionDecline[];
  readonly driveSample?: DriveSystemSnapshot;
}

export interface SteeringMutationResult {
  readonly event: FoldEvent;
  readonly steering: SteeringSnapshot;
}

export type { TrajectoryTaskReport };
export type {
  TranscriptArtifact,
  TranscriptChunk,
  TranscriptImportBundle,
  TranscriptProject,
  TranscriptRun,
  TranscriptSource,
};
