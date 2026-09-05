#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readEvaluationText } from "./io.js";
import { isolatedDefaultRuntimes } from "./runtime.js";
import { probeCodexIsolation } from "./preflight.js";
import { executionPlanSha256, prepareExecutionPlan, runExperiment, type ExecutionPlan } from "./harness.js";
import { assembleSelectedEvaluation, verifyEvaluationDirectory } from "./export.js";

const [command, output, destination, approvedHash, reviewHash] = process.argv.slice(2);
if (command === "probe-codex" && output !== undefined) {
  const result = await probeCodexIsolation((await isolatedDefaultRuntimes())[0]!);
  await writeFile(resolve(output), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify({ kind: result.kind, available: result.available, isolation: "isolation" in result ? result.isolation : undefined, exitCode: result.runtime.process.exitCode, protocolIssues: result.runtime.protocolIssues }));
} else if (command === "prepare" && output !== undefined) {
  const plan = await prepareExecutionPlan(await isolatedDefaultRuntimes());
  await writeFile(resolve(output), `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify({ planSha256: executionPlanSha256(plan), taskVersion: plan.frozen.taskVersion, status: "prepared-no-provider-calls" }));
} else if (command === "run" && output !== undefined && destination !== undefined && approvedHash !== undefined) {
  const plan = JSON.parse(await readEvaluationText(resolve(output))) as ExecutionPlan;
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort()); process.once("SIGTERM", () => controller.abort());
  const attempts = await runExperiment(plan, { approvedPlanSha256: approvedHash, outputDirectory: destination, signal: controller.signal });
  console.log(JSON.stringify(attempts.map((attempt) => ({ id: attempt.id, kind: attempt.kind, acceptance: attempt.submissions.at(-1)?.evaluation.acceptance, submissions: attempt.submissions.length, comparison: attempt.comparison }))));
} else if (command === "export" && output !== undefined && destination !== undefined && approvedHash !== undefined) {
  console.log(JSON.stringify(await assembleSelectedEvaluation({ rawDirectory: output, annotationsDirectory: destination, outputDirectory: approvedHash, reviewedBy: "synthetic-local-review", ...(reviewHash === undefined ? {} : { approvedReviewSha256: reviewHash }) })));
} else if (command === "verify" && output !== undefined) {
  console.log(JSON.stringify(await verifyEvaluationDirectory(output)));
} else {
  console.error("Usage: super-brain-eval probe-codex <new-private-output.json> | prepare <new-plan.json> | run <plan.json> <new-output-directory> <approved-plan-sha256> | export <raw-directory> <reviewed-annotations-directory> <new-bundle-directory> [approved-preview-sha256] | verify <bundle-directory>");
  process.exitCode = 2;
}
