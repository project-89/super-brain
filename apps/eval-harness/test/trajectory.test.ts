import { describe, expect, it } from "vitest";
import type { EvaluationAnnotations } from "@_89/fold-eval";
import { trajectoryLogRecordsFromEvent } from "@_89/fold-trajectory";
import type { AttemptRecord, ExecutionPlan, SubmissionRecord } from "../src/harness.js";
import { NODE_IMAGE } from "../src/harness.js";
import { canonicalJson, sha256 } from "../src/hash.js";
import { evaluateOracleResults, frozenDecisionTree, type OracleCase } from "../src/oracle.js";
import { snapshotOracleValue } from "../src/snapshot.js";
import { attemptTrajectory, observedCheckReport, projectObservedAttempt } from "../src/trajectory.js";

const at = "2026-09-04T00:00:00.000Z", later = "2026-09-04T00:00:01.000Z";
const hash = "a".repeat(64), code = "export function reduceDelivery(state) { return { ...state }; }";
const plan: ExecutionPlan = { version: 1, kind: "real-provider-evaluation-plan", preparedAt: at,
  frozen: { version: 1, taskId: "synthetic-event-delivery-v1", taskVersion: "synthetic-unit-fixture-v1", frozenAt: at, files: { "initial.mjs": hash, "public-task.md": hash, "annotation-rubric.md": hash }, suiteSha256: hash, oracleModuleSha256: [hash] },
  image: NODE_IMAGE, driverSha256: hash, systemPromptSha256: hash, responseSchemaSha256: hash, implementationSha256: hash, runtimes: [], conditions: ["no-memory", "memory"], maxSubmissions: 3 };
const emptyAnnotations: EvaluationAnnotations = { version: 1, annotationVersion: hash, annotations: [] };
const process = { exitCode: 0, signal: null, stdout: "", stderr: "", elapsedMs: 12 };
const test: OracleCase = { id: "unit-empty", group: "unit", description: "Authored synthetic adapter fixture", inputJson: '{"state":{"checkpoint":"0","events":[]},"arrivals":[]}', expected: { kind: "return", value: { checkpoint: "0", events: [] } } };
async function submission(id = "fixture:round-1"): Promise<SubmissionRecord> {
  const snapshot = snapshotOracleValue(JSON.parse(test.inputJson));
  const observations = [{ id: test.id, status: "returned" as const, value: { checkpoint: "0", events: [] }, outputIsJson: true, inputBefore: snapshot, inputAfter: snapshot, freshState: true }];
  return { id, promptSha256: hash, runtime: { provider: "openai-codex", configuredModel: "configured-only", observedModel: "observed-runtime-model", runtimeVersion: "test-only",
    configuration: { effort: "high", arguments: [], systemPromptSha256: hash }, startedAt: at, finishedAt: later, process,
    output: { code, summary: "The model self-reports approval and confidence 10. This is only public text." }, reportedOutcome: "success", protocolIssues: [] },
    container: { image: NODE_IMAGE, driverSha256: hash, codeSha256: sha256(code), process, observations, protocolIssues: [] },
    evaluation: await evaluateOracleResults([test], observations) };
}
function attempt(submissions: readonly SubmissionRecord[]): AttemptRecord {
  return { version: 1, id: "synthetic-unit-attempt", kind: "real-provider", condition: "no-memory", taskVersion: plan.frozen.taskVersion, startedAt: at, finishedAt: later, submissions, comparison: "baseline" };
}

