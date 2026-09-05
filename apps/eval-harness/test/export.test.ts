import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { assembleSelectedEvaluation, verifyEvaluationDirectory } from "../src/export.js";
import { canonicalJson, sha256 } from "../src/hash.js";
import { containerDriverSource } from "../src/container.js";
import { NODE_IMAGE, runtimeContract, type AttemptRecord, type ExecutionPlan } from "../src/harness.js";
import { createSyntheticMemoryService } from "../src/memory.js";
import { activeOracleModuleSha256, DEFAULT_FIXTURE_DIRECTORY, evaluateOracleResults, frozenOracleCases, frozenSuiteSha256, FROZEN_ARTIFACT_PATHS } from "../src/oracle.js";
import { DEFAULT_RUNTIMES, FIXED_SYSTEM_PROMPT, RESPONSE_SCHEMA } from "../src/runtime.js";
import { snapshotOracleValue } from "../src/snapshot.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "eval-export-test-"));
  const frozenDirectory = join(root, "frozen"), rawDirectory = join(root, "raw"), annotationsDirectory = join(root, "annotations"), outputDirectory = join(root, "selected");
  await cp(DEFAULT_FIXTURE_DIRECTORY, frozenDirectory, { recursive: true }); await mkdir(rawDirectory); await mkdir(annotationsDirectory);
  const runtimes = DEFAULT_RUNTIMES.map(runtime => ({ ...runtime, executable: "synthetic-fixture", expectedVersion: "synthetic-fixture-only" }));
  for (const name of ["oracle", "snapshot"]) await cp(resolve(import.meta.dirname, `../src/${name}.ts`), join(frozenDirectory, `${name}-source.ts`));
  await writeFile(join(frozenDirectory, "driver-source.mjs"), containerDriverSource());
  await writeFile(join(frozenDirectory, "runtime-contract.json"), canonicalJson(runtimeContract(runtimes)));
  const files = Object.fromEntries(await Promise.all(FROZEN_ARTIFACT_PATHS.map(async name => [name, sha256(await readFile(join(frozenDirectory, name)))])));
  const oracleModuleSha256 = [await activeOracleModuleSha256()], suiteSha256 = frozenSuiteSha256(files, oracleModuleSha256);
  const frozenAt = new Date(Date.now() - 10_000).toISOString(), at = new Date().toISOString();
  const frozen = { version: 1 as const, taskId: "synthetic-event-delivery-v1", taskVersion: `event-delivery-v1:${suiteSha256}`, frozenAt, files, suiteSha256, oracleModuleSha256 };
  await writeFile(join(frozenDirectory, "freeze-manifest.json"), JSON.stringify(frozen));
  const plan: ExecutionPlan = { version: 1, kind: "real-provider-evaluation-plan", preparedAt: frozenAt, frozen, image: NODE_IMAGE, driverSha256: sha256(containerDriverSource()), systemPromptSha256: sha256(FIXED_SYSTEM_PROMPT), responseSchemaSha256: sha256(canonicalJson(RESPONSE_SCHEMA)), implementationSha256: "a".repeat(64), runtimes, conditions: ["no-memory", "memory"], maxSubmissions: 3 };
  const cases = await frozenOracleCases(frozenDirectory), code = await readFile(resolve(import.meta.dirname, "fixtures/known-good.mjs"), "utf8");
  // Authored synthetic observations test export joins; these never claim a real provider or container run.
  const observations = cases.map(test => { const snapshot = snapshotOracleValue(JSON.parse(test.inputJson)); return { id: test.id, status: test.expected.kind === "throw" ? "threw" as const : "returned" as const,
    ...(test.expected.kind === "return" ? { value: test.expected.value, outputIsJson: true, freshState: true } : {}), inputBefore: snapshot, inputAfter: snapshot }; });
  const evaluation = await evaluateOracleResults(cases, observations);
  const service = await createSyntheticMemoryService(await readFile(join(frozenDirectory, "synthetic-memory.md"), "utf8"));
  const memory = await service.retrieve(); const entries = service.entries; await service.close();
  const process = { exitCode: 0, signal: null, stdout: "", stderr: "", elapsedMs: 1 };
  const attempts: AttemptRecord[] = [];
  for (const condition of plan.conditions) for (const runtime of runtimes) {
    const id = `${runtime.provider}-${condition}`;
    attempts.push({ version: 1, id, kind: "synthetic-fixture", condition, taskVersion: frozen.taskVersion, startedAt: at, finishedAt: at, ...(condition === "memory" ? { memory } : {}), comparison: "baseline",
      submissions: [{ id: `${id}-1`, promptSha256: "b".repeat(64), runtime: { provider: runtime.provider, configuredModel: runtime.configuredModel, observedModel: "synthetic-observed-model", runtimeVersion: runtime.expectedVersion,
        configuration: { effort: runtime.effort, arguments: [], systemPromptSha256: plan.systemPromptSha256 }, startedAt: at, finishedAt: at, process, output: { code, summary: "Authored synthetic fixture only" }, protocolIssues: [] },
        container: { image: plan.image, driverSha256: plan.driverSha256, codeSha256: sha256(code), process, observations, protocolIssues: [] }, evaluation }] });
    await writeFile(join(annotationsDirectory, `${id}.json`), canonicalJson({ version: 1, annotationVersion: files["annotation-rubric.md"], annotations: [] }));
  }
  const save = async (values = attempts) => { await writeFile(join(rawDirectory, "attempts.json"), JSON.stringify(values)); };
  await save(); await writeFile(join(rawDirectory, "execution-plan.json"), JSON.stringify(plan)); await writeFile(join(rawDirectory, "synthetic-memory-events.json"), JSON.stringify(entries));
  return { root, attempts, save, options: { rawDirectory, annotationsDirectory, outputDirectory, fixtureDirectory: frozenDirectory, reviewedBy: "synthetic-test-review" } };
}

