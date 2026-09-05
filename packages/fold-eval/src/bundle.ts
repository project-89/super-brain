import { createHash } from "node:crypto";
import type { EvaluationArtifact, EvaluationArtifactRef, EvaluationBundleManifest, EvaluationChecks, EvaluationReport, EvaluationRuntime, FrozenEvaluation, SelectedEvaluationAttempt, SelectedEvaluationBundle, SelectedEvaluationInput } from "./bundle-types.js";
export * from "./bundle-types.js";

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 16 * 1024 * 1024;
const GENERATED = ["manifest.json", "report.json", "report.md", "dictionary.json", "bundle.sha256"];
const MEDIA_TYPES = ["application/json", "text/plain", "text/javascript", "text/markdown"];
const dictionary = {
  version: 1,
  artifact: "Explicitly selected, reviewed UTF-8 bytes. Hashes identify bytes; they do not attest authorship or publication consent.",
  frozen: "Task, input state, oracle, independent tree and annotation rubric fixed before each real provider attempt.",
  runtime: "Configured and observed identifiers are distinct. Absent observations stay absent; configuration bytes are sanitized.",
  acceptance: "Final submitted code's automated checks. No completed nonempty suite means unavailable and confidence null. Available confidence is a mechanical 0/1 suite aggregation, not calibrated probability or human approval.",
  effort: "Observed submission count and elapsed time. Missing durations stay unavailable; usage artifacts retain their source interpretation.",
  memoryExposure: "Prompt-injected proves retrieval and injection of the cited revision, not the model's internal use of it.",
  comparisonGroup: "Exact task/input/condition and per-round provider/configured model/observed model/runtime/configuration hashes. Mixed runtimes remain explicit; unavailable observed identity is not pooled as equivalent attempts.",
  sources: "Current authorized revision at the separate SDK/API selection boundary. Private authenticated selection receipts remain outside this bundle. Offline bundles cannot discover later revocation.",
  annotations: "Selected annotation bytes cite observable evidence, preserving structural versus semantic interpretation, ambiguity and unmapped steps.",
  origin: "Harness artifacts are directly selected sanitized observations. They are not represented as canonical application events unless explicitly listed as eligible event sources.",
  review: "Explicit local redaction review, not external publication permission. Automatic sensitive-pattern rejection supplements, and cannot replace, that review.",
};

