import { describe, expect, it } from "vitest";

import {
  analyzeProjectedTrajectories,
  firstDivergentEdge,
  projectTrajectory,
  type ProjectionAssignment,
  type RawTrajectory,
  type SharedDecisionTree,
} from "../src/index.js";

const tree: SharedDecisionTree = {
  taskId: "parity",
  rootNodeId: "root",
  nodes: [
    { id: "root", kind: "decision", label: "Choose route" },
    { id: "a", kind: "action", label: "Route A" },
    { id: "b", kind: "action", label: "Route B" },
    { id: "success", kind: "outcome", label: "Success" },
    { id: "failure", kind: "outcome", label: "Failure" },
  ],
  edges: [
    { id: "root-a", sourceId: "root", targetId: "a", label: "A" },
    { id: "root-b", sourceId: "root", targetId: "b", label: "B" },
    { id: "a-success", sourceId: "a", targetId: "success", label: "done" },
    { id: "b-success", sourceId: "b", targetId: "success", label: "done" },
    { id: "b-failure", sourceId: "b", targetId: "failure", label: "failed" },
  ],
};

const capture = {
  scope: { workspace: "super-brain", space: "parity", creator: "fixture" },
  identity: { repo: "fixture", branch: "test" },
};
const method = { kind: "manual" as const, id: "decision-pathfinder-parity" };

function projected(id: string, path: readonly string[], outcome: "success" | "failure") {
  const raw: RawTrajectory = {
    id,
    taskId: tree.taskId,
    model: { id: "fixture" },
    outcome,
    capture,
    steps: path.map((nodeId, index) => ({
      id: `${id}-${index}`,
      stepNumber: index + 1,
      role: index === path.length - 1 ? "model_output" : "decision",
      content: nodeId,
    })),
  };
  const assignments = Object.fromEntries(
    raw.steps.map((step, index) => [
      step.id,
      { kind: "mapped", nodeId: path[index]!, method },
    ]),
  ) as Record<string, ProjectionAssignment>;
  return projectTrajectory(raw, tree, assignments);
}

describe("decision-pathfinder route parity", () => {
  it("selects the successful consensus route and identifies the first divergent edge", () => {
    const routeA = projected("a", ["root", "a", "success"], "success");
    const routeB = projected("b", ["root", "b", "failure"], "failure");
    const analysis = analyzeProjectedTrajectories([routeA, routeB], tree);

    expect(analysis.mostSuccessfulPath).toEqual(["root", "a", "success"]);
    expect(firstDivergentEdge(routeB, analysis.mostSuccessfulPath, tree)).toMatchObject({
      kind: "divergent",
      edgeIndex: 0,
      expectedEdge: { id: "root-a" },
      actualEdge: { id: "root-b" },
    });
  });

  it("breaks equal route scores deterministically instead of by insertion order", () => {
    const routeA = projected("a", ["root", "a", "success"], "success");
    const routeB = projected("b", ["root", "b", "success"], "success");
    expect(analyzeProjectedTrajectories([routeB, routeA], tree).mostSuccessfulPath).toEqual([
      "root",
      "a",
      "success",
    ]);
  });
});
