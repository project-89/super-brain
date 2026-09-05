import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, mkdir, opendir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { FoldLogEntry } from "@_89/fold";
import { createSelectedEvaluationBundle, evaluationArtifactRef, regenerateEvaluationReport, verifySelectedEvaluationBundle,
  type EvaluationAnnotations, type EvaluationArtifact, type EvaluationArtifactRef, type SelectedEvaluationAttempt, type SelectedEvaluationInput } from "@_89/fold-eval";
import { canonicalJson, sha256 } from "./hash.js";
import type { AttemptRecord, ExecutionPlan, SubmissionRecord } from "./harness.js";
import { createSyntheticMemoryApi } from "./memory.js";
import { DEFAULT_FIXTURE_DIRECTORY, evaluateOracleResults, frozenDecisionTree, frozenOracleCases, verifyFrozenFixture } from "./oracle.js";
import { readEvaluationText } from "./io.js";
import { observedCheckReport, projectObservedAttempt } from "./trajectory.js";

/** Deliberate allowlist. Raw CLI streams, stderr, runtime paths, subject receipts and unrelated evidence never enter selected files. */
export async function assembleSelectedEvaluation(options: { rawDirectory: string; annotationsDirectory: string; outputDirectory: string; fixtureDirectory?: string; reviewedBy: string; approvedReviewSha256?: string }): Promise<{ status: "review-required"; reviewSha256: string; reviewFile: string; artifactCount: number } | { status: "written"; report: unknown; bundleSha256: string }> {
  const raw = resolve(options.rawDirectory), fixture = options.fixtureDirectory ?? DEFAULT_FIXTURE_DIRECTORY;
  const plan = JSON.parse(await readEvaluationText(join(raw, "execution-plan.json"))) as ExecutionPlan;
  const frozen = await verifyFrozenFixture(fixture);
  if (canonicalJson(frozen) !== canonicalJson(plan.frozen)) throw new Error("Selected frozen fixture differs from the executed task");
  const attempts = JSON.parse(await readEvaluationText(join(raw, "attempts.json"), 64 * 1024 * 1024)) as AttemptRecord[];
  if (!Array.isArray(attempts) || attempts.length !== 4 || new Set(attempts.map(({ id }) => id)).size !== 4) throw new Error("Selected experiment requires four distinct recorded attempts");
  if (!Number.isFinite(Date.parse(plan.preparedAt)) || Date.parse(plan.preparedAt) < Date.parse(frozen.frozenAt)) throw new Error("Selected execution predates the frozen task");
  const combinations = new Set<string>();
  for (const attempt of attempts) {
    if (attempt.taskVersion !== plan.frozen.taskVersion || !["no-memory", "memory"].includes(attempt.condition) || !Array.isArray(attempt.submissions) || attempt.submissions.length < 1 || attempt.submissions.length > 3) throw new Error("Selected attempt differs from its frozen task or bounded protocol");
    if (!["real-provider", "synthetic-fixture", "preparation-failure"].includes(attempt.kind) || !Number.isFinite(Date.parse(attempt.startedAt)) || Date.parse(attempt.startedAt) < Date.parse(plan.preparedAt) || !Number.isFinite(Date.parse(attempt.finishedAt)) || Date.parse(attempt.finishedAt) < Date.parse(attempt.startedAt)) throw new Error("Selected attempt kind or timestamps are invalid");
    if ((attempt.condition === "memory") !== (attempt.memory !== undefined)) throw new Error("Selected condition does not match the injected context");
    const provider = attempt.id === `openai-codex-${attempt.condition}` ? "openai-codex" : attempt.id === `anthropic-claude-${attempt.condition}` ? "anthropic-claude" : undefined;
    if (provider === undefined) throw new Error("Selected attempt identity does not match its provider and condition");
    combinations.add(`${provider}:${attempt.condition}`);
    const configured = plan.runtimes.find((runtime) => runtime.provider === provider);
    if (configured === undefined) throw new Error("Selected provider is absent from the execution plan");
    for (const [index, submission] of (attempt.submissions as readonly SubmissionRecord[]).entries()) {
      const runtime = submission.runtime;
      if (submission.id !== `${attempt.id}-${index + 1}` || runtime.provider !== provider || runtime.configuredModel !== configured.configuredModel || runtime.configuration.effort !== configured.effort || runtime.configuration.systemPromptSha256 !== plan.systemPromptSha256 || (attempt.kind !== "preparation-failure" && configured.expectedVersion !== undefined && runtime.runtimeVersion !== configured.expectedVersion)) throw new Error("Selected round runtime or task identity differs from its execution plan");
      if (attempt.kind !== "preparation-failure" && runtime.protocolIssues.some((issue) => issue.startsWith("unexpected-"))) throw new Error("A tool-bearing runtime cannot be selected as empirical evidence");
    }
  }
  if (combinations.size !== 4) throw new Error("Selected provider/condition combinations are incomplete");
  const entries = JSON.parse(await readEvaluationText(join(raw, "synthetic-memory-events.json"))) as FoldLogEntry[];
  const cases = await frozenOracleCases(fixture);
  const artifacts: EvaluationArtifact[] = [];
  const add = (path: string, content: string, mediaType: EvaluationArtifact["mediaType"]): EvaluationArtifactRef => {
    const artifact = { path: `artifacts/${path}`, content, mediaType }; artifacts.push(artifact); return evaluationArtifactRef(artifact);
  };
  const json = (path: string, value: unknown) => add(path, `${canonicalJson(value)}\n`, "application/json");
  const frozenRefs = new Map<string, EvaluationArtifactRef>();
  for (const name of Object.keys(frozen.files).sort()) {
    const mediaType = name.endsWith(".md") ? "text/markdown" : name.endsWith(".json") ? "application/json" : "text/javascript";
    frozenRefs.set(name, add(`frozen/${name}`, await readEvaluationText(join(fixture, name)), mediaType));
  }
  const oracleVersion = frozen.suiteSha256, annotationVersion = frozen.files["annotation-rubric.md"]!;
  const tree = await frozenDecisionTree(fixture);
  const selectionId = `synthetic-eval-selection-${sha256(canonicalJson(plan)).slice(0, 20)}`;
  const service = await createSyntheticMemoryApi(entries);
  try {
    const identity = await service.client.identity();
    const refs = [...new Map(attempts.flatMap((attempt) => attempt.memory === undefined ? [] : [[`${attempt.memory.source.memoryId}:${attempt.memory.source.revision}`, { kind: "memory" as const, ...attempt.memory.source }] as const])).values()];
    const selection = await service.client.selectEvaluationSources({ selectionId, audience: "local-reviewed", redactionVersion: "synthetic-evaluation-allowlist-v1", expectedSubject: { organizationId: identity.organizationId!, workspaceId: identity.workspaceId, principalId: identity.principalId }, references: refs, reviewedReferences: refs });
    await writeFile(join(raw, `source-selection-${randomUUID()}.json`), `${JSON.stringify(selection, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    if (selection.excluded.length > 0 || selection.eligible.length !== refs.length) throw new Error("An injected memory revision is unavailable, stale or unauthorized for selected export");
    for (const attempt of attempts) if (attempt.memory !== undefined) {
      const memory = attempt.memory;
      const selected = selection.eligible.find((item) => item.reference.kind === "memory" && item.reference.memoryId === memory.source.memoryId && item.reference.revision === memory.source.revision);
      if ((selected?.snapshot as Record<string, unknown> | undefined)?.content !== memory.content || sha256(memory.content) !== memory.contentSha256 || memory.provenance.recallId !== memory.recallId || memory.provenance.subject.organizationId !== identity.organizationId || memory.provenance.subject.workspaceId !== identity.workspaceId || memory.provenance.subject.principalId !== identity.principalId || !memory.provenance.items.some((item) => item.memoryId === memory.source.memoryId && item.memoryRevision === memory.source.revision)) throw new Error("Injected memory bytes do not match the selected canonical revision and recorded retrieval");
    }
    const sources: SelectedEvaluationInput["sources"] = selection.eligible.map((item) => {
      const snapshot = item.snapshot as Record<string, unknown>;
      return { reference: item.reference, eligibility: "current-authorized", selectionId,
        artifact: json(`sources/memory-${item.reference.kind === "memory" ? item.reference.memoryId : item.reference.eventId}.json`, { kind: "synthetic-canonical-memory", memoryId: snapshot.memoryId, revision: snapshot.revision, summary: snapshot.summary, content: snapshot.content }) };
    });
    const supportingArtifacts = [...frozenRefs.entries()].filter(([name]) => !["public-task.md", "initial.mjs", "hidden-cases.json", "decision-tree.json", "annotation-rubric.md"].includes(name)).map(([, ref]) => ref);
    const selectedAttempts: SelectedEvaluationAttempt[] = [];
    for (const attempt of attempts) {
      if (!/^(openai-codex|anthropic-claude)-(no-memory|memory)$/.test(attempt.id)) throw new Error("Unexpected attempt identity");
      const final = attempt.submissions.at(-1);
      const configured = plan.runtimes.find((runtime) => runtime.provider === final?.runtime.provider);
      const configuration = json(`${attempt.id}/configuration.json`, { version: 1, provider: configured?.provider, configuredModel: configured?.configuredModel, effort: configured?.effort, expectedRuntimeVersion: configured?.expectedVersion,
        runtimeVersion: final?.runtime.runtimeVersion, configuredCatalogSha256: configured?.codexCatalog === undefined ? undefined : sha256(canonicalJson(configured.codexCatalog)), systemPromptSha256: plan.systemPromptSha256,
        responseSchemaSha256: plan.responseSchemaSha256, containerImage: plan.image, driverSha256: plan.driverSha256, permissionMode: "isolated-noninteractive", comparison: attempt.comparison });
      const annotations = attempt.kind === "preparation-failure" ? json(`${attempt.id}/annotations.json`, { version: 1, annotationVersion, annotations: [] }) : add(`${attempt.id}/annotations.json`, await readEvaluationText(join(options.annotationsDirectory, `${attempt.id}.json`)), "application/json");
      for (const submission of attempt.submissions) {
        const actual = submission.container;
        if (actual !== undefined && (submission.runtime.output === undefined || submission.runtime.process.exitCode !== 0 || submission.runtime.process.failure !== undefined || submission.runtime.protocolIssues.length !== 0)) throw new Error("Selected container has no eligible provider submission");
        if (actual !== undefined && (actual.codeSha256 !== sha256(submission.runtime.output?.code ?? "") || actual.driverSha256 !== plan.driverSha256 || actual.image !== plan.image)) throw new Error("Selected execution artifacts have mismatched code, driver or image identities");
        const replayed = await evaluateOracleResults(cases, actual?.process.exitCode === 0 && actual.process.failure === undefined ? actual.observations : []);
        if (canonicalJson(replayed) !== canonicalJson(submission.evaluation)) throw new Error("Selected acceptance result differs from its retained observations");
        if (actual !== undefined) supportingArtifacts.push(json(`${attempt.id}/${submission.id}-observations.json`, { image: actual.image, driverSha256: actual.driverSha256, codeSha256: actual.codeSha256, exitCode: actual.process.exitCode, failure: actual.process.failure, elapsedMs: actual.process.elapsedMs, observations: actual.observations, protocolIssues: actual.protocolIssues }));
      }
      if (attempt.kind === "preparation-failure") supportingArtifacts.push(json(`${attempt.id}/preparation.json`, { kind: "preparation-failure", rounds: attempt.submissions.map((submission) => ({ id: submission.id, protocolIssues: submission.runtime.protocolIssues, exitCode: submission.runtime.process.exitCode, failure: submission.runtime.process.failure, elapsedMs: submission.runtime.process.elapsedMs })) }));
      const submissions: SelectedEvaluationAttempt["submissions"] = attempt.kind === "preparation-failure" ? [] : attempt.submissions.map((submission) => {
        const output = json(`${attempt.id}/${submission.id}-output.json`, submission.runtime.output ?? { availability: "unavailable", reportedOutcome: submission.runtime.reportedOutcome, protocolIssues: submission.runtime.protocolIssues });
        const code = submission.runtime.output === undefined ? undefined : add(`${attempt.id}/${submission.id}.mjs`, submission.runtime.output.code, "text/javascript");
        const checks = json(`${attempt.id}/${submission.id}-checks.json`, observedCheckReport(submission, oracleVersion));
        const usage = submission.runtime.usage === undefined ? undefined : json(`${attempt.id}/${submission.id}-usage.json`, { source: "runtime-reported", interpretation: "unknown", values: submission.runtime.usage });
        const runtime = submission.runtime;
        const roundConfiguration = json(`${attempt.id}/${submission.id}-configuration.json`, { version: 1, provider: runtime.provider, configuredModel: runtime.configuredModel, effort: runtime.configuration.effort,
          expectedRuntimeVersion: configured?.expectedVersion, runtimeVersion: runtime.runtimeVersion, configuredCatalogSha256: configured?.codexCatalog === undefined ? undefined : sha256(canonicalJson(configured.codexCatalog)),
          systemPromptSha256: plan.systemPromptSha256, responseSchemaSha256: plan.responseSchemaSha256, containerImage: plan.image, driverSha256: plan.driverSha256, permissionMode: "isolated-noninteractive" });
        return { id: submission.id, runtime: { provider: runtime.provider, configuredModel: runtime.configuredModel, ...(runtime.observedModel === undefined ? {} : { observedModel: runtime.observedModel }), runtimeVersion: runtime.runtimeVersion, configuration: roundConfiguration }, output, ...(code === undefined ? {} : { code }), checks, elapsedMs: submission.runtime.process.elapsedMs + (submission.container?.process.elapsedMs ?? 0), ...(usage === undefined ? {} : { usage }) };
      });
      if (attempt.kind !== "preparation-failure") {
        const annotationContent = artifacts.find(({ path }) => path === annotations.path)!.content;
        const projection = await projectObservedAttempt(attempt, plan, tree, JSON.parse(annotationContent) as EvaluationAnnotations);
        // Shared canonical replay is retained privately; the selected artifact exposes only the observed task/steps and projection.
        await writeFile(join(raw, `trajectory-${attempt.id}-${sha256(canonicalJson(projection.events))}.json`), `${canonicalJson(projection.events)}\n`, { mode: 0o600, flag: "wx" }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
        supportingArtifacts.push(json(`${attempt.id}/trajectory-projection.json`, { kind: "synthetic-harness-observed-projection", authority: "automated-observations", input: projection.input,
          projection: { id: projection.projected.id, taskId: projection.projected.taskId, model: projection.projected.model, outcome: projection.projected.outcome, steps: projection.projected.steps, manifest: projection.projected.manifest },
          analysis: { projectionBasis: projection.analysis.projectionBasis, acceptanceSummary: projection.analysis.acceptanceSummary } }));
      }
      const memory = attempt.memory === undefined || attempt.kind === "preparation-failure" ? undefined : { source: attempt.memory.source, recallId: attempt.memory.recallId, injected: add(`${attempt.id}/injected-memory.txt`, attempt.memory.content, "text/plain") };
      selectedAttempts.push({ id: attempt.id, kind: attempt.kind, condition: attempt.condition, taskVersion: frozen.taskVersion, inputStateId: frozen.files["initial.mjs"]!, oracleVersion, treeVersion: frozen.files["decision-tree.json"]!, annotationVersion,
        runtime: { provider: final?.runtime.provider ?? "unavailable", ...(configured === undefined ? {} : { configuredModel: configured.configuredModel }), ...(final?.runtime.observedModel === undefined ? {} : { observedModel: final.runtime.observedModel }), runtimeVersion: final?.runtime.runtimeVersion ?? "unavailable", configuration },
        startedAt: attempt.startedAt, finishedAt: attempt.finishedAt, submissions, annotations, ...(memory === undefined ? {} : { memory }), ...(final?.runtime.reportedOutcome === undefined ? {} : { reportedOutcome: final.runtime.reportedOutcome }) });
    }
    const input: SelectedEvaluationInput = { frozen: { id: `event-delivery-eval-${frozen.suiteSha256.slice(0, 20)}`, taskId: frozen.taskId, taskVersion: frozen.taskVersion, inputStateId: frozen.files["initial.mjs"]!, oracleVersion, treeVersion: frozen.files["decision-tree.json"]!, annotationVersion,
      frozenAt: plan.frozen.frozenAt, task: frozenRefs.get("public-task.md")!, input: frozenRefs.get("initial.mjs")!, oracle: frozenRefs.get("hidden-cases.json")!, tree: frozenRefs.get("decision-tree.json")!, rubric: frozenRefs.get("annotation-rubric.md")!, supportingArtifacts }, attempts: selectedAttempts, artifacts, sources,
      exclusions: [{ label: "raw-runtime-streams-and-private-selection-receipt", reason: "redacted" }], review: { selectionId, audience: "local-reviewed", redactionVersion: "synthetic-evaluation-allowlist-v1", reviewedArtifactPaths: artifacts.map((artifact) => artifact.path), reviewedBy: options.reviewedBy, reviewedAt: new Date().toISOString() } };
    const bundle = createSelectedEvaluationBundle(input);
    verifySelectedEvaluationBundle(bundle.files);
    if (canonicalJson(regenerateEvaluationReport(bundle.files)) !== canonicalJson(bundle.report)) throw new Error("Selected report failed deterministic regeneration");
    const { reviewedAt: _reviewedAt, ...reviewContent } = input.review;
    const reviewSha256 = sha256(canonicalJson({ ...input, review: reviewContent }));
    if (options.approvedReviewSha256 === undefined) {
      const reviewFile = join(raw, `selected-review-${reviewSha256}.json`);
      await writeFile(reviewFile, `${JSON.stringify({ status: "pending-local-review", reviewSha256, input: { ...input, review: reviewContent } }, null, 2)}\n`, { mode: 0o600, flag: "wx" }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
      return { status: "review-required", reviewSha256, reviewFile, artifactCount: artifacts.length };
    }
    if (options.approvedReviewSha256 !== reviewSha256) throw new Error("Selected bytes changed or lack approval of this exact preview hash");
    const destination = resolve(options.outputDirectory); await mkdir(destination, { mode: 0o700 });
    for (const [path, content] of Object.entries(bundle.files)) { const target = join(destination, path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, content, { mode: 0o600, flag: "wx" }); }
    return { status: "written", report: bundle.report, bundleSha256: bundle.files["bundle.sha256"]! };
  } finally { await service.close(); }
}

/** Read only bounded, stable regular files under a stable, non-symlink directory hierarchy. */
export async function readEvaluationDirectory(directory: string): Promise<Record<string, string>> {
  const requested = resolve(directory);
  if (!(await lstat(requested)).isDirectory()) throw new Error("Selected bundle root is not a regular directory");
  const root = await realpath(requested), files: Record<string, string> = {};
  let count = 0, totalBytes = 0, directories = 0;
  const validate = async (ancestors: readonly { path: string; stat: Stats }[]) => {
    for (const ancestor of ancestors) {
      const current = await lstat(ancestor.path);
      if (!current.isDirectory() || current.dev !== ancestor.stat.dev || current.ino !== ancestor.stat.ino || current.ctimeMs !== ancestor.stat.ctimeMs || await realpath(ancestor.path) !== ancestor.path) throw new Error("Selected bundle directory changed while reading");
    }
  };
  const walk = async (relative: string, parents: readonly { path: string; stat: Stats }[]) => {
    directories += 1; if (directories > 1000 || relative.split("/").length > 12) throw new Error("Selected bundle directory bounds exceeded");
    const absolute = join(root, relative), stat = await lstat(absolute);
    if (!stat.isDirectory()) throw new Error("Selected bundle contains unsupported filesystem entries");
    const ancestors = [...parents, { path: absolute, stat }]; await validate(ancestors);
    const handle = await opendir(absolute); let entries = 0;
    for await (const entry of handle) {
      entries += 1; if (entries > 1000) throw new Error("Selected bundle directory has too many entries");
      await validate(ancestors);
      const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(path, ancestors);
      else if (entry.isFile()) {
        count += 1; if (count > 1000) throw new Error("Selected bundle has too many files");
        const target = join(root, path), expected = await lstat(target);
        const content = await readEvaluationText(target, 2 * 1024 * 1024, { expected, validate: () => validate(ancestors) });
        totalBytes += Buffer.byteLength(content); if (totalBytes > 16 * 1024 * 1024) throw new Error("Selected bundle exceeds byte limit");
        files[path] = content;
      } else throw new Error("Selected bundle contains unsupported filesystem entries");
    }
    await validate(ancestors);
  };
  await walk("", []); return files;
}
export async function verifyEvaluationDirectory(directory: string) {
  const files = await readEvaluationDirectory(directory); verifySelectedEvaluationBundle(files); return regenerateEvaluationReport(files);
}
