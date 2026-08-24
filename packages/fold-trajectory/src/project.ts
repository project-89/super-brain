import type { FoldEvent } from "@_89/fold";
import { evaluateOracles, parseReviewVerdict } from "@_89/fold-eval";
import {
  analyzeProjectedTrajectories,
  firstDivergentEdge,
  projectTrajectory,
} from "@_89/fold-trace";

import { trajectoryLogRecordsFromEvent } from "./events.js";
import type {
  TrajectoryEvaluation,
  TrajectoryRunRecord,
  TrajectoryState,
  TrajectoryTaskReport,
  TrajectoryTreeRecord,
} from "./types.js";

export class TrajectoryProjectionError extends Error {
  override readonly name = "TrajectoryProjectionError";
}

export function rebuildTrajectories(events: readonly FoldEvent[]): TrajectoryState {
  const trees = new Map<string, TrajectoryTreeRecord>();
  const trajectories = new Map<string, TrajectoryRunRecord>();
  for (const event of events) {
    for (const record of trajectoryLogRecordsFromEvent(event)) {
      if (record.recordType === "tree") {
        if (trees.has(record.tree.taskId)) {
          throw new TrajectoryProjectionError(`duplicate trajectory tree for task ${record.tree.taskId}`);
        }
        trees.set(record.tree.taskId, record);
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
  return { trees, trajectories };
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
    tree: treeRecord.tree,
    records,
    projected,
    analysis,
    divergences,
    evaluations,
  };
}