export class EvaluationBundleError extends Error { override readonly name = "EvaluationBundleError"; }
function fail(message: string): never { throw new EvaluationBundleError(message); }
function object(value: unknown, label: string, allowed: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${label} contains unsupported field ${key}`);
  return value as Record<string, unknown>;
}
function string(value: unknown, label: string, max = 300): asserts value is string {
  if (typeof value !== "string" || value.trim() === "" || value.length > max) fail(`${label} must be a bounded nonempty string`);
}
function integer(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail(`${label} must be a nonnegative safe integer`);
}
function array(value: unknown, label: string, max = 1000): asserts value is unknown[] {
  if (!Array.isArray(value) || value.length > max) fail(`${label} must be an array of at most ${max} items`);
}
function date(value: unknown, label: string): asserts value is string {
  string(value, label);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) fail(`${label} must be a UTC timestamp`);
}
function path(value: unknown): asserts value is string {
  string(value, "artifact path", 250);
  if (!/^artifacts\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/.test(value)) fail("artifact path must be a safe logical path under artifacts/");
}
function ref(value: unknown): asserts value is EvaluationArtifactRef {
  const record = object(value, "artifact reference", ["path", "sha256"]);
  path(record.path);
  if (typeof record.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.sha256)) fail("artifact reference requires SHA-256");
}
function runtime(value: EvaluationRuntime): void {
  object(value, "runtime", ["provider", "configuredModel", "observedModel", "runtimeVersion", "configuration"]);
  for (const key of ["provider", "runtimeVersion"] as const) string(value[key], `runtime.${key}`);
  for (const key of ["configuredModel", "observedModel"] as const) if (value[key] !== undefined) string(value[key], `runtime.${key}`);
  ref(value.configuration);
}
function runtimeIdentity(value: EvaluationRuntime): unknown {
  const { configuration, ...identity } = value;
  return { ...identity, configurationSha256: configuration.sha256 };
}
function sensitive(value: string): void {
  if (/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\bBearer\s+[\w.+/=-]{8,}|\b(?:sk-ant-|sk-proj-|gh[pousr]_)[\w-]{8,}|(?:\/Users\/|\/home\/|\/private\/var\/folders\/|[A-Z]:\\Users\\)|"(?:authorization|apiKey|api_key|password|token|secret|privateKey|credentials?|cookies?|set-cookie|access_token|refresh_token|principalId|organizationId|workspaceId|headers|environment|env)"\s*:/i.test(value)) fail("selected bytes contain a prohibited sensitive field or private path; redact and review again");
}
/** Strict JSON canonicalization: reject values JSON would silently drop/coerce. */
export function canonicalEvaluationJson(value: unknown): string {
  const seen = new Set<object>();
  const walk = (item: unknown, depth: number): unknown => {
    if (depth > 80) fail("JSON nesting limit exceeded");
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (typeof item !== "object" || item === undefined) fail("evaluation data must contain only finite JSON values");
    if (seen.has(item)) fail("evaluation data must not contain cycles");
    seen.add(item);
    const descriptors = Object.getOwnPropertyDescriptors(item);
    for (const key of Reflect.ownKeys(item)) {
      if (Array.isArray(item) && key === "length") continue;
      const descriptor = typeof key === "string" ? descriptors[key] : undefined;
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) fail("evaluation data must not contain symbols, accessors or hidden properties");
    }
    let result: unknown;
    if (Array.isArray(item)) {
      if (Object.keys(item).length !== item.length) fail("evaluation data must not contain sparse arrays or array properties");
      const out: unknown[] = [];
      for (let i = 0; i < item.length; i++) {
        if (descriptors[String(i)] === undefined) fail("evaluation data must not contain sparse arrays");
        out.push(walk(descriptors[String(i)]!.value, depth + 1));
      }
      result = out;
    }
    else {
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) fail("evaluation data must contain plain JSON objects");
      const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const key of Object.keys(item).sort()) out[key] = walk(descriptors[key]!.value, depth + 1);
      result = out;
    }
    seen.delete(item);
    return result;
  };
  return `${JSON.stringify(walk(value, 0))}\n`;
}
export function evaluationSha256(content: string): string { return createHash("sha256").update(content, "utf8").digest("hex"); }
export function evaluationArtifactRef(artifact: Pick<EvaluationArtifact, "path" | "content">): EvaluationArtifactRef {
  path(artifact.path);
  return { path: artifact.path, sha256: evaluationSha256(artifact.content) };
}
function parseJson(content: string, label: string): unknown {
  try { return JSON.parse(content) as unknown; } catch { return fail(`${label} is not valid JSON`); }
}
function frozen(value: FrozenEvaluation): void {
  object(value, "frozen evaluation", ["id", "taskId", "taskVersion", "inputStateId", "oracleVersion", "treeVersion", "annotationVersion", "frozenAt", "task", "input", "oracle", "tree", "rubric", "supportingArtifacts"]);
  for (const key of ["id", "taskId", "taskVersion", "inputStateId", "oracleVersion", "treeVersion", "annotationVersion"] as const) string(value[key], `frozen.${key}`);
  date(value.frozenAt, "frozenAt");
  for (const key of ["task", "input", "oracle", "tree", "rubric"] as const) ref(value[key]);
  if (value.supportingArtifacts !== undefined) { array(value.supportingArtifacts, "supporting artifacts", 100); value.supportingArtifacts.forEach(ref); }
}
function sourceReference(value: unknown): string {
  const record = object(value, "source reference", ["kind", "memoryId", "revision", "eventId"]);
  if (record.kind === "memory") {
    if (record.eventId !== undefined) fail("memory reference cannot contain an event ID");
    string(record.memoryId, "memoryId"); integer(record.revision, "revision");
  } else if (record.kind === "event") {
    if (record.memoryId !== undefined || record.revision !== undefined) fail("event reference cannot contain a memory revision");
    string(record.eventId, "eventId");
  } else fail("unsupported source reference");
  return canonicalEvaluationJson(record);
}
function oracleCaseIds(content: string, suiteVersion: string): readonly string[] {
  const value = parseJson(content, "frozen oracle");
  let ids: unknown;
  if (Array.isArray(value)) ids = value.map((item: unknown) => {
    if (item === null || typeof item !== "object" || !("id" in item)) fail("frozen oracle case requires an ID");
    return item.id;
  });
  else {
    const manifest = object(value, "frozen oracle", ["version", "suiteVersion", "checkIds"]);
    if (manifest.version !== 1 || manifest.suiteVersion !== suiteVersion) fail("frozen oracle version conflict");
    ids = manifest.checkIds;
  }
  array(ids, "frozen check IDs", 1000);
  for (const id of ids) string(id, "frozen check ID");
  if (ids.length === 0 || new Set(ids).size !== ids.length) fail("frozen oracle requires distinct nonempty check IDs");
  return ids as string[];
}
function checksFrom(content: string, suiteVersion: string, expectedIds: readonly string[], codeSha256?: string): EvaluationChecks {
  const value = object(parseJson(content, "checks"), "checks", ["version", "suiteVersion", "codeSha256", "availability", "checks", "reason"]);
  if (value.version !== 1 || value.suiteVersion !== suiteVersion) fail("oracle version conflict");
  if (value.codeSha256 !== codeSha256) fail("checks do not match the exact submitted code hash");
  if (value.availability !== "completed" && value.availability !== "unavailable") fail("invalid check availability");
  if (value.reason !== undefined) string(value.reason, "check reason", 4000);
  array(value.checks, "checks", 1000);
  const ids = new Set<string>();
  for (const item of value.checks) {
    const check = object(item, "check", ["id", "status", "detail"]);
    string(check.id, "check ID");
    if (!expectedIds.includes(check.id)) fail("check does not belong to the frozen oracle");
    if (ids.has(check.id)) fail("duplicate check ID"); ids.add(check.id);
    if (!["passed", "failed", "unavailable"].includes(check.status as string)) fail("invalid check status");
    if (check.detail !== undefined) string(check.detail, "check detail", 4000);
  }
  const checks = [...value.checks, ...expectedIds.filter((id) => !ids.has(id)).map((id) => ({ id, status: "unavailable" as const, detail: "Missing frozen check observation" }))];
  return { ...value, checks } as unknown as EvaluationChecks;
}

function annotationSummary(attempt: SelectedEvaluationAttempt, frozen: FrozenEvaluation, artifacts: Map<string, EvaluationArtifact>): EvaluationReport["attempts"][number]["annotations"] {
  const tree = parseJson(artifacts.get(frozen.tree.path)!.content, "frozen tree") as { nodes?: unknown };
  if (tree === null || typeof tree !== "object") fail("frozen tree must contain nodes");
  array(tree.nodes, "frozen tree nodes");
  const nodes = new Set<string>();
  for (const item of tree.nodes) {
    if (item === null || typeof item !== "object" || !("id" in item)) fail("frozen tree node requires an ID");
    string(item.id, "tree node ID"); if (nodes.has(item.id)) fail("duplicate tree node ID"); nodes.add(item.id);
  }
  const value = object(parseJson(artifacts.get(attempt.annotations.path)!.content, "annotations"), "annotations", ["version", "annotationVersion", "annotations"]);
  if (value.version !== 1 || value.annotationVersion !== attempt.annotationVersion) fail("annotation version conflict");
  array(value.annotations, "annotations", 1000);
  const steps = new Set(attempt.submissions.flatMap((submission) => [submission.id, `${submission.id}:checks`]));
  if (steps.size !== attempt.submissions.length * 2) fail("submission IDs collide with observed check step IDs");
  const annotated = new Set<string>();
  const summary = { mapped: 0, ambiguous: 0, unmapped: 0, missing: 0, structural: 0, semantic: 0 };
  for (const entry of value.annotations) {
    const annotation = object(entry, "annotation", ["stepId", "assignment", "evidence", "note"]);
    string(annotation.stepId, "annotation step ID");
    if (!steps.has(annotation.stepId) || annotated.has(annotation.stepId)) fail("annotation must identify one distinct observed submission or check step");
    const owner = attempt.submissions.find((submission) => annotation.stepId === submission.id || annotation.stepId === `${submission.id}:checks`)!;
    annotated.add(annotation.stepId);
    if (annotation.note !== undefined) string(annotation.note, "annotation note", 4000);
    const assignment = object(annotation.assignment, "assignment", ["kind", "nodeId", "candidates", "reason", "method"]);
    const method = object(assignment.method, "annotation method", ["kind", "id", "basis"]);
    if (method.kind !== "manual" || method.id !== "frozen-observable-rubric-v1" || !["structural", "semantic"].includes(method.basis as string)) fail("annotation requires the frozen observable rubric method");
    summary[method.basis as "structural" | "semantic"]++;
    if (assignment.kind === "mapped") {
      if (assignment.candidates !== undefined || assignment.reason !== undefined) fail("mapped assignment contains unsupported fields");
      string(assignment.nodeId, "mapped node"); if (!nodes.has(assignment.nodeId)) fail("mapped node is outside the frozen tree"); summary.mapped++;
    } else if (assignment.kind === "ambiguous") {
      if (assignment.nodeId !== undefined) fail("ambiguous assignment cannot declare one node");
      array(assignment.candidates, "ambiguous candidates", 100); string(assignment.reason, "ambiguous reason", 4000);
      if (assignment.candidates.length < 2 || new Set(assignment.candidates).size !== assignment.candidates.length || assignment.candidates.some((id) => typeof id !== "string" || !nodes.has(id))) fail("ambiguous candidates require distinct frozen tree nodes"); summary.ambiguous++;
    } else if (assignment.kind === "unmapped") {
      if (assignment.nodeId !== undefined || assignment.candidates !== undefined) fail("unmapped assignment cannot declare nodes");
      string(assignment.reason, "unmapped reason", 4000); summary.unmapped++;
    } else fail("invalid annotation assignment");
    array(annotation.evidence, "annotation evidence", 100);
    if (annotation.evidence.length === 0) fail("annotation requires observable evidence");
    let code = false, observedCheck = false, observedSubmission = false;
    for (const item of annotation.evidence) {
      const evidence = object(item, "annotation evidence", ["kind", "artifactSha256", "startLine", "endLine", "caseId", "roundId"]);
      if (evidence.kind === "code-span") {
        if (evidence.caseId !== undefined || evidence.roundId !== undefined) fail("code-span contains unsupported fields");
        const submission = owner.code?.sha256 === evidence.artifactSha256 ? owner : undefined;
        if (submission?.code === undefined) fail("annotation code hash does not match its observed round");
        integer(evidence.startLine, "start line"); integer(evidence.endLine, "end line");
        const lines = artifacts.get(submission.code.path)!.content.split("\n").length;
        if (evidence.startLine < 1 || evidence.endLine < evidence.startLine || evidence.endLine > lines) fail("annotation code span is outside selected code"); code = true;
      } else if (evidence.kind === "check" || evidence.kind === "submission") {
        if (evidence.startLine !== undefined || evidence.endLine !== undefined) fail("check/submission evidence cannot contain code spans");
        const submission = owner.id === evidence.roundId ? owner : undefined;
        if (submission === undefined) fail("annotation evidence does not belong to its observed round");
        if (evidence.kind === "submission") {
          if (evidence.caseId !== undefined || evidence.artifactSha256 !== submission.output.sha256) fail("annotation output hash does not match observed submission");
          observedSubmission = true;
        } else {
          if (evidence.artifactSha256 !== undefined) fail("check evidence cannot contain an output hash");
          const actual = parseJson(artifacts.get(submission.checks.path)!.content, "checks") as EvaluationChecks;
          const check = actual.checks.find(({ id }) => id === evidence.caseId);
          if (check === undefined) fail("annotation cites an unobserved check");
          if (check.status !== "unavailable") observedCheck = true;
        }
      } else fail("invalid annotation evidence kind");
    }
    if (assignment.kind !== "unmapped" && !code && !observedCheck && !observedSubmission) fail("unavailable checks cannot establish a mapped program behavior");
    if (method.basis === "semantic" && (!code || !observedCheck)) fail("semantic annotation requires a concrete code span and an observed check");
  }
  summary.missing = steps.size - annotated.size;
  return summary;
}

function validateInput(input: SelectedEvaluationInput): Map<string, EvaluationArtifact> {
  object(input, "selected evaluation", ["frozen", "attempts", "artifacts", "sources", "exclusions", "review"]);
  frozen(input.frozen);
  array(input.attempts, "attempts", 100); array(input.artifacts, "artifacts"); array(input.sources, "sources", 100); array(input.exclusions, "exclusions");
  object(input.review, "review", ["selectionId", "audience", "redactionVersion", "reviewedArtifactPaths", "reviewedBy", "reviewedAt"]);
  for (const key of ["selectionId", "redactionVersion", "reviewedBy"] as const) string(input.review[key], `review.${key}`);
  if (input.review.audience !== "local-reviewed") fail("only local-reviewed audience is supported; external publication requires a separate process");
  date(input.review.reviewedAt, "reviewedAt"); array(input.review.reviewedArtifactPaths, "reviewed paths");
  const reviewed = new Set(input.review.reviewedArtifactPaths);
  if (reviewed.size !== input.review.reviewedArtifactPaths.length) fail("duplicate reviewed path");
  const artifacts = new Map<string, EvaluationArtifact>();
  let total = 0;
  for (const artifact of input.artifacts) {
    object(artifact, "artifact", ["path", "mediaType", "content"]); path(artifact.path);
    if (!MEDIA_TYPES.includes(artifact.mediaType)) fail("unsupported artifact media type");
    if (typeof artifact.content !== "string") fail("artifact content must be UTF-8 text");
    if (Buffer.from(artifact.content, "utf8").toString("utf8") !== artifact.content) fail("artifact content contains invalid Unicode");
    const bytes = Buffer.byteLength(artifact.content);
    if (bytes > MAX_FILE_BYTES || (total += bytes) > MAX_BUNDLE_BYTES) fail("selected artifact byte limit exceeded");
    if (artifacts.has(artifact.path)) fail("duplicate artifact path");
    if (!reviewed.has(artifact.path)) fail("unreviewed artifact excluded: explicit review is required");
    if (artifact.mediaType === "application/json") sensitive(canonicalEvaluationJson(parseJson(artifact.content, artifact.path)));
    sensitive(artifact.content); artifacts.set(artifact.path, artifact);
  }
  if (reviewed.size !== artifacts.size) fail("review contains a missing artifact");
  const used = new Set<string>();
  const use = (reference: EvaluationArtifactRef): EvaluationArtifact => {
    ref(reference);
    const artifact = artifacts.get(reference.path);
    if (!artifact) fail(`missing selected artifact ${reference.path}`);
    if (evaluationSha256(artifact.content) !== reference.sha256) fail(`artifact hash mismatch ${reference.path}`);
    used.add(reference.path); return artifact;
  };
  for (const key of ["task", "input", "oracle", "tree", "rubric"] as const) use(input.frozen[key]);
  for (const reference of input.frozen.supportingArtifacts ?? []) use(reference);
  const oracle = use(input.frozen.oracle);
  if (oracle.mediaType !== "application/json") fail("frozen oracle requires JSON case IDs");
  const expectedIds = oracleCaseIds(oracle.content, input.frozen.oracleVersion);
  const sourceKeys = new Set<string>();
  for (const source of input.sources) {
    object(source, "source", ["reference", "artifact", "eligibility", "selectionId"]);
    const key = sourceReference(source.reference);
    if (sourceKeys.has(key)) fail("duplicate selected source"); sourceKeys.add(key);
    if (source.eligibility !== "current-authorized" || source.selectionId !== input.review.selectionId) fail("source lacks current authorized selection");
    use(source.artifact);
  }
  for (const exclusion of input.exclusions) {
    object(exclusion, "exclusion", ["label", "reason"]); string(exclusion.label, "exclusion label");
    if (!["unavailable-or-denied", "stale-revision", "needs-review", "unreviewed", "redacted", "unsupported-source", "provider-unavailable"].includes(exclusion.reason)) fail("unsupported exclusion reason");
  }
  const ids = new Set<string>();
  for (const attempt of input.attempts) {
    object(attempt, "attempt", ["id", "kind", "condition", "taskVersion", "inputStateId", "oracleVersion", "treeVersion", "annotationVersion", "runtime", "startedAt", "finishedAt", "submissions", "annotations", "memory", "reportedOutcome"]);
    string(attempt.id, "attempt ID"); if (ids.has(attempt.id)) fail("duplicate attempt ID"); ids.add(attempt.id);
    if (!["real-provider", "synthetic-fixture", "preparation-failure"].includes(attempt.kind)) fail("invalid attempt kind");
    if (!["no-memory", "memory"].includes(attempt.condition)) fail("invalid attempt condition");
    for (const key of ["taskVersion", "inputStateId", "oracleVersion", "treeVersion", "annotationVersion"] as const) if (attempt[key] !== input.frozen[key]) fail(`${key} version conflict`);
    date(attempt.startedAt, "attempt startedAt");
    if (Date.parse(attempt.startedAt) < Date.parse(input.frozen.frozenAt)) fail("attempt predates frozen experiment");
    if (attempt.finishedAt !== undefined) { date(attempt.finishedAt, "finishedAt"); if (Date.parse(attempt.finishedAt) < Date.parse(attempt.startedAt)) fail("attempt finishes before it starts"); }
    if (Date.parse(input.review.reviewedAt) < Date.parse(attempt.finishedAt ?? attempt.startedAt)) fail("review predates selected attempt");
    runtime(attempt.runtime);
    use(attempt.runtime.configuration); use(attempt.annotations);
    if (attempt.reportedOutcome !== undefined) string(attempt.reportedOutcome, "reported outcome", 1000);
    array(attempt.submissions, "submissions", 3);
    if (attempt.kind === "real-provider" && attempt.submissions.length === 0) fail("real provider attempt requires an observed submission");
    if (attempt.kind === "preparation-failure" && attempt.submissions.length !== 0) fail("preparation failure cannot contain submissions");
    const submissionIds = new Set<string>();
    for (const submission of attempt.submissions) {
      object(submission, "submission", ["id", "output", "code", "checks", "elapsedMs", "usage", "runtime"]);
      string(submission.id, "submission ID"); if (submissionIds.has(submission.id)) fail("duplicate submission ID"); submissionIds.add(submission.id);
      use(submission.output); if (submission.code !== undefined) use(submission.code);
      const checks = use(submission.checks); if (checks.mediaType !== "application/json") fail("checks require JSON media type");
      checksFrom(checks.content, attempt.oracleVersion, expectedIds, submission.code?.sha256);
      if (submission.elapsedMs !== undefined && (!Number.isFinite(submission.elapsedMs) || submission.elapsedMs < 0)) fail("invalid elapsed duration");
      if (submission.usage !== undefined) use(submission.usage);
      if (attempt.kind === "real-provider" && submission.runtime === undefined) fail("real provider submission requires per-round runtime observations");
      if (submission.runtime !== undefined) { runtime(submission.runtime); use(submission.runtime.configuration); }
    }
    if (attempt.condition === "no-memory" && attempt.memory !== undefined) fail("no-memory attempt cannot claim injected memory");
    if (attempt.kind !== "preparation-failure" && attempt.condition === "memory" && attempt.memory === undefined) fail("memory condition requires exact retrieved and injected source");
    if (attempt.memory !== undefined) {
      object(attempt.memory, "injected memory", ["source", "recallId", "injected"]);
      object(attempt.memory.source, "memory revision", ["memoryId", "revision"]);
      string(attempt.memory.recallId, "recall ID");
      const key = sourceReference({ kind: "memory", ...attempt.memory.source });
      if (!sourceKeys.has(key)) fail("injected memory is not an eligible exact selected revision");
      use(attempt.memory.injected);
    }
  }
  if (used.size !== artifacts.size) fail("unreferenced artifact is outside the explicit selection");
  for (const attempt of input.attempts) annotationSummary(attempt, input.frozen, artifacts);
  sensitive(canonicalEvaluationJson({ ...input, artifacts: [] }));
  return artifacts;
}

function makeReport(input: SelectedEvaluationInput, artifacts: Map<string, EvaluationArtifact>): EvaluationReport {
  const expectedIds = oracleCaseIds(artifacts.get(input.frozen.oracle.path)!.content, input.frozen.oracleVersion);
  return { version: 1, experimentId: input.frozen.id, limitations: [
    "One bounded task and a small sample cannot establish a causal memory effect or a model leaderboard.",
    "Automated acceptance is separate from reported outcome and human approval. Unavailable checks are not passing checks.",
    "Retrieved and injected memory does not prove internal use. Runtime differences and missing observations remain visible.",
    "Selected sanitized harness artifacts do not imply canonical capture attestation. Hash verification establishes bundle consistency, not authorship.",
  ], attempts: [...input.attempts].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map((attempt) => {
    const final = attempt.submissions.at(-1);
    const suite = final === undefined ? undefined : checksFrom(artifacts.get(final.checks.path)!.content, attempt.oracleVersion, expectedIds, final.code?.sha256);
    const counts = { passed: 0, failed: 0, unavailable: 0 };
    for (const check of suite?.checks ?? []) counts[check.status]++;
    if (suite === undefined) counts.unavailable = expectedIds.length;
    const available = suite?.availability === "completed" && suite.checks.length > 0 && counts.unavailable === 0 && final?.code !== undefined;
    const acceptance = !available ? "unavailable" as const : counts.failed > 0 ? "failed" as const : "passed" as const;
    const durations = attempt.submissions.map((submission) => submission.elapsedMs);
    const observations = attempt.submissions.flatMap((submission) => submission.runtime === undefined ? [] : [submission.runtime]);
    const identities = [...new Set(observations.map((value) => canonicalEvaluationJson(runtimeIdentity(value))))].sort();
    const runtimeConsistency = identities.length > 1 ? "mixed" as const : observations.length > 0 && observations.length === attempt.submissions.length && observations.every((observation) => observation.observedModel !== undefined) ? "consistent" as const : "unavailable" as const;
    const group = { taskId: input.frozen.taskId, taskVersion: attempt.taskVersion, taskSha256: input.frozen.task.sha256, inputStateId: attempt.inputStateId, inputSha256: input.frozen.input.sha256, oracleSha256: input.frozen.oracle.sha256, treeSha256: input.frozen.tree.sha256, rubricSha256: input.frozen.rubric.sha256, condition: attempt.condition, declaredRuntime: runtimeIdentity(attempt.runtime), roundRuntimes: identities, runtimeConsistency, ...(runtimeConsistency === "unavailable" ? { incomparableAttempt: attempt.id } : {}) };
    return { id: attempt.id, kind: attempt.kind, condition: attempt.condition, provider: new Set(observations.map(({provider})=>provider)).size > 1 ? "mixed" : observations[0]?.provider ?? attempt.runtime.provider,
      ...(attempt.runtime.configuredModel === undefined ? {} : { configuredModel: attempt.runtime.configuredModel }),
      ...(runtimeConsistency !== "consistent" ? {} : { observedModel: observations[0]!.observedModel! }),
      comparisonGroup: evaluationSha256(canonicalEvaluationJson(group)), runtimeConsistency, submissions: attempt.submissions.length, acceptance, confidence: !available ? null : counts.failed > 0 ? 0 : 1, checks: counts,
      annotations: annotationSummary(attempt, input.frozen, artifacts),
      elapsedMs: durations.length > 0 && durations.every((value) => value !== undefined) ? durations.reduce<number>((sum, value) => sum + value!, 0) : null,
      memoryExposure: attempt.memory === undefined ? "none" as const : "prompt-injected" as const,
      ...(attempt.reportedOutcome === undefined ? {} : { reportedOutcome: attempt.reportedOutcome }),
    };
  }) };
}
function markdown(report: EvaluationReport): string {
  const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replace(/[\\`*_{}[\]()!|]/g, "\\$&").replace(/[\r\n]/g, " ");
  return `# Selected evaluation: ${escape(report.experimentId)}\n\nLocal reviewed bundle.\n\n| Attempt | Origin | Condition | Provider / model | Runtime | Checks | Submissions | Elapsed ms |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n${report.attempts.map((attempt) => `| ${escape(attempt.id)} | ${attempt.kind} | ${attempt.condition} | ${escape(attempt.provider)} / ${escape(attempt.observedModel ?? "unobserved")} | ${attempt.runtimeConsistency} | ${attempt.acceptance} (${attempt.checks.passed} passed, ${attempt.checks.failed} failed, ${attempt.checks.unavailable} unavailable) | ${attempt.submissions} | ${attempt.elapsedMs ?? "unavailable"} |`).join("\n")}\n\n${report.limitations.map((item) => `- ${item}`).join("\n")}\n`;
}
export function createSelectedEvaluationBundle(input: SelectedEvaluationInput): SelectedEvaluationBundle {
  const artifacts = validateInput(input);
  const report = makeReport(input, artifacts);
  const files: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const artifact of [...artifacts.values()].sort((a, b) => a.path < b.path ? -1 : 1)) files[artifact.path] = artifact.content;
  files["report.json"] = canonicalEvaluationJson(report); files["report.md"] = markdown(report); files["dictionary.json"] = canonicalEvaluationJson(dictionary);
  const manifest: EvaluationBundleManifest = { version: 1, format: "fold-selected-evaluation-v1", frozen: input.frozen, attempts: [...input.attempts].sort((a, b) => a.id < b.id ? -1 : 1), sources: [...input.sources].sort((a, b) => sourceReference(a.reference) < sourceReference(b.reference) ? -1 : 1), exclusions: [...input.exclusions].sort((a, b) => canonicalEvaluationJson(a) < canonicalEvaluationJson(b) ? -1 : 1), review: { ...input.review, reviewedArtifactPaths: [...input.review.reviewedArtifactPaths].sort() }, artifacts: [...artifacts.values()].sort((a, b) => a.path < b.path ? -1 : 1).map((artifact) => ({ ...evaluationArtifactRef(artifact), mediaType: artifact.mediaType, bytes: Buffer.byteLength(artifact.content) })), generated: ["report.json", "report.md", "dictionary.json"].map((name) => ({ path: name, sha256: evaluationSha256(files[name]!), bytes: Buffer.byteLength(files[name]!) })) };
  files["manifest.json"] = canonicalEvaluationJson(manifest);
  files["bundle.sha256"] = `${evaluationSha256(files["manifest.json"])}  manifest.json\n`;
  return { files, manifest, report };
}

