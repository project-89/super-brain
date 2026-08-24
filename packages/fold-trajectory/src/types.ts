import type { Author, CaptureEnvelope, FoldEvent } from "@_89/fold";
import type { EpistemicAccessContext, EpistemicEventStamp } from "@_89/fold-epistemic";
import type { OracleEvaluation, ReviewVerdict } from "@_89/fold-eval";
import type {
  FirstDivergence,
  ProjectedTrajectory,
  ProjectionAnalysis,
  ProjectionAssignment,
  RawTrajectory,
  SharedDecisionTree,
} from "@_89/fold-trace";

export interface TrajectoryEventContext {
  readonly access: EpistemicAccessContext;
  readonly author: Author;
  readonly capture: CaptureEnvelope & {
    readonly identity: Readonly<Record<string, string>>;
  };
}

export type TrajectoryEventStamp = EpistemicEventStamp;

export interface TrajectoryInput {
  readonly id: string;
  readonly taskId: string;
  readonly model: RawTrajectory["model"];
  readonly outcome: RawTrajectory["outcome"];
  readonly steps: RawTrajectory["steps"];
  readonly assignments: Readonly<Record<string, ProjectionAssignment>>;
  readonly reviewText?: string;
}

export interface TrajectoryTreeRecord {
  readonly recordType: "tree";
  readonly actorId: string;
  readonly workspaceId: string;
  readonly spaceId?: string;
  readonly recordedAt: number;
  readonly tree: SharedDecisionTree;
}

export interface TrajectoryRunRecord {
  readonly recordType: "trajectory";
  readonly actorId: string;
  readonly workspaceId: string;
  readonly spaceId?: string;
  readonly recordedAt: number;
  readonly trajectory: RawTrajectory;
  readonly assignments: Readonly<Record<string, ProjectionAssignment>>;
  readonly reviewText?: string;
}

export type TrajectoryLogRecord = TrajectoryTreeRecord | TrajectoryRunRecord;

export interface TrajectoryState {
  readonly trees: ReadonlyMap<string, TrajectoryTreeRecord>;
  readonly trajectories: ReadonlyMap<string, TrajectoryRunRecord>;
}

export interface TrajectoryEvaluation {
  readonly trajectoryId: string;
  readonly review: ReviewVerdict;
  readonly oracle: OracleEvaluation;
}

export interface TrajectoryDivergence {
  readonly trajectoryId: string;
  readonly divergence: FirstDivergence;
}

export interface TrajectoryTaskReport {
  readonly taskId: string;
  readonly tree: SharedDecisionTree;
  readonly records: readonly TrajectoryRunRecord[];
  readonly projected: readonly ProjectedTrajectory[];
  readonly analysis: ProjectionAnalysis;
  readonly divergences: readonly TrajectoryDivergence[];
  readonly evaluations: readonly TrajectoryEvaluation[];
}

export interface TrajectoryTreeMutationResult {
  readonly event: FoldEvent;
  readonly record: TrajectoryTreeRecord;
}

export interface TrajectoryMutationResult {
  readonly event: FoldEvent;
  readonly record: TrajectoryRunRecord;
}
