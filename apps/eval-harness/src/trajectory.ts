import { projectTrajectory, type ProjectionAssignment, type TraceStep, type SharedDecisionTree } from "@_89/fold-trace";
import type { EvaluationAnnotations, EvaluationChecks } from "@_89/fold-eval";
import { analyzeTrajectoryTask, makeTrajectoryRecordedEvent, makeTrajectoryTreeRecordedEvent, projectionAssignmentSchema, rebuildTrajectories, type TrajectoryInput, type TrajectoryEventContext } from "@_89/fold-trajectory";
import { sha256, canonicalJson } from "./hash.js";
import type { AttemptRecord, ExecutionPlan, SubmissionRecord } from "./harness.js";

/** Exact selected check artifact; both the trajectory reference and export hash these same bytes. */
export function observedCheckReport(submission: SubmissionRecord, oracleVersion: string): EvaluationChecks {
  return { version: 1, suiteVersion: oracleVersion,
    ...(submission.runtime.output === undefined ? {} : { codeSha256: sha256(submission.runtime.output.code) }),
    availability: submission.evaluation.availability === "available" ? "completed" : "unavailable",
    checks: submission.evaluation.checks.map((check) => ({ id: check.id, status: check.status === "pass" ? "passed" : check.status === "fail" ? "failed" : "unavailable",
      ...(check.reasons.length === 0 ? {} : { detail: check.reasons.join(", ") }) })),
    ...(submission.submissionFailure === undefined ? {} : { reason: submission.submissionFailure }) };
}

/** One response and one actually executed check batch per round; no invented intermediate decisions. */
export function attemptTrajectory(attempt: AttemptRecord, plan: ExecutionPlan, assignments: Readonly<Record<string, ProjectionAssignment>> = {}): TrajectoryInput {
  if (attempt.taskVersion !== plan.frozen.taskVersion) throw new Error("Attempt task version does not match frozen task");
  const steps: TraceStep[] = [];
  for (const submission of attempt.submissions) {
    const observation = submission.runtime;
    const usage = observation.usage;
    const firstContext = attempt.memory === undefined ? {} : { context: { memoryRefs: [attempt.memory.source], artifacts: [{ artifactId: `eval-memory:${attempt.memory.contentSha256}`, kind: "context" as const, sha256: attempt.memory.contentSha256 }] } };
    steps.push({ id: submission.id, stepNumber: steps.length + 1, role: observation.output === undefined ? "tool_call_response" : "model_output", ...(observation.output === undefined ? { toolName: "provider-runtime" } : {}), content: observation.output?.summary ?? "Provider runtime returned no usable module; see retained preparation evidence.",
      artifactId: `eval-output:${sha256(`${canonicalJson(observation.output ?? { availability: "unavailable", reportedOutcome: observation.reportedOutcome, protocolIssues: observation.protocolIssues })}\n`)}`,
      startedAt: observation.startedAt, durationMs: observation.process.elapsedMs, ...firstContext,
      runtime: { provenance: "native", providerId: observation.provider, ...(observation.observedModel === undefined ? {} : { modelId: observation.observedModel }), harness: { id: "super-brain-eval-harness", version: "1" },
        configurationId: sha256(canonicalJson(observation.configuration)), settings: { reasoningEffort: observation.configuration.effort }, permissionMode: "isolated-noninteractive",
        ...(usage === undefined ? {} : { usageInterpretation: "unknown", usageScope: "unknown", usage: { ...(usage.input_tokens === undefined ? {} : { inputTokens: usage.input_tokens }), ...(usage.output_tokens === undefined ? {} : { outputTokens: usage.output_tokens }), ...(usage.cached_input_tokens === undefined ? {} : { cachedInputTokens: usage.cached_input_tokens }) } }) } });
    if (submission.container !== undefined) steps.push({ id: `${submission.id}:checks`, stepNumber: steps.length + 1, role: "tool_call_response", toolName: "frozen-container-oracle", durationMs: submission.container.process.elapsedMs,
      artifactId: `eval-checks:${sha256(`${canonicalJson(observedCheckReport(submission, plan.frozen.suiteSha256))}\n`)}`, content: JSON.stringify({ authority: "automated-checks", acceptance: submission.evaluation.acceptance, passed: submission.evaluation.passed, failed: submission.evaluation.failed, unavailable: submission.evaluation.unavailable }) });
  }
  if (steps.length === 0) throw new Error("No observed submissions are available for trajectory projection");
  const stepIds = new Set(steps.map(({ id }) => id));
  if (stepIds.size !== steps.length) throw new Error("Observed submission and check step IDs collide");
  if (Object.keys(assignments).some((id) => !stepIds.has(id))) throw new Error("Annotation references an unobserved step");
  const final = attempt.submissions.at(-1), initialHash = plan.frozen.files["initial.mjs"]!;
  const finalHash = final?.runtime.output === undefined ? undefined : sha256(final.runtime.output.code);
  for (const submission of attempt.submissions) if (submission.container !== undefined && (submission.runtime.output === undefined || submission.container.codeSha256 !== sha256(submission.runtime.output.code))) {
    throw new Error("Observed checks do not match the exact submitted code");
  }
  const observedModels = new Set(attempt.submissions.flatMap(({ runtime }) => runtime.observedModel === undefined ? [] : [runtime.observedModel]));
  const aggregateModel = observedModels.size > 1 ? "mixed-observed-runtimes" : attempt.submissions.some(({ runtime }) => runtime.observedModel === undefined) ? "unreported" : [...observedModels][0] ?? "unreported";
  const unresolved: ProjectionAssignment = { kind: "unmapped", reason: "Independent evidence-based annotation has not been applied", method: { kind: "rule", id: "unannotated-observation-v1" } };
  return { id: attempt.id, taskId: plan.frozen.taskId, model: { id: aggregateModel },
    outcome: attempt.kind === "preparation-failure" || final?.evaluation.acceptance === "unavailable" || final === undefined ? "unknown" : final.evaluation.acceptance === "passed" ? "success" : "failure", steps,
    assignments: Object.fromEntries(steps.map((step) => [step.id, assignments[step.id] ?? unresolved])),
    manifest: { version: 1, task: { version: 1, taskId: plan.frozen.taskId, taskVersion: plan.frozen.taskVersion, goal: "Implement the frozen synthetic event-delivery reducer", specification: { artifactId: `eval-task:${plan.frozen.files["public-task.md"]}`, kind: "task-spec", sha256: plan.frozen.files["public-task.md"]! }, inputs: [{ artifactId: `eval-input:${initialHash}`, kind: "input", sha256: initialHash }] },
      attempt: { version: 1, attemptId: attempt.id, taskId: plan.frozen.taskId, taskVersion: plan.frozen.taskVersion, conditionId: attempt.condition, startedAt: attempt.startedAt,
        startRevision: { fingerprintStatus: "available", revisionId: `sha256:${initialHash}`, reconstruction: "unavailable" },
        ...(finalHash === undefined ? {} : { finalRevision: { fingerprintStatus: "available", revisionId: `sha256:${finalHash}`, reconstruction: "unavailable" } }),
        ...(attempt.memory === undefined ? {} : { context: { memoryRefs: [attempt.memory.source] } }) } } };
}

