import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { snapshotOracleValue, isOracleJson } from "./snapshot.js";
import type { OracleCase, OracleObservation } from "./oracle.js";
import { runBoundedProcess, runtimeEnvironment, type ProcessResult } from "./process.js";
import { sha256 } from "./hash.js";

/** This trusted program contains no expected results. VM limits are tamper resistance; Docker is the security boundary. */
export function containerDriverSource(): string {
  return `import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const snapshot = (${snapshotOracleValue.toString()});
const isJson = (${isOracleJson.toString()});
const packet = JSON.parse(readFileSync(0, 'utf8'));
if (packet.version !== 1 || typeof packet.code !== 'string' || !Array.isArray(packet.cases)) throw new Error('invalid driver packet');
for (const test of packet.cases) {
  const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false }, microtaskMode: 'afterEvaluate' });
  Object.defineProperty(context, '__inputJson', { value: test.inputJson, writable: false, configurable: true });
  const input = vm.runInContext('JSON.parse(__inputJson)', context, { timeout: 250 });
  delete context.__inputJson;
  Object.defineProperty(context, '__input', { value: undefined, writable: true, configurable: false });
  Object.defineProperty(context, '__candidate', { value: undefined, writable: true, configurable: false });
  const inputBefore = snapshot(input);
  let module;
  try {
    module = new vm.SourceTextModule(packet.code, { context, identifier: 'candidate.mjs', importModuleDynamically() { throw new Error('imports disabled'); } });
    await module.link(() => { throw new Error('imports disabled'); });
    await module.evaluate({ timeout: 250 });
    if (typeof module.namespace.reduceDelivery !== 'function') throw new Error('reduceDelivery export missing');
    Object.defineProperty(context, '__candidate', { value: module.namespace.reduceDelivery, writable: false, configurable: false });
    Object.defineProperty(context, '__input', { value: input, writable: false, configurable: false });
  } catch {
    process.stdout.write(JSON.stringify({ id: test.id, unavailable: 'module-load' }) + '\\n');
    continue;
  }
  let value, threw = false, timedOut = false;
  try {
    value = vm.runInContext('__candidate(__input.state, __input.arrivals)', context, { timeout: 250 });
  } catch (error) {
    threw = true;
    timedOut = error?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT';
  }
  if (timedOut) { process.stdout.write(JSON.stringify({ id: test.id, unavailable: 'execution-timeout' }) + '\\n'); continue; }
  let inputAfter;
  try { inputAfter = snapshot(input); }
  catch { process.stdout.write(JSON.stringify({ id: test.id, unavailable: 'observer-failure' }) + '\\n'); continue; }
  let observation;
  if (threw) observation = { id: test.id, status: 'threw', inputBefore, inputAfter };
  else {
    let outputIsJson = false, detached;
    try { outputIsJson = isJson(value); if (outputIsJson) detached = structuredClone(value); }
    catch { outputIsJson = false; }
    observation = { id: test.id, status: 'returned', ...(outputIsJson ? { value: detached } : {}), outputIsJson,
      inputBefore, inputAfter, freshState: value !== input.state,
      freshEvents: outputIsJson && value !== null && typeof value === 'object' && Object.getOwnPropertyDescriptor(value, 'events')?.value !== input.state?.events };
  }
  process.stdout.write(JSON.stringify(observation) + '\\n');
}
`;
}

export function containerArguments(image: string, name: string, driver = containerDriverSource()): string[] {
  if (!/^[a-z0-9][a-z0-9./_-]*@sha256:[a-f0-9]{64}$/.test(image)) throw new Error("Container image must be pinned by digest");
  if (!/^super-brain-eval-[a-z0-9-]+$/.test(name)) throw new Error("Invalid owned container name");
  return ["run", "--rm", "--name", name, "--pull", "never", "--network", "none", "--read-only", "--ipc", "none",
    "--user", "65534:65534", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "32",
    "--memory", "128m", "--memory-swap", "128m", "--cpus", "0.5", "--ulimit", "nofile=64:64", "--ulimit", "core=0:0",
    "--log-driver", "none", "--workdir", "/tmp", "-i", "--entrypoint", "node", image,
    "--max-old-space-size=64", "--experimental-vm-modules", "--input-type=module", "-e", driver];
}
export interface ContainerObservation {
  readonly image: string;
  readonly driverSha256: string;
  readonly codeSha256: string;
  readonly process: ProcessResult;
  readonly observations: readonly OracleObservation[];
  readonly protocolIssues: readonly string[];
}

export async function executeInContainer(code: string, cases: readonly OracleCase[], options: { image: string; docker?: string; timeoutMs?: number; signal?: AbortSignal }): Promise<ContainerObservation> {
  if (Buffer.byteLength(code) > 128 * 1024 || cases.length < 1 || cases.length > 200) throw new Error("Evaluation input exceeds bounds");
  const packet = JSON.stringify({ version: 1, code, cases: cases.map(({ id, inputJson }) => ({ id, inputJson })) });
  if (Buffer.byteLength(packet) > 1024 * 1024) throw new Error("Evaluation packet exceeds bounds");
  const name = `super-brain-eval-${randomUUID()}`;
  const docker = options.docker ?? "docker";
  const driver = containerDriverSource();
  const env = runtimeEnvironment();
  let process: ProcessResult;
  try {
    process = await runBoundedProcess(docker, containerArguments(options.image, name, driver), { cwd: tmpdir(), env, input: packet,
      timeoutMs: options.timeoutMs ?? 30_000, maxOutputBytes: 4 * 1024 * 1024, ...(options.signal === undefined ? {} : { signal: options.signal }) });
  } finally {
    // Killing the Docker CLI alone can leave a daemon-owned container running. Remove only this generated name.
    await runBoundedProcess(docker, ["rm", "--force", name], { cwd: tmpdir(), env, timeoutMs: 10_000, maxOutputBytes: 4096 });
  }
  const observations: OracleObservation[] = [];
  const protocolIssues: string[] = [];
  if (process.exitCode !== 0 || process.failure !== undefined) protocolIssues.push(`container-${process.failure ?? "nonzero-exit"}`);
  for (const line of process.stdout.split("\n").filter((value) => value !== "")) {
    try {
      const value = JSON.parse(line) as OracleObservation;
      if (value !== null && typeof value === "object" && typeof value.id === "string" && ["returned", "threw"].includes(value.status)) observations.push(value);
      else protocolIssues.push("unavailable-driver-observation");
    } catch { protocolIssues.push("malformed-driver-observation"); }
  }
  return { image: options.image, driverSha256: sha256(driver), codeSha256: sha256(code), process, observations: process.exitCode === 0 && process.failure === undefined ? observations : [], protocolIssues: [...new Set(protocolIssues)] };
}
