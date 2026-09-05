import { describe, expect, it } from "vitest";
import { parseEvent } from "@_89/fold";

import {
  TrajectoryProjectionError,
  analyzeTrajectoryTask,
  makeTrajectoryRecordedEvent,
  makeTrajectoryTreeRecordedEvent,
  rebuildTrajectories,
  trajectoryLogRecordsFromEvent,
  type TrajectoryEventContext,
  type TrajectoryInput,
  type TrajectoryManifest,
  trajectoryInputSchema,
  makeTaskEvidenceEvent,
  type TaskAcceptanceRef,
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

function approvalEvent(acceptance: TaskAcceptanceRef, t: number) {
  return parseEvent({ specVersion: "0.7", id: acceptance.eventId, kind: "terminal.observation", title: "Observed approval", at: { t, worldDate: "2026-09-05", granularity: "session" },
    author: context.author, participants: [context.access.principalId], capture: context.capture,
    changes: [{ verb: "create", subject: `approval:${acceptance.eventId}`, nodeKind: "x.fold.activity-observation", after: { observation: "human_decision", data: { acceptance: JSON.parse(JSON.stringify(acceptance)) } } }],
  });
}

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
  it("round-trips the complete attempt manifest, runtime observations and structural basis through events and projections", async () => {
    const manifest: TrajectoryManifest = { version: 1,
      task: { version: 1, taskId: tree.taskId, taskVersion: "spec-v1", goal: "Refresh an expired token", acceptanceCriteria: [{ id: "test", description: "Original request succeeds" }], specification: { artifactId: "spec", kind: "task-spec" }, inputs: [{ artifactId: "input", kind: "input", sha256: "a".repeat(64), byteLength: 0 }] },
      attempt: { version: 1, attemptId: "attempt-a", taskId: tree.taskId, taskVersion: "spec-v1", conditionId: "memory", startedAt: "2026-09-05T00:00:00Z",
        startRevision: { fingerprintStatus: "available", revisionId: "opaque-before", snapshot: { artifactId: "before", kind: "repository-snapshot" }, reconstruction: "complete" },
        finalRevision: { fingerprintStatus: "available", revisionId: "opaque-after", snapshot: { artifactId: "after", kind: "repository-snapshot" }, reconstruction: "complete" },
        context: { memoryRefs: [{ memoryId: "memory", revision: 2 }], artifacts: [{ artifactId: "context", kind: "context" }], lineage: [{ kind: "compaction", eventId: "compaction", previousTurnId: "previous-turn" }] },
        acceptance: { version: 1, taskId: tree.taskId, attemptId: "attempt-a", revisionId: "opaque-after", verdict: "success", eventId: "approved", artifactId: "approval", criterionIds: ["test"] },
      },
    };
    const base = input("full", "observed-model", "success", ["observe-401", "token-expiry", "patch-refresh", "pass"], "VERDICT: approve");
    const captured: TrajectoryInput = { ...base, manifest, steps: base.steps.map((step) => ({ ...step, runtime: { provenance: "native", providerId: "observed-provider", modelId: "observed-model", modelVersion: "v1", harness: { id: "harness", version: "2" }, configurationId: "config-hash", settings: { temperature: 0, topP: 1, maxOutputTokens: 100, reasoningEffort: "high" }, tools: [{ name: "test", version: "1" }], permissionMode: "read-only", usage: { inputTokens: 0, outputTokens: 5, cachedInputTokens: 0, reasoningTokens: 0, durationMs: 12, cost: { amount: 0, currency: "USD" } } }, context: manifest.attempt.context })),
      assignments: Object.fromEntries(Object.entries(base.assignments).map(([id, assignment]) => [id, { ...assignment, method: { ...assignment.method, basis: "structural" } }])) };
    const treeEvent = makeTrajectoryTreeRecordedEvent(context, { id: "tree", t: 1, worldDate: "2026-09-05" }, tree);
    const runEvent = makeTrajectoryRecordedEvent(context, { id: "full", t: 2, worldDate: "2026-09-05" }, tree, captured);
    const record = trajectoryLogRecordsFromEvent(runEvent)[0];
    expect(record).toMatchObject({ recordType: "trajectory", trajectory: { manifest, steps: captured.steps }, assignments: captured.assignments });
    const report = await analyzeTrajectoryTask(rebuildTrajectories([runEvent, treeEvent, approvalEvent(manifest.attempt.acceptance!, 1.5)]), tree.taskId);
    expect(report?.projected[0]?.manifest).toEqual(manifest);
    expect(report).toMatchObject({ comparison: { status: "compatible", taskVersions: ["spec-v1"] }, projectionBasis: "structural", evidenceAvailability: "reference-only", acceptanceSummary: [] });
    expect(trajectoryInputSchema.safeParse({ ...captured, manifest: { ...manifest, attempt: { ...manifest.attempt, finalRevision: { fingerprintStatus: "unavailable" } } } }).success).toBe(false);
  });

  it("keeps authenticated delayed acceptance separate from historical labels and incompatible comparisons", async () => {
    const treeEvent = makeTrajectoryTreeRecordedEvent(context, { id: "tree", t: 1, worldDate: "2026-09-05" }, tree);
    const makeRun = (id: string, version: string, revisionId: string, t: number) => makeTrajectoryRecordedEvent(context, { id, t, worldDate: "2026-09-05" }, tree, {
      ...input(id, "model", "failure", ["observe-401", "network", "retry", "fail"], "VERDICT: reject\nCONFIDENCE: 1"),
      manifest: { version: 1, task: { version: 1, taskId: tree.taskId, taskVersion: version }, attempt: { version: 1, attemptId: id, taskId: tree.taskId, taskVersion: version, startRevision: { fingerprintStatus: "available", revisionId } } },
    });
    const first = makeRun("a", "v1", "before", 2); const second = makeRun("b", "v2", "other-input", 3);
    const outcome = makeTaskEvidenceEvent(context, { id: "outcome", t: 4, worldDate: "2026-09-05" }, { recordType: "outcome", authority: { kind: "human", principalId: context.access.principalId }, input: { version: 1, id: "outcome", taskId: tree.taskId, attemptId: "a", revisionId: "before", kind: "acceptance", result: "success", observedAt: "2026-09-05T00:00:00Z", sourceEventId: "approved", acceptance: { version: 1, taskId: tree.taskId, attemptId: "a", revisionId: "before", verdict: "success", eventId: "approved", artifactId: "approval" } } });
    const source = approvalEvent({ version: 1, taskId: tree.taskId, attemptId: "a", revisionId: "before", verdict: "success", eventId: "approved", artifactId: "approval" }, 3.5);
    const report = await analyzeTrajectoryTask(rebuildTrajectories([outcome, second, first, treeEvent, source]), tree.taskId);
    expect(report?.records[0]?.trajectory.outcome).toBe("failure");
    expect(report).toMatchObject({ comparison: { status: "incompatible" }, analysis: { traceCount: 0 }, acceptanceSummary: [{ attemptId: "a", revisionId: "before", verdict: "success", authority: "authenticated-human", outcomeIds: ["outcome"] }] });
  });

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
    expect(report?.evaluations.map(({ review, oracle, reviewProvenance }) => [review.verdict, oracle.confidence, reviewProvenance])).toEqual([
      ["approve", null, "legacy-self-reported"],
      ["reject", null, "legacy-self-reported"],
    ]);
    expect(report?.evaluations.every(({ oracle }) => oracle.availability === "unavailable" && oracle.executions.length === 0)).toBe(true);
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
