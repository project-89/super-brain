import type { FoldEvent } from "@_89/fold";
import { compareEventKeys } from "@_89/fold";
import { rebuildTaskEvidence } from "./task-state.js";
import { parseReviewVerdict } from "@_89/fold-eval";
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
} from "./types.js";

export class TrajectoryProjectionError extends Error {
  override readonly name = "TrajectoryProjectionError";
}

export function rebuildTrajectories(events: readonly FoldEvent[]): TrajectoryState {
  const trees = new Map<string, TrajectoryTreeRecord>();
  const trajectories = new Map<string, TrajectoryRunRecord>();
  for (const event of [...events].sort(compareEventKeys)) {
    for (const record of trajectoryLogRecordsFromEvent(event)) {
      if (record.recordType === "tree") {
        const current = trees.get(record.tree.taskId);
        if (current !== undefined && !isAdditiveTreeRevision(current.tree, record.tree)) {
          throw new TrajectoryProjectionError(`non-additive trajectory tree revision for task ${record.tree.taskId}`);
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
  return { trees, trajectories, evidence: rebuildTaskEvidence(events).records };
}

async function evaluateRecord(record: TrajectoryRunRecord): Promise<TrajectoryEvaluation> {
  const review = parseReviewVerdict(record.reviewText ?? "");
  const oracle: TrajectoryEvaluation["oracle"] = { confidence: null, availability: "unavailable", combine: "min", executions: [], detail: "No independently observed oracle is attached to this trajectory; parsed review text is self-reported." };
  return { trajectoryId: record.trajectory.id, review, oracle, reviewProvenance: "legacy-self-reported" };
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
  const versions = [...new Set(records.flatMap((record) => record.trajectory.manifest ? [record.trajectory.manifest.task.taskVersion] : []))].sort();
  const specified = records.every((record) => record.trajectory.manifest !== undefined);
  const inputBaselines = new Set(records.flatMap((record) => record.trajectory.manifest ? [JSON.stringify(record.trajectory.manifest.attempt.startRevision)] : []));
  const status = versions.length > 1 || inputBaselines.size > 1 || (versions.length > 0 && !specified) ? "incompatible" : specified && records.length > 0 ? "compatible" : "unspecified";
  // Different task specifications/inputs cannot contribute pooled comparative route statistics.
  const analysis = analyzeProjectedTrajectories(status === "incompatible" ? [] : projected, treeRecord.tree);
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
  const evidence = (state.evidence ?? []).filter((record) => record.input.taskId === taskId);
  const acceptances = new Map<string, NonNullable<TrajectoryTaskReport["acceptanceSummary"]>[number]>();
  for (const record of evidence) if (record.recordType === "outcome" && record.authority.kind === "human" && record.input.acceptance !== undefined) {
    const key = JSON.stringify([record.input.attemptId, record.input.revisionId]); const previous = acceptances.get(key); const verdict = record.input.acceptance.verdict;
    acceptances.set(key, { attemptId: record.input.attemptId, revisionId: record.input.revisionId, verdict: previous && previous.verdict !== verdict ? "conflicting" : verdict,
      outcomeIds: [...(previous?.outcomeIds ?? []), record.input.id], authority: "authenticated-human" });
  }
  const bases = new Set(records.flatMap((record) => Object.values(record.assignments).map(({ method }) => method.basis ?? "unspecified")));
  return {
    taskId,
    tree: treeRecord.tree,
    records,
    projected,
    analysis,
    divergences,
    evaluations,
    evidence,
    evidenceAvailability: "reference-only",
    comparison: { status, taskVersions: versions },
    projectionBasis: bases.size !== 1 ? "mixed" : bases.has("structural") ? "structural" : bases.has("semantic") ? "semantic" : "unspecified",
    acceptanceSummary: [...acceptances.values()],
  };
}
