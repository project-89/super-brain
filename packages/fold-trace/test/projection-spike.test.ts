import { describe, expect, it } from "vitest";

import {
  analyzeProjectedTrajectories,
  firstDivergentEdge,
  projectTrajectory,
  type ProjectionAssignment,
  type RawTrajectory,
  type SharedDecisionTree,
} from "../src/index.js";

const taskId = "task_refresh_token_regression";
const capture = {
  scope: {
    workspace: "workspace_super_brain",
    space: "projection_spike",
    creator: "creator_fixture",
  },
  identity: {
    repo: "fixture/auth-service",
    branch: "test/projection",
  },
};

const tree: SharedDecisionTree = {
  taskId,
  rootNodeId: "inspect_failure",
  nodes: [
    { id: "inspect_failure", kind: "observation", label: "Inspect the failing refresh test" },
    { id: "diagnose_expiry", kind: "decision", label: "Attribute 401 to refresh expiry" },
    { id: "diagnose_network", kind: "decision", label: "Attribute 401 to transient network failure" },
    { id: "patch_refresh_guard", kind: "action", label: "Refresh before replaying request" },
    { id: "patch_retry", kind: "action", label: "Add a generic network retry" },
    { id: "verify_tests", kind: "action", label: "Run focused tests" },
    { id: "success", kind: "outcome", label: "Focused suite passes" },
    { id: "failure", kind: "outcome", label: "Focused suite still fails" },
  ],
  edges: [
    { id: "edge_expiry", sourceId: "inspect_failure", targetId: "diagnose_expiry", label: "token evidence" },
    { id: "edge_network", sourceId: "inspect_failure", targetId: "diagnose_network", label: "network hypothesis" },
    { id: "edge_refresh_patch", sourceId: "diagnose_expiry", targetId: "patch_refresh_guard", label: "fix refresh" },
    { id: "edge_retry_patch", sourceId: "diagnose_network", targetId: "patch_retry", label: "add retry" },
    { id: "edge_verify_refresh", sourceId: "patch_refresh_guard", targetId: "verify_tests", label: "verify" },
    { id: "edge_verify_retry", sourceId: "patch_retry", targetId: "verify_tests", label: "verify" },
    { id: "edge_success", sourceId: "verify_tests", targetId: "success", label: "passes" },
    { id: "edge_failure", sourceId: "verify_tests", targetId: "failure", label: "fails" },
  ],
};

const modelA: RawTrajectory = {
  id: "trace_model_a",
  taskId,
  model: { id: "model-a", version: "fixture" },
  outcome: "success",
  capture,
  steps: [
    { id: "a1", stepNumber: 1, role: "tool_call", toolName: "test", content: "Run the failing refresh test" },
    { id: "a2", stepNumber: 2, role: "decision", content: "The refresh token expires before replay" },
    { id: "a3", stepNumber: 3, role: "tool_call", toolName: "edit", content: "Refresh credentials before replay" },
    { id: "a4", stepNumber: 4, role: "tool_call", toolName: "test", content: "Run the focused suite" },
    { id: "a5", stepNumber: 5, role: "model_output", content: "Focused suite passes" },
  ],
};

const modelB: RawTrajectory = {
  id: "trace_model_b",
  taskId,
  model: { id: "model-b", version: "fixture" },
  outcome: "failure",
  capture,
  steps: [
    { id: "b1", stepNumber: 1, role: "tool_call", toolName: "test", content: "Run the failing refresh test" },
    { id: "b2", stepNumber: 2, role: "decision", content: "Treat the 401 as a transient network failure" },
    { id: "b3", stepNumber: 3, role: "tool_call", toolName: "edit", content: "Add a generic retry" },
    { id: "b4", stepNumber: 4, role: "tool_call", toolName: "search", content: "Search proxy logs for related errors" },
    { id: "b5", stepNumber: 5, role: "tool_call", toolName: "test", content: "Run the focused suite" },
    { id: "b6", stepNumber: 6, role: "model_thought", content: "Summarize limitations for the user" },
    { id: "b7", stepNumber: 7, role: "model_output", content: "Focused suite still fails" },
  ],
};

const manual = { kind: "manual" as const, id: "projection-spike/2026-08-14", confidence: 1 };

const assignmentsA: Record<string, ProjectionAssignment> = {
  a1: { kind: "mapped", nodeId: "inspect_failure", method: manual },
  a2: { kind: "mapped", nodeId: "diagnose_expiry", method: manual },
  a3: { kind: "mapped", nodeId: "patch_refresh_guard", method: manual },
  a4: { kind: "mapped", nodeId: "verify_tests", method: manual },
  a5: { kind: "mapped", nodeId: "success", method: manual },
};

const assignmentsB: Record<string, ProjectionAssignment> = {
  b1: { kind: "mapped", nodeId: "inspect_failure", method: manual },
  b2: { kind: "mapped", nodeId: "diagnose_network", method: manual },
  b3: { kind: "mapped", nodeId: "patch_retry", method: manual },
  b4: {
    kind: "ambiguous",
    candidates: ["diagnose_network", "verify_tests"],
    reason: "The search both extends diagnosis and prepares verification",
    method: { ...manual, confidence: 0.5 },
  },
  b5: { kind: "mapped", nodeId: "verify_tests", method: manual },
  b6: {
    kind: "unmapped",
    reason: "User-facing explanation is not a task decision node",
    method: manual,
  },
  b7: { kind: "mapped", nodeId: "failure", method: manual },
};

