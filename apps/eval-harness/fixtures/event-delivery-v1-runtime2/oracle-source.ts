import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { evaluateOracles, type OracleEvaluation } from "@_89/fold-eval";
import type { SharedDecisionTree } from "@_89/fold-trace";
import { isOracleJson, snapshotOracleValue } from "./snapshot.js";

export interface OracleCase {
  readonly id: string;
  readonly group: string;
  readonly description: string;
  /** Exact JSON text; a nonfinite invalid input can use 1e309 without lossy JSON.stringify coercion. */
  readonly inputJson: string;
  readonly expected: { readonly kind: "return"; readonly value: unknown } | { readonly kind: "throw" };
}
export interface OracleObservation {
  readonly id: string;
  readonly status: "returned" | "threw";
  readonly value?: unknown;
  readonly outputIsJson?: boolean;
  readonly inputBefore: string;
  readonly inputAfter: string;
  readonly freshState?: boolean;
  readonly freshEvents?: boolean;
}
export interface OracleCheck {
  readonly id: string;
  readonly group: string;
  readonly status: "pass" | "fail" | "unavailable";
  readonly reasons: readonly string[];
}
export interface FrozenOracleEvaluation {
  readonly version: 1;
  readonly availability: "available" | "unavailable";
  readonly acceptance: "passed" | "failed" | "unavailable";
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly unavailable: number;
  readonly checks: readonly OracleCheck[];
  readonly evaluation: Omit<OracleEvaluation, "confidence"> & { readonly confidence: number | null };
}
export interface FreezeManifest {
  readonly version: 1;
  readonly taskId: string;
  readonly taskVersion: string;
  readonly frozenAt: string;
  readonly files: Readonly<Record<string, string>>;
  readonly suiteSha256: string;
  /** Reviewed source and production bundle modules; rejects execution of stale/unfrozen oracle bytes. */
  readonly oracleModuleSha256: readonly string[];
}
export const FROZEN_TASK_ID = "synthetic-event-delivery-v1";
export const FROZEN_ARTIFACT_PATHS = ["public-task.md", "initial.mjs", "public-examples.json", "hidden-cases.json", "decision-tree.json", "annotation-rubric.md", "oracle-source.ts", "snapshot-source.ts", "synthetic-memory.md", "driver-source.mjs", "runtime-contract.json"] as const;
/** Resolve explicitly from the package directory; source and bundled outputs share this default. */
export const DEFAULT_FIXTURE_DIRECTORY = resolve(import.meta.dirname, "../fixtures/event-delivery-v1-runtime2");

export async function frozenOracleCases(directory = DEFAULT_FIXTURE_DIRECTORY): Promise<readonly OracleCase[]> {
  const values = JSON.parse(await readFile(resolve(directory, "hidden-cases.json"), "utf8")) as OracleCase[];
  if (!Array.isArray(values) || values.length === 0 || new Set(values.map((value) => value.id)).size !== values.length) throw new TypeError("Invalid frozen acceptance cases");
  for (const value of values) {
    if (!value.id || !value.group || typeof value.inputJson !== "string" || !["return", "throw"].includes(value.expected.kind)) throw new TypeError("Invalid frozen acceptance case");
    JSON.parse(value.inputJson);
    if (value.expected.kind === "return" && !isOracleJson(value.expected.value)) throw new TypeError("Invalid frozen expected value");
  }
  return values;
}
export async function frozenDecisionTree(directory = DEFAULT_FIXTURE_DIRECTORY): Promise<SharedDecisionTree> {
  return JSON.parse(await readFile(resolve(directory, "decision-tree.json"), "utf8")) as SharedDecisionTree;
}
const digest = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export async function activeOracleModuleSha256(): Promise<string> { return digest(await readFile(new URL(import.meta.url))); }
/** Real execution must verify this complete frozen manifest before constructing a provider prompt. */
export async function verifyFrozenFixture(directory = DEFAULT_FIXTURE_DIRECTORY, execution: { readonly driverSha256?: string; readonly runtimeContractSha256?: string } = {}): Promise<FreezeManifest> {
  const manifest = JSON.parse(await readFile(resolve(directory, "freeze-manifest.json"), "utf8")) as FreezeManifest;
  if (manifest.version !== 1 || manifest.taskId !== FROZEN_TASK_ID || !Number.isFinite(Date.parse(manifest.frozenAt)) || Object.keys(manifest.files).length !== FROZEN_ARTIFACT_PATHS.length || FROZEN_ARTIFACT_PATHS.some((path) => manifest.files[path] === undefined)) throw new TypeError("Invalid frozen manifest");
  for (const [path, expected] of Object.entries(manifest.files)) {
    if (path.startsWith("/") || path.split("/").includes("..") || !/^[a-f0-9]{64}$/.test(expected)) throw new TypeError("Invalid frozen path/hash");
    if (digest(await readFile(resolve(directory, path))) !== expected) throw new Error(`Frozen artifact changed: ${path}`);
  }
  if (!Array.isArray(manifest.oracleModuleSha256) || manifest.oracleModuleSha256.length < 1 || manifest.oracleModuleSha256.length > 4 || !manifest.oracleModuleSha256.every((hash) => /^[a-f0-9]{64}$/.test(hash)) || !manifest.oracleModuleSha256.includes(await activeOracleModuleSha256())) throw new Error("Executing oracle module is not frozen");
  for (const name of ["oracle", "snapshot"] as const) {
    if (digest(await readFile(resolve(import.meta.dirname, `../src/${name}.ts`))) !== manifest.files[`${name}-source.ts`]) throw new Error(`Active ${name} differs from frozen source`);
  }
  if (execution.driverSha256 !== undefined && execution.driverSha256 !== manifest.files["driver-source.mjs"]) throw new Error("Executing driver differs from frozen source");
  if (execution.runtimeContractSha256 !== undefined && execution.runtimeContractSha256 !== manifest.files["runtime-contract.json"]) throw new Error("Runtime contract differs from frozen contract");
  if (frozenSuiteSha256(manifest.files, manifest.oracleModuleSha256) !== manifest.suiteSha256 || manifest.taskVersion !== `event-delivery-v1:${manifest.suiteSha256}`) throw new Error("Frozen suite identity mismatch");
  return manifest;
}
/** Aggregate identity includes actual reviewed execution bytes as well as the public/private specification. */
export function frozenSuiteSha256(files: Readonly<Record<string,string>>, modules: readonly string[]): string {
  const suite = Object.entries(files).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([path,hash]) => `${path}\0${hash}\n`).join("");
  return digest(suite + `oracle-modules\0${JSON.stringify([...modules].sort())}\n`);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string,unknown>)[key])}`).join(",")}}`;
}

