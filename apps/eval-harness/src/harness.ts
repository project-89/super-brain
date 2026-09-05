import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { canonicalJson, sha256 } from "./hash.js";
import { containerDriverSource, executeInContainer, type ContainerObservation } from "./container.js";
import { DEFAULT_FIXTURE_DIRECTORY, evaluateOracleResults, frozenOracleCases, verifyFrozenFixture, type FreezeManifest, type FrozenOracleEvaluation, type OracleCase } from "./oracle.js";
import { FIXED_SYSTEM_PROMPT, RESPONSE_SCHEMA, runRuntime, type RuntimeObservation, type RuntimeSpec } from "./runtime.js";
import { createSyntheticMemoryService, type RetrievedSyntheticMemory } from "./memory.js";
import { probeCodexIsolation } from "./preflight.js";

export const NODE_IMAGE = "node@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf";
export function runtimeContract(runtimes: readonly RuntimeSpec[]) {
  return { version: 1, observationContractVersion: 2, systemPrompt: FIXED_SYSTEM_PROMPT, responseSchema: RESPONSE_SCHEMA, runtimes: runtimes.map(({ provider, configuredModel, effort, timeoutMs, expectedVersion, codexCatalog }) => ({ provider, configuredModel, effort, timeoutMs, expectedVersion,
    ...(codexCatalog === undefined ? {} : { catalogSha256: sha256(canonicalJson(codexCatalog)), advertisedInputStub: "request_user_input (Plan mode only; unavailable in noninteractive Default mode)" }) })) };
}
export interface ExecutionPlan {
  readonly version: 1;
  readonly kind: "real-provider-evaluation-plan";
  readonly preparedAt: string;
  readonly frozen: FreezeManifest;
  readonly image: string;
  readonly driverSha256: string;
  readonly systemPromptSha256: string;
  readonly responseSchemaSha256: string;
  readonly implementationSha256: string;
  readonly runtimes: readonly RuntimeSpec[];
  readonly conditions: readonly ["no-memory", "memory"];
  readonly maxSubmissions: 3;
}
export async function implementationSha256(): Promise<string> {
  const directory = import.meta.dirname;
  const names = (await readdir(directory)).filter((name) => name.endsWith(directory.endsWith("/src") ? ".ts" : ".js")).sort();
  return sha256((await Promise.all(names.map(async (name) => `${name}\0${sha256(await readFile(join(directory, name)))}\n`))).join(""));
}
export async function prepareExecutionPlan(runtimes: readonly RuntimeSpec[], fixture = DEFAULT_FIXTURE_DIRECTORY, image = NODE_IMAGE, preparedAt = new Date().toISOString()): Promise<ExecutionPlan> {
  if (runtimes.length !== 2 || new Set(runtimes.map((runtime) => runtime.provider)).size !== 2) throw new Error("Exactly two different providers are required");
  const frozen = await verifyFrozenFixture(fixture, { driverSha256: sha256(containerDriverSource()), runtimeContractSha256: sha256(canonicalJson(runtimeContract(runtimes))) });
  if (!Number.isFinite(Date.parse(preparedAt)) || Date.parse(preparedAt) < Date.parse(frozen.frozenAt)) throw new Error("Execution plan predates the frozen task");
  return { version: 1, kind: "real-provider-evaluation-plan", preparedAt, frozen, image,
    driverSha256: sha256(containerDriverSource()), systemPromptSha256: sha256(FIXED_SYSTEM_PROMPT), responseSchemaSha256: sha256(canonicalJson(RESPONSE_SCHEMA)),
    implementationSha256: await implementationSha256(), runtimes, conditions: ["no-memory", "memory"], maxSubmissions: 3 };
}
export function executionPlanSha256(plan: ExecutionPlan): string { return sha256(canonicalJson(plan)); }
export interface SubmissionRecord {
  readonly id: string;
  readonly promptSha256: string;
  readonly runtime: RuntimeObservation;
  readonly container?: ContainerObservation;
  readonly evaluation: FrozenOracleEvaluation;
  readonly submissionFailure?: "provider-or-protocol" | "container-unavailable" | "candidate-module-unavailable";
}
export interface AttemptRecord {
  readonly version: 1;
  readonly id: string;
  readonly kind: "real-provider" | "synthetic-fixture" | "preparation-failure";
  readonly condition: "no-memory" | "memory";
  readonly taskVersion: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly memory?: RetrievedSyntheticMemory;
  readonly submissions: readonly SubmissionRecord[];
  readonly comparison: "baseline" | "same-observed-runtime" | "observed-runtime-unavailable" | "observed-runtime-changed";
}
export function submissionPrompt(task: string, examples: string, initial: string, memory: RetrievedSyntheticMemory | undefined, prior: readonly SubmissionRecord[]): string {
  const parts = [task, `Public examples:\n${examples}`, `Initial module:\n${initial}`];
  if (memory !== undefined) parts.push(`Retrieved synthetic approved memory (exact revision ${memory.source.revision}):\n${memory.content}`);
  for (const submission of prior) parts.push(`Previous public submission:\n${JSON.stringify(submission.runtime.output ?? { unavailable: true })}\nObserved automated feedback:\n${JSON.stringify({ acceptance: submission.evaluation.acceptance, checks: submission.evaluation.checks, submissionFailure: submission.submissionFailure, containerIssues: submission.container?.protocolIssues })}`);
  return parts.join("\n\n");
}
async function privateJson(path: string, value: unknown) { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" }); }

export async function requireIsolationGate(spec: RuntimeSpec, options: {
  probe?: typeof probeCodexIsolation; signal?: AbortSignal; inspected?: (result: Awaited<ReturnType<typeof probeCodexIsolation>>) => Promise<void>;
} = {}): Promise<void> {
  if (options.signal?.aborted) throw new Error("Evaluation canceled before isolation probe");
  const result = await (options.probe ?? probeCodexIsolation)(spec);
  await options.inspected?.(result);
  if (!result.available || !("isolation" in result) || result.isolation.approvedShape !== true || result.runtime.process.exitCode !== 0 || result.runtime.process.failure !== undefined || result.runtime.output === undefined || result.runtime.protocolIssues.length > 0) throw new Error("Runtime isolation preflight failed; no provider dispatch is allowed");
}

function preparationFailure(spec: RuntimeSpec): RuntimeObservation {
  const now = new Date().toISOString();
  return { provider: spec.provider, configuredModel: spec.configuredModel, runtimeVersion: "unavailable", configuration: { effort: spec.effort, arguments: [], systemPromptSha256: sha256(FIXED_SYSTEM_PROMPT) }, startedAt: now, finishedAt: now,
    process: { exitCode: null, signal: null, stdout: "", stderr: "", elapsedMs: 0 }, protocolIssues: ["runtime-preparation-failed"] };
}

/** Testable round orchestration. Injected boundary results are synthetic fixtures, never provider evidence. */
export async function runAttemptSubmissions(spec: RuntimeSpec, context: {
  id: string; task: string; examples: string; initial: string; memory?: RetrievedSyntheticMemory; cases: readonly OracleCase[]; image: string; signal?: AbortSignal;
  beforeDispatch: (round: number, prompt: string) => Promise<void>;
  afterRuntime: (round: number, runtime: RuntimeObservation) => Promise<void>;
  afterSubmission: (round: number, submission: SubmissionRecord) => Promise<void>;
}, boundaries: { runtime?: typeof runRuntime; container?: typeof executeInContainer } = {}): Promise<readonly SubmissionRecord[]> {
  const submissions: SubmissionRecord[] = [];
  for (let round = 1; round <= 3; round += 1) {
    if (context.signal?.aborted) throw new Error("Evaluation canceled before dispatch");
    const prompt = submissionPrompt(context.task, context.examples, context.initial, context.memory, submissions);
    await context.beforeDispatch(round, prompt);
    if (context.signal?.aborted) throw new Error("Evaluation canceled before dispatch");
    let runtime: RuntimeObservation;
    try { runtime = await (boundaries.runtime ?? runRuntime)(spec, prompt, context.signal === undefined ? {} : { signal: context.signal }); }
    catch { runtime = preparationFailure(spec); }
    await context.afterRuntime(round, runtime);
    let container: ContainerObservation | undefined;
    const codeEligible = runtime.process.exitCode === 0 && runtime.process.failure === undefined && runtime.protocolIssues.length === 0 && runtime.output !== undefined;
    if (codeEligible && !context.signal?.aborted) {
      try { container = await (boundaries.container ?? executeInContainer)(runtime.output!.code, context.cases, { image: context.image, ...(context.signal === undefined ? {} : { signal: context.signal }) }); }
      catch { /* Unavailable container is preserved as unavailable suite, never success. */ }
    }
    const evaluation = await evaluateOracleResults(context.cases, container?.process.exitCode === 0 && container.process.failure === undefined ? container.observations : []);
    const submission: SubmissionRecord = { id: `${context.id}-${round}`, promptSha256: sha256(prompt), runtime, ...(container === undefined ? {} : { container }), evaluation,
      ...(container === undefined ? { submissionFailure: codeEligible ? "container-unavailable" as const : "provider-or-protocol" as const } : container.protocolIssues.includes("unavailable-driver-observation") ? { submissionFailure: "candidate-module-unavailable" as const } : {}) };
    submissions.push(submission); await context.afterSubmission(round, submission);
    if (evaluation.acceptance === "passed" || context.signal?.aborted || (codeEligible && container === undefined) || runtime.process.failure !== undefined || runtime.process.exitCode !== 0 || runtime.protocolIssues.includes("provider-reported-failure") || runtime.protocolIssues.some((issue) => issue.startsWith("unexpected-")) || (container !== undefined && container.process.exitCode !== 0)) break;
  }
  return submissions;
}

/** Explicit review hash gates real calls. Output directories are single-use; uncertain attempts are retained, never silently restarted. */
export async function runExperiment(plan: ExecutionPlan, options: { approvedPlanSha256: string; outputDirectory: string; fixtureDirectory?: string; signal?: AbortSignal }): Promise<readonly AttemptRecord[]> {
  if (options.approvedPlanSha256 !== executionPlanSha256(plan)) throw new Error("Execution plan requires approval of its exact hash");
  const fixture = options.fixtureDirectory ?? DEFAULT_FIXTURE_DIRECTORY;
  const current = await prepareExecutionPlan(plan.runtimes, fixture, plan.image, plan.preparedAt);
  if (executionPlanSha256(current) !== executionPlanSha256(plan)) throw new Error("Reviewed execution inputs changed");
  const directory = resolve(options.outputDirectory);
  await mkdir(directory, { mode: 0o700 });
  await privateJson(join(directory, "execution-plan.json"), plan);
  await requireIsolationGate(plan.runtimes.find((spec) => spec.provider === "openai-codex")!, {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    inspected: async (result) => privateJson(join(directory, "isolation-preflight.json"), { kind: result.kind, available: result.available,
      ...(result.available && "isolation" in result ? { isolation: result.isolation, requestSha256: result.requestSha256 } : {}), runtimeVersion: result.runtime.runtimeVersion, configuration: result.runtime.configuration,
      processSucceeded: result.runtime.process.exitCode === 0 && result.runtime.process.failure === undefined, protocolIssues: result.runtime.protocolIssues }),
  });
  const [task, examples, initial, memoryContent] = await Promise.all(["public-task.md", "public-examples.json", "initial.mjs", "synthetic-memory.md"].map((name) => readFile(join(fixture, name), "utf8")));
  const cases = await frozenOracleCases(fixture);
  const service = await createSyntheticMemoryService(memoryContent!);
  const attempts: AttemptRecord[] = [];
  try {
    for (const condition of plan.conditions) for (const spec of plan.runtimes) {
      if (options.signal?.aborted) throw new Error("Evaluation canceled before dispatch");
      const id = `${spec.provider}-${condition}`;
      const attemptDirectory = join(directory, id); await mkdir(attemptDirectory, { mode: 0o700 });
      const startedAt = new Date().toISOString();
      const memory = condition === "memory" ? await service.retrieve() : undefined;
      if (memory !== undefined) await privateJson(join(attemptDirectory, "retrieval.json"), memory);
      const submissions = await runAttemptSubmissions(spec, { id, task: task!, examples: examples!, initial: initial!, ...(memory === undefined ? {} : { memory }), cases, image: plan.image, ...(options.signal === undefined ? {} : { signal: options.signal }),
        beforeDispatch: async (round, prompt) => {
          if (executionPlanSha256(await prepareExecutionPlan(plan.runtimes, fixture, plan.image, plan.preparedAt)) !== options.approvedPlanSha256) throw new Error("Frozen execution changed during evaluation");
          await privateJson(join(attemptDirectory, `submission-${round}-dispatched.json`), { id: round, at: new Date().toISOString(), promptSha256: sha256(prompt), note: "Absent completion is uncertain; no automatic resumption." });
          await writeFile(join(attemptDirectory, `submission-${round}-prompt.txt`), prompt, { mode: 0o600, flag: "wx" });
        },
        afterRuntime: async (round, runtime) => privateJson(join(attemptDirectory, `submission-${round}-runtime.json`), runtime),
        afterSubmission: async (round, submission) => privateJson(join(attemptDirectory, `submission-${round}.json`), submission),
      });
      const baseline = attempts.find((attempt) => attempt.condition === "no-memory" && attempt.id.startsWith(spec.provider));
      const observed = submissions.map((submission) => submission.runtime.observedModel);
      const baselineObserved = baseline?.submissions.map((submission) => submission.runtime.observedModel) ?? [];
      const comparison = condition === "no-memory" ? "baseline" : observed.some((model) => model === undefined) || baselineObserved.some((model) => model === undefined) ? "observed-runtime-unavailable" : new Set([...observed, ...baselineObserved]).size === 1 ? "same-observed-runtime" : "observed-runtime-changed";
      const preparationFailure = submissions.some((submission) => submission.runtime.protocolIssues.some((issue) => issue.startsWith("unexpected-"))) || submissions.every((submission) => submission.runtime.process.failure !== undefined || submission.runtime.process.exitCode !== 0 || submission.runtime.protocolIssues.includes("provider-reported-failure"));
      const attempt: AttemptRecord = { version: 1, id, kind: preparationFailure ? "preparation-failure" : "real-provider", condition, taskVersion: plan.frozen.taskVersion, startedAt, finishedAt: new Date().toISOString(), ...(memory === undefined ? {} : { memory }), submissions, comparison };
      attempts.push(attempt); await privateJson(join(attemptDirectory, "attempt.json"), attempt);
    }
    await privateJson(join(directory, "attempts.json"), attempts);
    // Canonical synthetic source records are retained privately for selected export eligibility review.
    await privateJson(join(directory, "synthetic-memory-events.json"), service.entries);
    return attempts;
  } finally { await service.close(); }
}