describe("two-model projection feasibility spike", () => {
  it("retains raw steps, capture scope, ambiguity, and unmapped outcomes", () => {
    const projected = projectTrajectory(modelB, tree, assignmentsB);

    expect(projected.capture).toEqual(capture);
    expect(projected.steps[3]).toEqual({
      raw: modelB.steps[3],
      projection: assignmentsB.b4,
    });
    expect(projected.steps[5]?.projection.kind).toBe("unmapped");
  });

  it("aggregates mapped adjacent edges without bridging projection gaps", () => {
    const projectedA = projectTrajectory(modelA, tree, assignmentsA);
    const projectedB = projectTrajectory(modelB, tree, assignmentsB);
    const analysis = analyzeProjectedTrajectories([projectedA, projectedB], tree);

    expect(analysis.traceCount).toBe(2);
    expect(analysis.routeEligibleTraceCount).toBe(1);
    expect(analysis.incompleteTraceCount).toBe(1);
    expect(analysis.coverage).toEqual({
      total: 12,
      mapped: 10,
      ambiguous: 1,
      unmapped: 1,
      mappedRatio: 10 / 12,
    });
    expect(analysis.mostSuccessfulPath).toEqual([
      "inspect_failure",
      "diagnose_expiry",
      "patch_refresh_guard",
      "verify_tests",
      "success",
    ]);
    expect(analysis.edgeOutcomes.get("edge_expiry")).toMatchObject({
      traversals: 1,
      successes: 1,
      failures: 0,
    });
    expect(analysis.edgeOutcomes.get("edge_network")).toMatchObject({
      traversals: 1,
      successes: 0,
      failures: 1,
    });
    expect(analysis.edgeOutcomes.has("edge_verify_retry")).toBe(false);
    expect(analysis.edgeOutcomes.has("edge_failure")).toBe(false);
  });

  it("does not count an unverified outcome as a failure", () => {
    const unknown = projectTrajectory({ ...modelA, id: "trace_unknown", outcome: "unknown" }, tree, assignmentsA);
    const analysis = analyzeProjectedTrajectories([
      projectTrajectory(modelA, tree, assignmentsA),
      unknown,
    ], tree);
    expect(analysis.edgeOutcomes.get("edge_expiry")).toMatchObject({
      traversals: 2,
      successes: 1,
      failures: 0,
      unknowns: 1,
      classifiedSamples: 1,
      successRate: 1,
    });
  });

  it("does not claim a consensus path from unknown-only outcomes", () => {
    const unknown = projectTrajectory({ ...modelA, id: "trace_unknown", outcome: "unknown" }, tree, assignmentsA);
    const analysis = analyzeProjectedTrajectories([unknown], tree);
    expect(analysis.routes[0]).toMatchObject({ samples: 1, classifiedSamples: 0, unknowns: 1 });
    expect(analysis.mostSuccessfulPath).toEqual([]);
    expect(firstDivergentEdge(unknown, analysis.mostSuccessfulPath, tree)).toEqual({
      kind: "indeterminate",
      comparedEdges: 0,
      reason: "no-consensus",
    });
  });

  it("finds the first divergent edge before later projection gaps", () => {
    const projectedA = projectTrajectory(modelA, tree, assignmentsA);
    const projectedB = projectTrajectory(modelB, tree, assignmentsB);
    const analysis = analyzeProjectedTrajectories([projectedA, projectedB], tree);
    const divergence = firstDivergentEdge(
      projectedB,
      analysis.mostSuccessfulPath,
      tree,
      analysis.edgeOutcomes,
    );

    expect(divergence).toMatchObject({
      kind: "divergent",
      edgeIndex: 0,
      expectedEdge: { id: "edge_expiry" },
      actualEdge: { id: "edge_network" },
      expectedOutcome: { successRate: 1 },
      actualOutcome: { successRate: 0 },
    });
  });

  it("reports indeterminate rather than guessing across an early ambiguity", () => {
    const earlyAmbiguity: Record<string, ProjectionAssignment> = {
      ...assignmentsB,
      b2: {
        kind: "ambiguous",
        candidates: ["diagnose_expiry", "diagnose_network"],
        reason: "The step does not disambiguate token expiry from transport failure",
        method: { ...manual, confidence: 0.5 },
      },
    };
    const projectedA = projectTrajectory(modelA, tree, assignmentsA);
    const projectedB = projectTrajectory(modelB, tree, earlyAmbiguity);
    const analysis = analyzeProjectedTrajectories([projectedA, projectedB], tree);

    expect(firstDivergentEdge(projectedB, analysis.mostSuccessfulPath, tree)).toEqual({
      kind: "indeterminate",
      comparedEdges: 0,
      reason: "projection-gap",
      stepId: "b2",
    });
  });

  it("requires one explicit projection outcome per raw step", () => {
    const incomplete = { ...assignmentsA };
    delete incomplete.a3;
    expect(() => projectTrajectory(modelA, tree, incomplete)).toThrow(
      /raw step a3 has no projection outcome/,
    );
  });

  it("rejects cyclic or unreachable shared decision structures", () => {
    const cyclic: SharedDecisionTree = {
      ...tree,
      edges: [
        ...tree.edges,
        { id: "edge_cycle", sourceId: "success", targetId: "inspect_failure", label: "cycle" },
      ],
    };
    expect(() => projectTrajectory(modelA, cyclic, assignmentsA)).toThrow(
      /root node must not have incoming edges|contains a cycle/,
    );

    const unreachable: SharedDecisionTree = {
      ...tree,
      nodes: [...tree.nodes, { id: "orphan", kind: "action", label: "Orphan" }],
    };
    expect(() => projectTrajectory(modelA, unreachable, assignmentsA)).toThrow(
      /unreachable from the root/,
    );
  });
});