describe("selected assembly through actual canonical source selection", () => {
  it("requires exact preview approval, preserves per-round runtime and shared projection, and regenerates offline", async () => {
    const f = await fixture();
    try {
      const preview = await assembleSelectedEvaluation(f.options); expect(preview.status).toBe("review-required");
      await expect(readFile(join(f.options.outputDirectory, "manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });
      if (preview.status !== "review-required") throw new Error("Missing preview");
      const draft = JSON.parse(await readFile(preview.reviewFile, "utf8"));
      expect(draft.input.attempts.every((attempt: { kind: string; submissions: { runtime: unknown }[] }) => attempt.kind === "synthetic-fixture" && attempt.submissions[0]?.runtime !== undefined)).toBe(true);
      expect(draft.input.artifacts.some((artifact: { path: string }) => artifact.path.endsWith("trajectory-projection.json"))).toBe(true);
      const repeat = await assembleSelectedEvaluation(f.options); expect(repeat).toMatchObject({ reviewSha256: preview.reviewSha256 });
      await expect(assembleSelectedEvaluation({ ...f.options, approvedReviewSha256: "0".repeat(64) })).rejects.toThrow(/approval/);
      const selected = await assembleSelectedEvaluation({ ...f.options, approvedReviewSha256: preview.reviewSha256 }); expect(selected.status).toBe("written");
      if (selected.status !== "written") throw new Error("Missing selected output");
      expect(await verifyEvaluationDirectory(f.options.outputDirectory)).toEqual(selected.report);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
  it("rejects altered code, cached oracle results, borrowed memory text, runtime failures and changed task identity", async () => {
    const f = await fixture();
    try {
      for (const [mutation, expected] of [
        [(a: any[]) => { a[0].submissions[0].runtime.output.code += "\n// changed"; }, /code, driver or image/],
        [(a: any[]) => { a[0].submissions[0].evaluation.acceptance = "failed"; }, /retained observations/],
        [(a: any[]) => { a[2].memory.content += "extra"; a[2].memory.contentSha256 = sha256(a[2].memory.content); }, /memory bytes/],
        [(a: any[]) => { a[0].submissions[0].runtime.process.failure = "timeout"; }, /eligible provider/],
        [(a: any[]) => { a[0].submissions[0].runtime.protocolIssues = ["malformed-runtime-record"]; }, /eligible provider/],
        [(a: any[]) => { a[0].taskVersion = "altered"; }, /frozen task/],
        [(a: any[]) => { a[0].submissions[0].runtime.configuredModel = "altered"; }, /runtime or task identity/],
      ] as const) {
        const changed = structuredClone(f.attempts); mutation(changed); await f.save(changed); await expect(assembleSelectedEvaluation(f.options)).rejects.toThrow(expected);
      }
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
});