/** Rebuild the actual observed rounds using the shared canonical trajectory and trace projections.
 * These local records describe harness observations. They carry no captured or human approval authority.
 * The selected-bundle verifier separately validates every annotation's concrete code/check evidence.
 */
export async function projectObservedAttempt(attempt: AttemptRecord, plan: ExecutionPlan, tree: SharedDecisionTree, annotations: EvaluationAnnotations) {
  if (annotations.version !== 1 || annotations.annotationVersion !== plan.frozen.files["annotation-rubric.md"]) throw new Error("Annotation rubric differs from frozen task");
  const assignments = Object.create(null) as Record<string, ProjectionAssignment>;
  for (const annotation of annotations.annotations) {
    if (Object.hasOwn(assignments, annotation.stepId)) throw new Error("Duplicate observed step annotation");
    if (annotation.assignment.method.kind !== "manual" || annotation.assignment.method.id !== "frozen-observable-rubric-v1" || !["structural", "semantic"].includes(annotation.assignment.method.basis)) throw new Error("Annotation requires the frozen observable rubric");
    assignments[annotation.stepId] = projectionAssignmentSchema.parse(annotation.assignment) as ProjectionAssignment;
  }
  const input = attemptTrajectory(attempt, plan, assignments);
  const workspaceId = "synthetic-evaluation", principalId = "evaluation-harness";
  const context: TrajectoryEventContext = {
    access: { principalId, workspaceId, workspaceRole: "member", spaceRoles: {} },
    author: { kind: "agent", id: principalId },
    capture: { scope: { workspace: workspaceId }, identity: { principal: principalId, workspace: workspaceId } },
  };
  const started = Date.parse(attempt.startedAt), finished = Date.parse(attempt.finishedAt), frozenAt = Date.parse(plan.frozen.frozenAt);
  if (!Number.isSafeInteger(started) || started < 0 || !Number.isSafeInteger(finished) || finished < started || !Number.isSafeInteger(frozenAt) || frozenAt < 0 || frozenAt > started) throw new Error("Observed attempt timestamps are invalid");
  const stamp = (id: string, t: number) => ({ id, t, worldDate: new Date(t).toISOString().slice(0, 16) });
  const treeEvent = makeTrajectoryTreeRecordedEvent(context, stamp(`eval-tree:${plan.frozen.suiteSha256}`, frozenAt), tree);
  const trajectoryEvent = makeTrajectoryRecordedEvent(context, stamp(`eval-attempt:${attempt.id}:${sha256(canonicalJson(input))}`, Math.max(started + 1, finished)), tree, input);
  const events = [treeEvent, trajectoryEvent];
  const state = rebuildTrajectories(events);
  const record = state.trajectories.get(input.id)!;
  const projected = projectTrajectory(record.trajectory, tree, record.assignments);
  const analysis = await analyzeTrajectoryTask(state, input.taskId);
  if (analysis === undefined) throw new Error("Observed trajectory projection is unavailable");
  return { input, raw: record.trajectory, assignments: record.assignments, projected, events, analysis };
}
