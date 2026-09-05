import { describe, expect, it } from "vitest";
import { canonicalEvaluationJson, combineOracleExecutions, createSelectedEvaluationBundle, evaluationArtifactRef, evaluationSha256, regenerateEvaluationReport, verifySelectedEvaluationBundle, type EvaluationArtifact, type EvaluationChecks, type SelectedEvaluationInput } from "../src/index.js";

function fixture(checks: EvaluationChecks = { version: 1, suiteVersion: "checks-v1", availability: "completed", checks: [{ id: "identity", status: "passed" }] }): SelectedEvaluationInput {
  const artifacts: EvaluationArtifact[] = [];
  const add = (name: string, content: string, mediaType: EvaluationArtifact["mediaType"] = "text/plain") => {
    const artifact = { path: `artifacts/${name}`, content, mediaType }; artifacts.push(artifact); return evaluationArtifactRef(artifact);
  };
  const frozen = { id: "fixture-experiment", taskId: "public-task", taskVersion: "task-v1", inputStateId: "input-v1", oracleVersion: "checks-v1", treeVersion: "tree-v1", annotationVersion: "rubric-v1", frozenAt: "2026-09-04T00:00:00Z", task: add("task.md", "A public programming task", "text/markdown"), input: add("initial.js", "export const initial = {};", "text/javascript"), oracle: add("oracle.json", canonicalEvaluationJson({version:1,suiteVersion:"checks-v1",checkIds:checks.checks.length ? checks.checks.map(({id})=>id) : ["identity"]}), "application/json"), tree: add("tree.json", '{"nodes":[{"id":"identity"},{"id":"ordering"}]}', "application/json"), rubric: add("rubric.md", "Preserve ambiguous steps", "text/markdown") };
  const attempts = [{ id: "fixture-attempt", kind: "synthetic-fixture" as const, condition: "no-memory" as const, taskVersion: frozen.taskVersion, inputStateId: frozen.inputStateId, oracleVersion: frozen.oracleVersion, treeVersion: frozen.treeVersion, annotationVersion: frozen.annotationVersion, runtime: { provider: "synthetic", runtimeVersion: "fixture-v1", configuration: add("config.json", '{"tools":false}', "application/json") }, startedAt: "2026-09-04T01:00:00Z", finishedAt: "2026-09-04T01:01:00Z", submissions: [{ id: "one", output: add("output.txt", "Observed fixture output"), code: add("submission.js", "export function solution() { return 1; }", "text/javascript"), checks: add("checks.json", canonicalEvaluationJson({...checks, codeSha256:evaluationSha256("export function solution() { return 1; }")}), "application/json"), elapsedMs: 100 }], annotations: add("annotations.json", '{"version":1,"annotationVersion":"rubric-v1","annotations":[]}', "application/json"), reportedOutcome: "success" }];
  return { frozen, attempts, artifacts, sources: [], exclusions: [], review: { selectionId: "selection-v1", audience: "local-reviewed", redactionVersion: "redaction-v1", reviewedArtifactPaths: artifacts.map(({ path }) => path), reviewedBy: "reviewer-a", reviewedAt: "2026-09-04T02:00:00Z" } };
}

