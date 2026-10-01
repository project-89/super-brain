import type { FoldEvent } from "@_89/fold";
import { evaluateOracles, parseReviewVerdict } from "@_89/fold-eval";
import {
  analyzeProjectedTrajectories,
  firstDivergentEdge,
  isAdditiveTreeRevision,
  projectTrajectory,
} from "@_89/fold-trace";

import { trajectoryLogRecordsFromEvent } from "./events.js";
import type {
  TrajectoryEvaluation,
  TrajectoryRunRecord,
  TrajectoryState,
  TrajectoryTaskReport,
  TrajectoryTreeRecord,
  TrajectoryOutcomeRecord,
} from "./types.js";

export class TrajectoryProjectionError extends Error {
  override readonly name = "TrajectoryProjectionError";
}

export function rebuildTrajectories(events: readonly FoldEvent[]): TrajectoryState {
  return continueTrajectories({ trees: new Map(), trajectories: new Map(), outcomes: new Map() }, events);
}

/** Continue a validated, source-ordered prefix without mutating its prior state. */
export function continueTrajectories(state: TrajectoryState, events: readonly FoldEvent[]): TrajectoryState {
  const trees = new Map(state.trees);
  const trajectories = new Map(state.trajectories);
  const outcomes = new Map(state.outcomes);
  for (const event of events) {
    for (const record of trajectoryLogRecordsFromEvent(event)) {
      if (record.recordType === "tree") {
        const current = trees.get(record.tree.taskId);
        if (current !== undefined && !isAdditiveTreeRevision(current.tree, record.tree)) {
          throw new TrajectoryProjectionError(`non-additive trajectory tree revision for task ${record.tree.taskId}`);
        }
        trees.set(record.tree.taskId, record);
        continue;
      }
      if (record.recordType === "outcome") {
        const run = trajectories.get(record.trajectoryId);
        if (run === undefined || run.trajectory.taskId !== record.taskId ||
          run.workspaceId !== record.workspaceId || run.spaceId !== record.spaceId) {
          throw new TrajectoryProjectionError(`outcome ${record.eventId} references an unavailable trajectory`);
        }
        const history = [...outcomes.get(record.trajectoryId) ?? []];
        if ((history.at(-1)?.eventId ?? null) !== record.previousEventId) {
          throw new TrajectoryProjectionError(`outcome ${record.eventId} has a stale predecessor`);
        }
        history.push(record);
        outcomes.set(record.trajectoryId, history);
        continue;
      }
      if (trajectories.has(record.trajectory.id)) {
        throw new TrajectoryProjectionError(`duplicate trajectory id ${record.trajectory.id}`);
      }
      if (!trees.has(record.trajectory.taskId)) {
        throw new TrajectoryProjectionError(
          `trajectory ${record.trajectory.id} references missing task tree ${record.trajectory.taskId}`,
        );
      }
      trajectories.set(record.trajectory.id, record);
    }
  }
  return { trees, trajectories, outcomes };
}

export function effectiveTrajectoryRecord(state: TrajectoryState, record: TrajectoryRunRecord): TrajectoryRunRecord {
  const outcomeReview = state.outcomes.get(record.trajectory.id)?.at(-1);
  if (outcomeReview === undefined) return record;
  return {
    ...record,
    recordedOutcome: record.trajectory.outcome,
    outcomeReview,
    trajectory: {
      ...record.trajectory,
      outcome: outcomeReview.outcome,
      outcomeEvidence: { kind: "operator-verdict", eventId: outcomeReview.eventId },
    },
    reviewText: outcomeReview.outcome === "unknown" ? "" : `VERDICT: ${outcomeReview.outcome === "success" ? "approve" : "reject"}`,
  };
}

async function evaluateRecord(record: TrajectoryRunRecord): Promise<TrajectoryEvaluation> {
  const review = parseReviewVerdict(record.reviewText ?? "");
  const oracle = await evaluateOracles(
    { oracles: [{ type: "human" }], combine: "min" },
    record,
    {
      handlers: {
        human: () => review.confidence === undefined
          ? undefined
          : { confidence: review.confidence, detail: review.detail },
      },
    },
  );
  return { trajectoryId: record.trajectory.id, review, oracle };
}

export async function analyzeTrajectoryTask(
  state: TrajectoryState,
  taskId: string,
): Promise<TrajectoryTaskReport | undefined> {
  const treeRecord = state.trees.get(taskId);
  if (treeRecord === undefined) return undefined;
  const records = [...state.trajectories.values()]
    .filter((record) => record.trajectory.taskId === taskId)
    .map((record) => effectiveTrajectoryRecord(state, record))
    .sort((left, right) => left.recordedAt - right.recordedAt || left.trajectory.id.localeCompare(right.trajectory.id));
  const projected = records.map((record) =>
    projectTrajectory(record.trajectory, treeRecord.tree, record.assignments),
  );
  const analysis = analyzeProjectedTrajectories(projected, treeRecord.tree);
  const divergences = projected.map((trajectory) => ({
    trajectoryId: trajectory.id,
    divergence: firstDivergentEdge(
      trajectory,
      analysis.mostSuccessfulPath,
      treeRecord.tree,
      analysis.edgeOutcomes,
    ),
  }));
  const evaluations = await Promise.all(records.map(evaluateRecord));
  return {
    taskId,
    outcomeCounts: {
      success: records.filter(({ trajectory }) => trajectory.outcome === "success").length,
      failure: records.filter(({ trajectory }) => trajectory.outcome === "failure").length,
      unknown: records.filter(({ trajectory }) => trajectory.outcome === "unknown").length,
    },
    tree: treeRecord.tree,
    records,
    projected,
    analysis,
    divergences,
    evaluations,
  };
}
