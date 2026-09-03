import { describe, expect, it } from "vitest";
import { parseEvent } from "@_89/fold";
import { makeTrajectoryTreeRecordedEvent } from "@_89/fold-trajectory";

import {
  FoldSdk,
  FoldSdkConflictError,
  TrajectoryTaskUnavailableError,
} from "../src/index.js";
import { access, MemoryStore, stamp } from "./helpers.js";

const tree = {
  taskId: "refresh-regression",
  rootNodeId: "observe",
  nodes: [
    { id: "observe", kind: "observation" as const, label: "Observe failure" },
    { id: "diagnose", kind: "decision" as const, label: "Diagnose expiry" },
    { id: "patch", kind: "action" as const, label: "Patch refresh" },
    { id: "pass", kind: "outcome" as const, label: "Tests pass" },
  ],
  edges: [
    { id: "e-diagnose", sourceId: "observe", targetId: "diagnose", label: "diagnose" },
    { id: "e-patch", sourceId: "diagnose", targetId: "patch", label: "patch" },
    { id: "e-pass", sourceId: "patch", targetId: "pass", label: "pass" },
  ],
};

function trajectoryContext(spaceId = "space-a") {
  const currentAccess = access({ spaces: [spaceId] });
  return {
    access: currentAccess,
    author: { kind: "human" as const, id: currentAccess.principalId },
    capture: {
      scope: { workspace: currentAccess.workspaceId, space: spaceId },
      identity: {
        principal: currentAccess.principalId,
        workspace: currentAccess.workspaceId,
      },
    },
  };
}

function trajectory(id: string) {
  const steps = tree.nodes.map((node, index) => ({
    id: `${id}-step-${index + 1}`,
    stepNumber: index + 1,
    role: (index === tree.nodes.length - 1 ? "model_output" : "decision") as
      | "model_output"
      | "decision",
    content: node.label,
  }));
  return {
    id,
    taskId: tree.taskId,
    model: { id: "model-a" },
    outcome: "success" as const,
    steps,
    assignments: Object.fromEntries(
      steps.map((step, index) => [
        step.id,
        {
          kind: "mapped" as const,
          nodeId: tree.nodes[index]!.id,
          method: { kind: "manual" as const, id: "operator-review" },
        },
      ]),
    ),
    reviewText: "VERDICT: approve\nCONFIDENCE: 0.9",
  };
}

describe("SDK trajectory API", () => {
  it("records a scoped tree and run, then returns summaries and analysis", async () => {
    const sdk = new FoldSdk(new MemoryStore());
    const context = trajectoryContext();

    await sdk.recordTrajectoryTree(context, stamp("tree-event", 1), tree);
    await sdk.recordTrajectory(context, stamp("run-event", 2), trajectory("run-a"));

    expect(await sdk.trajectoryTasks(context.access)).toEqual([
      expect.objectContaining({
        taskId: tree.taskId,
        trajectoryCount: 1,
        successCount: 1,
        failureCount: 0,
        unknownCount: 0,
      }),
    ]);
    const report = await sdk.trajectoryReport(context.access, tree.taskId);
    expect(report).toMatchObject({
      taskId: tree.taskId,
      analysis: {
        traceCount: 1,
        routeEligibleTraceCount: 1,
        coverage: { total: 4, mapped: 4, mappedRatio: 1 },
      },
      evaluations: [{ trajectoryId: "run-a", review: { verdict: "approve" } }],
    });
    expect(report?.analysis.edgeOutcomes.get("e-pass")).toMatchObject({
      traversals: 1,
      successes: 1,
    });
  });

  it("fails closed for unavailable tasks and duplicate records", async () => {
    const sdk = new FoldSdk(new MemoryStore());
    const context = trajectoryContext();
    await expect(
      sdk.recordTrajectory(context, stamp("missing-event", 1), trajectory("run-a")),
    ).rejects.toBeInstanceOf(TrajectoryTaskUnavailableError);

    await sdk.recordTrajectoryTree(context, stamp("tree-event", 2), tree);
    await expect(
      sdk.recordTrajectoryTree(context, stamp("tree-event", 2), tree),
    ).resolves.toMatchObject({ record: { recordType: "tree" } });
    await expect(
      sdk.recordTrajectoryTree(context, stamp("duplicate-tree", 3), tree),
    ).rejects.toBeInstanceOf(FoldSdkConflictError);
    await sdk.recordTrajectory(context, stamp("run-event", 4), trajectory("run-a"));
    await expect(
      sdk.recordTrajectory(context, stamp("run-event", 4), trajectory("run-a")),
    ).resolves.toMatchObject({ record: { recordType: "trajectory" } });
    await expect(
      sdk.recordTrajectory(context, stamp("duplicate-run", 5), trajectory("run-a")),
    ).rejects.toBeInstanceOf(FoldSdkConflictError);
  });

  it("does not expose space-scoped trajectory records after access is removed", async () => {
    const sdk = new FoldSdk(new MemoryStore());
    const context = trajectoryContext();
    await sdk.recordTrajectoryTree(context, stamp("tree-event", 1), tree);
    await sdk.recordTrajectory(context, stamp("run-event", 2), trajectory("run-a"));

    expect(await sdk.trajectoryTasks(access())).toEqual([]);
    expect(await sdk.trajectoryReport(access(), tree.taskId)).toBeUndefined();
  });

  it("rejects trajectory records carried by a generic event kind", async () => {
    const sdk = new FoldSdk(new MemoryStore());
    const context = trajectoryContext();
    const event = makeTrajectoryTreeRecordedEvent(context, stamp("tree-event", 1), tree);
    const spoofed = parseEvent({ ...event, kind: "generic.event" });

    await expect(sdk.append(context.access, spoofed)).rejects.toThrow(
      "requires a trajectory event kind",
    );
  });
});