/** The fixed driver reports observations only. Expected answers and all pass/fail checks remain here. */
export async function evaluateOracleResults(cases: readonly OracleCase[], observations: readonly OracleObservation[]): Promise<FrozenOracleEvaluation> {
  if (cases.length === 0 || new Set(cases.map((test) => test.id)).size !== cases.length) throw new TypeError("Acceptance suite requires unique cases");
  const known = new Set(cases.map((test) => test.id));
  const protocolInvalid = observations.some((observed) => observed === null || typeof observed !== "object" || !known.has(observed.id));
  const checks: OracleCheck[] = cases.map((test) => {
    const matches = observations.filter((observed) => observed !== null && typeof observed === "object" && observed.id === test.id);
    const observed = matches[0];
    if (protocolInvalid || matches.length !== 1 || observed === undefined || !["returned","threw"].includes(observed.status) ||
      typeof observed.inputBefore !== "string" || typeof observed.inputAfter !== "string" || observed.inputBefore !== snapshotOracleValue(JSON.parse(test.inputJson))) {
      return { id: test.id, group: test.group, status: "unavailable", reasons: ["driver-observation-unavailable"] };
    }
    const reasons: string[] = [];
    if (observed.inputAfter !== observed.inputBefore) reasons.push("input-mutated");
    if (test.expected.kind === "throw") {
      if (observed.status !== "threw") reasons.push("invalid-input-accepted");
    } else if (observed.status !== "returned") reasons.push("unexpected-throw");
    else {
      if (observed.outputIsJson !== true || !isOracleJson(observed.value)) reasons.push("non-json-output");
      else if (stableJson(observed.value) !== stableJson(test.expected.value)) reasons.push("incorrect-value");
      if (observed.freshState !== true) reasons.push("output-not-fresh");
    }
    return { id: test.id, group: test.group, status: reasons.length === 0 ? "pass" : "fail", reasons };
  });
  // Reuse the actual evaluation combiner, but never surface its neutral all-absent identity as acceptance.
  const kernel = await evaluateOracles({ combine: "min", oracles: checks.map((check) => ({ type: "checklist", id: check.id })) }, checks,
    { handlers: { checklist: (spec, values) => { const check = values.find((value) => value.id === spec.id); return check === undefined || check.status === "unavailable" ? undefined : { confidence: check.status === "pass" ? 1 : 0, detail: `${check.id}:${check.status}` }; } } });
  const passed = checks.filter((check) => check.status === "pass").length;
  const failed = checks.filter((check) => check.status === "fail").length;
  const unavailable = checks.length - passed - failed;
  return { version: 1, availability: unavailable > 0 ? "unavailable" : "available", acceptance: unavailable > 0 ? "unavailable" : failed > 0 ? "failed" : "passed",
    total: checks.length, passed, failed, unavailable, checks, evaluation: { ...kernel, confidence: unavailable > 0 ? null : kernel.confidence } };
}