/** Validate every byte, reference and version, and independently regenerate every derived file. */
export function verifySelectedEvaluationBundle(files: Readonly<Record<string, string>>): { readonly valid: true; readonly manifest: EvaluationBundleManifest; readonly report: EvaluationReport } {
  if (files === null || typeof files !== "object" || Array.isArray(files)) fail("bundle files must be an object");
  let total = 0;
  if (Object.keys(files).length > 1005) fail("bundle file count limit exceeded");
  for (const [name, content] of Object.entries(files)) {
    if (!GENERATED.includes(name)) path(name);
    if (typeof content !== "string" || Buffer.byteLength(content) > MAX_FILE_BYTES || (total += Buffer.byteLength(content)) > MAX_BUNDLE_BYTES + 5 * MAX_FILE_BYTES) fail("bundle byte limit exceeded");
  }
  const text = files["manifest.json"]; if (text === undefined) fail("missing manifest");
  if (files["bundle.sha256"] !== `${evaluationSha256(text)}  manifest.json\n`) fail("manifest hash mismatch");
  const record = object(parseJson(text, "manifest"), "manifest", ["version", "format", "frozen", "attempts", "sources", "exclusions", "review", "artifacts", "generated"]);
  if (record.version !== 1 || record.format !== "fold-selected-evaluation-v1") fail("unsupported bundle version");
  array(record.artifacts, "manifest artifacts"); array(record.generated, "generated files", 3);
  const artifacts: EvaluationArtifact[] = record.artifacts.map((value) => {
    const item = object(value, "manifest artifact", ["path", "sha256", "mediaType", "bytes"]);
    ref({ path: item.path, sha256: item.sha256 }); integer(item.bytes, "artifact bytes");
    const content = files[item.path as string];
    if (content === undefined) fail(`missing artifact ${String(item.path)}`);
    if (evaluationSha256(content) !== item.sha256 || Buffer.byteLength(content) !== item.bytes) fail(`artifact hash or length mismatch ${String(item.path)}`);
    return { path: item.path as string, mediaType: item.mediaType as EvaluationArtifact["mediaType"], content };
  });
  const regenerated = createSelectedEvaluationBundle({ frozen: record.frozen as FrozenEvaluation, attempts: record.attempts as SelectedEvaluationAttempt[], sources: record.sources as SelectedEvaluationInput["sources"], exclusions: record.exclusions as SelectedEvaluationInput["exclusions"], review: record.review as SelectedEvaluationInput["review"], artifacts });
  if (canonicalEvaluationJson(files) !== canonicalEvaluationJson(regenerated.files)) fail("bundle contains missing, extra, altered or noncanonical generated files");
  return { valid: true, manifest: regenerated.manifest, report: regenerated.report };
}
/** This rejects altered input/report bytes rather than silently repairing a corrupted bundle. */
export function regenerateEvaluationReport(files: Readonly<Record<string, string>>): EvaluationReport { return verifySelectedEvaluationBundle(files).report; }