describe("observed attempt shared trajectory adapter", () => {
  it("round-trips actual submission/check steps through canonical records without human approval or invented reasoning", async () => {
    const item = await submission(), input = attempt([item]);
    const result = await projectObservedAttempt(input, plan, await frozenDecisionTree(), emptyAnnotations);
    expect(result.raw.steps.map(({ id, role }) => [id, role])).toEqual([[item.id, "model_output"], [`${item.id}:checks`, "tool_call_response"]]);
    expect(result.raw.outcome).toBe("success");
    expect(result.raw.manifest?.attempt.finalRevision?.revisionId).toBe(`sha256:${sha256(code)}`);
    expect(result.raw.manifest?.attempt.acceptance).toBeUndefined();
    expect(result.input.reviewText).toBeUndefined();
    expect(result.events.every(({ author }) => author.kind === "agent")).toBe(true);
    expect(trajectoryLogRecordsFromEvent(result.events[1]!)[0]?.recordType).toBe("trajectory");
    expect(result.analysis.evaluations[0]?.oracle).toMatchObject({ confidence: null, availability: "unavailable" });
    expect(result.analysis.acceptanceSummary).toEqual([]);
    expect(result.raw.steps[0]?.runtime).toMatchObject({ provenance: "native", modelId: "observed-runtime-model" });
    expect(result.raw.steps[0]?.runtime?.usage).toBeUndefined();
    expect(result.raw.steps[0]?.artifactId).toBe(`eval-output:${sha256(`${canonicalJson(item.runtime.output)}\n`)}`);
    expect(result.raw.steps[1]?.artifactId).toBe(`eval-checks:${sha256(`${canonicalJson(observedCheckReport(item, plan.frozen.suiteSha256))}\n`)}`);
    expect(Object.values(result.assignments).every((assignment) => assignment.kind === "unmapped" && assignment.method.kind === "rule")).toBe(true);
    expect(result.analysis.projectionBasis).toBe("unspecified");
    const another = await projectObservedAttempt({ ...input, id: "later-attempt", startedAt: later, finishedAt: "2026-09-04T00:00:02.000Z" }, plan, await frozenDecisionTree(), emptyAnnotations);
    expect(another.events[0]).toEqual(result.events[0]);
  });
  it("keeps unavailable runtime/check evidence unknown and creates no check step when no container ran", async () => {
    const item = await submission();
    const { container: _container, ...rest } = item;
    const { output: _output, observedModel: _model, ...runtime } = item.runtime;
    const result = await projectObservedAttempt(attempt([{ ...rest, runtime, evaluation: await evaluateOracleResults([test], []) }]), plan, await frozenDecisionTree(), emptyAnnotations);
    expect(result.raw.steps).toHaveLength(1);
    expect(result.raw.steps[0]).toMatchObject({ role: "tool_call_response", toolName: "provider-runtime" });
    expect(result.raw.outcome).toBe("unknown");
    expect(result.raw.model.id).toBe("unreported");
    expect(result.raw.steps[0]?.runtime?.modelId).toBeUndefined();
    expect(result.raw.manifest?.attempt.finalRevision).toBeUndefined();
  });
  it("retains exact context revision and independent ambiguous mappings without expanding a response into hidden decisions", async () => {
    const item = await submission();
    const source = { memoryId: "synthetic-approved-memory", revision: 3 };
    const record = { ...attempt([item]), condition: "memory" as const, memory: { source, recallId: "recall-fixture", content: "Synthetic general lesson", contentSha256: hash,
      request: { query: "public task", limit: 1 }, approval: { kind: "synthetic-human-record" as const, eventId: "actual-synthetic-record" },
      provenance: { version: 1, recallId: "recall-fixture", observedAt: at, operation: "recall", ranking: { id: "lexical", kind: "lexical" }, subject: { organizationId: "synthetic-org", workspaceId: "synthetic-workspace", principalId: "synthetic-principal" }, items: [{ memoryId: source.memoryId, memoryRevision: source.revision, rank: 1 }] } } } as AttemptRecord;
    const result = await projectObservedAttempt(record, plan, await frozenDecisionTree(), { ...emptyAnnotations, annotations: [{ stepId: item.id,
      assignment: { kind: "ambiguous", candidates: ["bigint", "decimal-comparison"], reason: "One submission contains several operations", method: { kind: "manual", id: "frozen-observable-rubric-v1", basis: "structural" } },
      evidence: [{ kind: "code-span", artifactSha256: sha256(code), startLine: 1, endLine: 1 }] }] });
    expect(result.raw.steps).toHaveLength(2);
    expect(result.raw.steps[0]?.context?.memoryRefs).toEqual([source]);
    expect(result.raw.manifest?.attempt.context?.memoryRefs).toEqual([source]);
    expect(result.assignments[item.id]).toMatchObject({ kind: "ambiguous", candidates: ["bigint", "decimal-comparison"] });
  });
  it("preserves per-round runtime identity and never presents a mixed or partly unknown attempt as its final model", async () => {
    const first = await submission(), second = await submission("fixture:round-2");
    const changed = { ...second, runtime: { ...second.runtime, observedModel: "another-observed-model" } };
    const result = attemptTrajectory(attempt([first, changed]), plan);
    expect(result.model).toEqual({ id: "mixed-observed-runtimes" });
    expect(result.steps.filter(({ runtime }) => runtime !== undefined).map(({ runtime }) => runtime?.modelId)).toEqual(["observed-runtime-model", "another-observed-model"]);
    const { observedModel: _model, ...runtime } = second.runtime;
    expect(attemptTrajectory(attempt([first, { ...second, runtime }]), plan).model).toEqual({ id: "unreported" });
  });
  it("rejects changed check-code identity, nonexistent annotations, duplicate rounds and wrong frozen versions", async () => {
    const item = await submission();
    expect(() => attemptTrajectory(attempt([{ ...item, container: { ...item.container!, codeSha256: "b".repeat(64) } }]), plan)).toThrow(/exact submitted code/);
    expect(() => attemptTrajectory(attempt([item, item]), plan)).toThrow(/collide/);
    expect(() => attemptTrajectory({ ...attempt([item]), taskVersion: "different" }, plan)).toThrow(/task version/);
    const unknown: EvaluationAnnotations = { ...emptyAnnotations, annotations: [{ stepId: "invented-step", assignment: { kind: "unmapped", reason: "Unavailable", method: { kind: "manual", id: "frozen-observable-rubric-v1", basis: "structural" } }, evidence: [{ kind: "check", caseId: test.id, roundId: item.id }] }] };
    await expect(projectObservedAttempt(attempt([item]), plan, await frozenDecisionTree(), unknown)).rejects.toThrow(/unobserved step/);
    await expect(projectObservedAttempt(attempt([item]), plan, await frozenDecisionTree(), { ...emptyAnnotations, annotationVersion: "wrong" })).rejects.toThrow(/rubric/);
  });
});
