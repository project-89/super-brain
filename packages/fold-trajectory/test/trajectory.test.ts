import { describe, expect, it } from "vitest";

import {
  TrajectoryProjectionError,
  analyzeTrajectoryTask,
  makeTrajectoryRecordedEvent,
  makeTrajectoryTreeRecordedEvent,
  rebuildTrajectories,
  trajectoryLogRecordsFromEvent,
  type TrajectoryEventContext,
  type TrajectoryInput,
} from "../src/index.js";

const context: TrajectoryEventContext = {
  access: {
    principalId: "operator-a",
    workspaceId: "workspace-a",
    workspaceRole: "member",
    spaceRoles: { "space-a": "writer" },
  },
  author: { kind: "human", id: "operator-a" },
  capture: {
    scope: { workspace: "workspace-a", space: "space-a" },
    identity: { principal: "operator-a", workspace: "workspace-a" },
  },
};

const tree = {
  taskId: "refresh-regression",
  rootNodeId: "observe-401",
  nodes: [
    { id: "observe-401", kind: "observation" as const, label: "Observe 401" },
    { id: "token-expiry", kind: "decision" as const, label: "Diagnose token expiry" },
    { id: "network", kind: "decision" as const, label: "Diagnose network instability" },
    { id: "patch-refresh", kind: "action" as const, label: "Patch refresh handling" },
    { id: "retry", kind: "action" as const, label: "Add retry" },
    { id: "pass", kind: "outcome" as const, label: "Tests pass" },
    { id: "fail", kind: "outcome" as const, label: "Tests fail" },
  ],
  edges: [
    { id: "e-expiry", sourceId: "observe-401", targetId: "token-expiry", label: "expiry" },
    { id: "e-network", sourceId: "observe-401", targetId: "network", label: "network" },
    { id: "e-patch", sourceId: "token-expiry", targetId: "patch-refresh", label: "patch" },
    { id: "e-retry", sourceId: "network", targetId: "retry", label: "retry" },
    { id: "e-pass", sourceId: "patch-refresh", targetId: "pass", label: "pass" },
    { id: "e-fail", sourceId: "retry", targetId: "fail", label: "fail" },
  ],
};

function input(
  id: string,
  model: string,
  outcome: "success" | "failure",
  nodes: readonly string[],
  reviewText: string,
): TrajectoryInput {
  const steps = nodes.map((nodeId, index) => ({
    id: `${id}-step-${index + 1}`,
    stepNumber: index + 1,
    role: (index === nodes.length - 1 ? "model_output" : "decision") as "model_output" | "decision",
    content: `Step at ${nodeId}`,
  }));
  return {
    id,
    taskId: tree.taskId,
    model: { id: model },
    outcome,
    steps,
    assignments: Object.fromEntries(
      steps.map((step, index) => [step.id, {
        kind: "mapped" as const,
        nodeId: nodes[index]!,
        method: { kind: "manual" as const, id: "fixture-review" },
      }]),
    ),
    reviewText,
  };
}

describe("Fold trajectory lifecycle", () => {
  it("records server-scoped trees and runs as canonical Fold records", () => {
    const treeEvent = makeTrajectoryTreeRecordedEvent(
      context,
      { id: "event-1", t: 1, worldDate: "2026-08-19" },
      tree,
    );
    const runEvent = makeTrajectoryRecordedEvent(
      context,
      { id: "event-2", t: 2, worldDate: "2026-08-19" },
      tree,
      input("run-a", "model-a", "success", ["observe-401", "token-expiry", "patch-refresh", "pass"], "VERDICT: approve\nCONFIDENCE: 0.92"),
    );
    expect(treeEvent).toMatchObject({
      kind: "trajectory.tree-recorded",
      capture: { scope: { workspace: "workspace-a", space: "space-a" } },
      changes: [{ subject: "trajectory-tree-revision:refresh-regression:event-1", nodeKind: "x.fold.trajectory-tree" }],
    });
    expect(trajectoryLogRecordsFromEvent(runEvent)[0]).toMatchObject({
      recordType: "trajectory",
      actorId: "operator-a",
      trajectory: { id: "run-a", capture: { scope: { workspace: "workspace-a", space: "space-a" } } },
    });
  });

  it("rebuilds and analyzes consensus, divergence, and review confidence", async () => {
    const events = [
      makeTrajectoryTreeRecordedEvent(context, { id: "event-1", t: 1, worldDate: "2026-08-19" }, tree),
      makeTrajectoryRecordedEvent(
        context,
        { id: "event-2", t: 2, worldDate: "2026-08-19" },
        tree,
        input("run-a", "model-a", "success", ["observe-401", "token-expiry", "patch-refresh", "pass"], "VERDICT: approve\nCONFIDENCE: 0.92"),
      ),
      makeTrajectoryRecordedEvent(
        context,
        { id: "event-3", t: 3, worldDate: "2026-08-19" },
        tree,
        input("run-b", "model-b", "failure", ["observe-401", "network", "retry", "fail"], "VERDICT: reject\nCONFIDENCE: 0.18"),
      ),
    ];
    const report = await analyzeTrajectoryTask(rebuildTrajectories(events), tree.taskId);
    expect(report?.analysis).toMatchObject({
      traceCount: 2,
      routeEligibleTraceCount: 2,
      coverage: { total: 8, mapped: 8, mappedRatio: 1 },
      mostSuccessfulPath: ["observe-401", "token-expiry", "patch-refresh", "pass"],
    });
    expect(report?.divergences).toEqual([
      { trajectoryId: "run-a", divergence: { kind: "aligned", comparedEdges: 3 } },
      expect.objectContaining({ trajectoryId: "run-b", divergence: expect.objectContaining({ kind: "divergent", edgeIndex: 0 }) }),
    ]);
    expect(report?.evaluations.map(({ review, oracle }) => [review.verdict, oracle.confidence])).toEqual([
      ["approve", 0.92],
      ["reject", 0.18],
    ]);
  });

  it("fails replay when a run precedes its shared task tree", () => {
    const run = makeTrajectoryRecordedEvent(
      context,
      { id: "event-2", t: 2, worldDate: "2026-08-19" },
      tree,
      input("run-a", "model-a", "success", ["observe-401", "token-expiry", "patch-refresh", "pass"], "VERDICT: approve"),
    );
    expect(() => rebuildTrajectories([run])).toThrow(TrajectoryProjectionError);
  });
});