describe("selected evaluation bundles", () => {
  it("reproduces every derived byte independent of input file order and labels synthetic evidence", () => {
    const input = fixture(); const first = createSelectedEvaluationBundle(input);
    const reordered = createSelectedEvaluationBundle({ ...input, artifacts: [...input.artifacts].reverse(), review: { ...input.review, reviewedArtifactPaths: [...input.review.reviewedArtifactPaths].reverse() } });
    expect(reordered.files).toEqual(first.files);
    expect(verifySelectedEvaluationBundle(first.files).valid).toBe(true);
    expect(regenerateEvaluationReport(first.files)).toEqual(first.report);
    expect(first.report.attempts[0]).toMatchObject({ kind: "synthetic-fixture", acceptance: "passed", confidence: 1, memoryExposure: "none", reportedOutcome: "success" });
    expect(first.files["dictionary.json"]).toContain("not the model's internal use");
  });

  it.each([
    { availability: "unavailable" as const, checks: [] },
    { availability: "completed" as const, checks: [] },
    { availability: "completed" as const, checks: [{ id: "not-run", status: "unavailable" as const }] },
    { availability: "unavailable" as const, checks: [{ id: "partial", status: "passed" as const }] },
  ])("does not turn absent/partial oracle execution into kernel-neutral success: %j", (suite) => {
    expect(combineOracleExecutions([]).confidence).toBe(1);
    const report = createSelectedEvaluationBundle(fixture({ version: 1, suiteVersion: "checks-v1", ...suite })).report;
    expect(report.attempts[0]).toMatchObject({ acceptance: "unavailable", confidence: null });
  });

  it("keeps failed automated acceptance separate from self-reported success and records missing effort", () => {
    const input = fixture({ version: 1, suiteVersion: "checks-v1", availability: "completed", checks: [{ id: "fails", status: "failed" }, { id: "passes", status: "passed" }] });
    const attempt = input.attempts[0]!; const { elapsedMs: _, ...submission } = attempt.submissions[0]!;
    const report = createSelectedEvaluationBundle({ ...input, attempts: [{ ...attempt, submissions: [submission] }] }).report;
    expect(report.attempts[0]).toMatchObject({ acceptance: "failed", confidence: 0, reportedOutcome: "success", elapsedMs: null, checks: { passed: 1, failed: 1, unavailable: 0 } });
  });

  it("rejects missing, tampered, extra, and altered derived files", () => {
    const bundle = createSelectedEvaluationBundle(fixture());
    for (const name of ["artifacts/submission.js", "manifest.json", "report.json", "dictionary.json", "bundle.sha256"]) {
      const missing = { ...bundle.files }; delete missing[name]; expect(() => verifySelectedEvaluationBundle(missing)).toThrow();
      expect(() => verifySelectedEvaluationBundle({ ...bundle.files, [name]: `${bundle.files[name]}tampered` })).toThrow();
    }
    expect(() => verifySelectedEvaluationBundle({ ...bundle.files, "artifacts/unselected.txt": "extra" })).toThrow(/extra|selection/);
    expect(() => verifySelectedEvaluationBundle({ ...bundle.files, "../private": "bad" })).toThrow(/path/);
  });

  it("requires every frozen check and binds observations to the exact submitted code", () => {
    const input = fixture({ version: 1, suiteVersion: "checks-v1", availability: "completed", checks: [{ id: "first", status: "passed" }, { id: "second", status: "passed" }] });
    const attempt = input.attempts[0]!; const submission = attempt.submissions[0]!;
    const original = input.artifacts.find(({path})=>path===submission.checks.path)!;
    const content = JSON.parse(original.content) as EvaluationChecks;
    const partial = { ...original, content: canonicalEvaluationJson({...content,checks:content.checks.slice(0,1)}) };
    const changed = { ...input, artifacts: input.artifacts.map((artifact)=>artifact.path===partial.path?partial:artifact), attempts:[{...attempt,submissions:[{...submission,checks:evaluationArtifactRef(partial)}]}] };
    expect(createSelectedEvaluationBundle(changed).report.attempts[0]).toMatchObject({acceptance:"unavailable",confidence:null,checks:{passed:1,failed:0,unavailable:1}});
    const otherCode = { ...input.artifacts.find(({path})=>path===submission.code?.path)!, content:"export function solution() { return 999; }" };
    expect(()=>createSelectedEvaluationBundle({...input,artifacts:input.artifacts.map((artifact)=>artifact.path===otherCode.path?otherCode:artifact),attempts:[{...attempt,submissions:[{...submission,code:evaluationArtifactRef(otherCode)}]}]})).toThrow(/exact submitted code hash/);
  });

  it("rejects version conflicts, nonfrozen attempts, missing actual submissions and duplicate IDs", () => {
    const input = fixture(); const attempt = input.attempts[0]!;
    for (const patch of [{ oracleVersion: "checks-v2" }, { taskVersion: "other" }, { annotationVersion: "other" }, { startedAt: "2026-09-03T00:00:00Z" }, { kind: "real-provider" as const, submissions: [] }]) {
      expect(() => createSelectedEvaluationBundle({ ...input, attempts: [{ ...attempt, ...patch }] })).toThrow();
    }
    expect(() => createSelectedEvaluationBundle({ ...input, attempts: [attempt, attempt] })).toThrow(/duplicate attempt/);
    const changed = fixture({ version: 1, suiteVersion: "other", availability: "completed", checks: [] });
    expect(() => createSelectedEvaluationBundle(changed)).toThrow(/oracle version conflict/);
  });

  it("requires explicit selected-file review and rejects private paths, account metadata and credentials", () => {
    const input = fixture();
    expect(() => createSelectedEvaluationBundle({ ...input, review: { ...input.review, reviewedArtifactPaths: [] } })).toThrow(/unreviewed/);
    for (const content of ['/Users/private-person/secrets.txt', '{"principalId":"real-user"}', '{"headers":{"value":"private"}}', 'Bearer abcdefghijklmnop', '-----BEGIN PRIVATE KEY-----']) {
      const artifact = { ...input.artifacts[0]!, content };
      expect(() => createSelectedEvaluationBundle({ ...input, artifacts: [artifact, ...input.artifacts.slice(1)], frozen: { ...input.frozen, task: evaluationArtifactRef(artifact) } })).toThrow(/sensitive|private/);
    }
    const json = { path:"artifacts/escaped.json", mediaType:"application/json" as const, content:'{"\\u0074oken":"private"}' };
    expect(()=>createSelectedEvaluationBundle({...input,artifacts:[...input.artifacts,json],frozen:{...input.frozen,supportingArtifacts:[evaluationArtifactRef(json)]},review:{...input.review,reviewedArtifactPaths:[...input.review.reviewedArtifactPaths,json.path]}})).toThrow(/sensitive/);
  });

  it("validates observed annotation joins and preserves ambiguity and missing mappings", () => {
    const input = fixture(); const attempt = input.attempts[0]!; const submission = attempt.submissions[0]!;
    const method = { kind:"manual",id:"frozen-observable-rubric-v1",basis:"structural" };
    const annotation = {stepId:submission.id,assignment:{kind:"ambiguous",candidates:["identity","ordering"],reason:"Both operations appear in one observed submission",method},evidence:[{kind:"submission",artifactSha256:submission.output.sha256,roundId:submission.id}]};
    const make = (value:unknown) => {
      const artifact = {...input.artifacts.find(({path})=>path===attempt.annotations.path)!,content:canonicalEvaluationJson({version:1,annotationVersion:attempt.annotationVersion,annotations:[value]})};
      return {...input,artifacts:input.artifacts.map((item)=>item.path===artifact.path?artifact:item),attempts:[{...attempt,annotations:evaluationArtifactRef(artifact)}]};
    };
    expect(createSelectedEvaluationBundle(make(annotation)).report.attempts[0]?.annotations).toEqual({mapped:0,ambiguous:1,unmapped:0,missing:1,structural:1,semantic:0});
    expect(()=>createSelectedEvaluationBundle(make({...annotation,stepId:"invented-thought"}))).toThrow(/observed submission/);
    expect(()=>createSelectedEvaluationBundle(make({...annotation,evidence:[{kind:"check",caseId:"missing",roundId:submission.id}]}))).toThrow(/unobserved check/);
    expect(()=>createSelectedEvaluationBundle(make({...annotation,evidence:[{kind:"code-span",artifactSha256:submission.code!.sha256,startLine:1,endLine:999}]}))).toThrow(/code span/);
    expect(()=>createSelectedEvaluationBundle(make({...annotation,assignment:{...annotation.assignment,method:{...method,basis:"semantic"}}}))).toThrow(/concrete code span/);
    expect(()=>createSelectedEvaluationBundle(make({...annotation,assignment:{...annotation.assignment,candidates:["identity","invented"]}}))).toThrow(/frozen tree/);
    const laterRound = { ...submission,id:"two" };
    const borrowing = make({...annotation,evidence:[{kind:"check",caseId:"identity",roundId:"two"}]});
    expect(()=>createSelectedEvaluationBundle({...borrowing,attempts:[{...borrowing.attempts[0]!,submissions:[submission,laterRound]}]})).toThrow(/its observed round/);
  });

  it("uses unavailable check evidence only for an explicit unmapped observation", () => {
    const input = fixture({version:1,suiteVersion:"checks-v1",availability:"unavailable",checks:[{id:"identity",status:"unavailable"}]});
    const attempt = input.attempts[0]!;
    const annotation = {stepId:"one:checks",assignment:{kind:"unmapped",reason:"Execution unavailable",method:{kind:"manual",id:"frozen-observable-rubric-v1",basis:"structural"}},evidence:[{kind:"check",caseId:"identity",roundId:"one"}]};
    const withAssignment = (assignment:unknown) => {
      const artifact = {...input.artifacts.find(({path})=>path===attempt.annotations.path)!,content:canonicalEvaluationJson({version:1,annotationVersion:attempt.annotationVersion,annotations:[{...annotation,assignment}]})};
      return {...input,artifacts:input.artifacts.map((item)=>item.path===artifact.path?artifact:item),attempts:[{...attempt,annotations:evaluationArtifactRef(artifact)}]};
    };
    expect(createSelectedEvaluationBundle(withAssignment(annotation.assignment)).report.attempts[0]?.annotations.unmapped).toBe(1);
    expect(()=>createSelectedEvaluationBundle(withAssignment({kind:"mapped",nodeId:"identity",method:annotation.assignment.method}))).toThrow(/unavailable checks cannot establish/);
  });

  it("requires an eligible exact revision for injection and does not claim internal use", () => {
    const input = fixture(); const attempt = input.attempts[0]!;
    const injected = { path: "artifacts/injected.txt", mediaType: "text/plain" as const, content: "Use exact arithmetic for sequence positions." };
    const memory = { source: { memoryId: "synthetic-memory", revision: 0 }, recallId: "synthetic-recall", injected: evaluationArtifactRef(injected) };
    const changed = { ...input, artifacts: [...input.artifacts, injected], review: { ...input.review, reviewedArtifactPaths: [...input.review.reviewedArtifactPaths, injected.path] }, attempts: [{ ...attempt, condition: "memory" as const, memory }] };
    expect(() => createSelectedEvaluationBundle(changed)).toThrow(/eligible exact/);
    const valid = { ...changed, sources: [{ reference: { kind: "memory" as const, ...memory.source }, artifact: memory.injected, eligibility: "current-authorized" as const, selectionId: input.review.selectionId }] };
    expect(createSelectedEvaluationBundle(valid).report.attempts[0]?.memoryExposure).toBe("prompt-injected");
    expect(() => createSelectedEvaluationBundle({ ...valid, attempts: [{ ...attempt, condition: "memory", memory: { ...memory, source: { ...memory.source, revision: 1 } } }] })).toThrow(/eligible exact/);
  });

  it("partitions configured/observed runtime identities and condition instead of pooling a leaderboard", () => {
    const input = fixture(); const attempt = input.attempts[0]!;
    const report = createSelectedEvaluationBundle({ ...input, attempts: [attempt, { ...attempt, id: "second", runtime: { ...attempt.runtime, observedModel: "observed-b" } }] }).report;
    expect(new Set(report.attempts.map((item) => item.comparisonGroup)).size).toBe(2);
    expect(report.attempts[0]).not.toHaveProperty("observedModel");
    const original = input.artifacts.find(({path})=>path===attempt.runtime.configuration.path)!;
    const renamed = {...original,path:"artifacts/renamed-config.json"};
    const observed = {...attempt.runtime,observedModel:"fixed"};
    const first = {...attempt,runtime:observed,submissions:attempt.submissions.map((submission)=>({...submission,runtime:observed}))};
    const renamedRuntime = {...observed,configuration:evaluationArtifactRef(renamed)};
    const aliases = createSelectedEvaluationBundle({...input,artifacts:[...input.artifacts,renamed],review:{...input.review,reviewedArtifactPaths:[...input.review.reviewedArtifactPaths,renamed.path]},attempts:[first,{...first,id:"copy",runtime:renamedRuntime,submissions:first.submissions.map((submission)=>({...submission,runtime:renamedRuntime}))}]}).report;
    expect(new Set(aliases.attempts.map(({comparisonGroup})=>comparisonGroup)).size).toBe(1);
  });

  it("retains per-round observed model changes instead of grouping by only the final model", () => {
    const input = fixture(); const attempt = input.attempts[0]!; const submission = attempt.submissions[0]!;
    const firstRuntime = {...attempt.runtime,observedModel:"model-a"};
    const lastRuntime = {...attempt.runtime,observedModel:"model-b"};
    const report = createSelectedEvaluationBundle({...input,attempts:[{...attempt,kind:"real-provider",runtime:lastRuntime,submissions:[{...submission,runtime:firstRuntime},{...submission,id:"two",runtime:lastRuntime}]}]}).report;
    expect(report.attempts[0]?.runtimeConsistency).toBe("mixed");
    expect(report.attempts[0]).not.toHaveProperty("observedModel");
    expect(()=>createSelectedEvaluationBundle({...input,attempts:[{...attempt,kind:"real-provider"}]})).toThrow(/per-round runtime/);
  });

  it("bounds bytes and refuses lossy JSON values", () => {
    const input = fixture(); const artifact = { ...input.artifacts[0]!, content: "x".repeat(2 * 1024 * 1024 + 1) };
    expect(() => createSelectedEvaluationBundle({ ...input, artifacts: [artifact, ...input.artifacts.slice(1)] })).toThrow(/byte limit/);
    expect(() => canonicalEvaluationJson({ missing: undefined })).toThrow(/finite JSON/);
    expect(() => canonicalEvaluationJson({ invalid: Number.NaN })).toThrow(/finite JSON/);
    expect(() => canonicalEvaluationJson([, 1])).toThrow(/sparse/);
    expect(() => canonicalEvaluationJson({ [Symbol("hidden")]: true })).toThrow(/symbols/);
    expect(() => canonicalEvaluationJson(Object.defineProperty({}, "hidden", {value:true}))).toThrow(/hidden/);
    expect(canonicalEvaluationJson({ b: 2, a: [3, 1] })).toBe('{"a":[3,1],"b":2}\n');
  });
});
