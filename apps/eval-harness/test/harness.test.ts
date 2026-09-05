import { describe, expect, it } from "vitest";
import { DEFAULT_RUNTIMES, type RuntimeObservation } from "../src/runtime.js";
import { requireIsolationGate, runAttemptSubmissions, NODE_IMAGE } from "../src/harness.js";
import type { OracleCase } from "../src/oracle.js";
import type { ContainerObservation } from "../src/container.js";
import type { probeCodexIsolation } from "../src/preflight.js";
import { snapshotOracleValue } from "../src/snapshot.js";

const input = { state: { checkpoint: "0", events: [] }, arrivals: [] };
const cases: readonly OracleCase[] = [{ id: "synthetic-empty", group: "synthetic", description: "Authored unit fixture", inputJson: JSON.stringify(input), expected: { kind: "return", value: input.state } }];
const spec = DEFAULT_RUNTIMES[0]!;
const runtime = (): RuntimeObservation => ({ provider: spec.provider, configuredModel: spec.configuredModel, observedModel: "synthetic-model", runtimeVersion: "synthetic-runtime", configuration: { effort: "medium", arguments: [], systemPromptSha256: "synthetic" }, startedAt: "2026-09-04T00:00:00Z", finishedAt: "2026-09-04T00:00:01Z", process: { exitCode: 0, signal: null, stdout: "", stderr: "", elapsedMs: 1000 }, output: { code: "synthetic unit text; never executed", summary: "synthetic fixture" }, protocolIssues: [] });
const container = (): ContainerObservation => ({ image: NODE_IMAGE, driverSha256: "synthetic", codeSha256: "synthetic", process: { exitCode: 0, signal: null, stdout: "", stderr: "", elapsedMs: 10 }, observations: [{ id: cases[0]!.id, status: "returned", value: input.state, outputIsJson: true, inputBefore: snapshotOracleValue(input), inputAfter: snapshotOracleValue(input), freshState: true, freshEvents: true }], protocolIssues: [] });
const context = () => ({ id: "synthetic-unit", task: "PUBLIC TASK", examples: "[]", initial: "INITIAL", cases, image: NODE_IMAGE, beforeDispatch: async () => {}, afterRuntime: async () => {}, afterSubmission: async () => {} });

describe("harness dispatch and result integrity (synthetic injected boundaries only)", () => {
  it("never executes returned code when runtime failed, attempted a tool, or threw during preparation", async () => {
    let executions = 0;
    for (const failure of ["timeout", "tool", "throw"] as const) {
      let dispatches = 0;
      const result = await runAttemptSubmissions(spec, context(), { runtime: async () => {
        dispatches += 1; const value = runtime(); if (failure === "throw") throw new Error("synthetic preparation exception");
        return failure === "tool" ? { ...value, protocolIssues: ["unexpected-tool-use"] } : { ...value, process: { ...value.process, failure: "timeout" } };
      }, container: async () => { executions += 1; return container(); } });
      expect(dispatches).toBe(1); expect(result).toHaveLength(1); expect(result[0]!.evaluation.acceptance).toBe("unavailable");
    }
    expect(executions).toBe(0);
    const independent = await runAttemptSubmissions(DEFAULT_RUNTIMES[1]!, context(), { runtime: async () => runtime(), container: async () => container() });
    expect(independent[0]!.evaluation.acceptance).toBe("passed");
  });
  it("bounds missing output retries to three and uses only original public output plus observed feedback", async () => {
    const prompts: string[] = []; let executions = 0;
    const result = await runAttemptSubmissions(spec, context(), { runtime: async (_spec, prompt) => {
      prompts.push(prompt); const { output: _output, ...rest } = runtime(); return { ...rest, protocolIssues: ["code-response-unavailable"] };
    }, container: async () => { executions += 1; return container(); } });
    expect(result).toHaveLength(3); expect(executions).toBe(0); expect(prompts[1]).toContain("Observed automated feedback"); expect(prompts[1]).not.toContain('"expected"');
    expect(result.every((round) => round.evaluation.acceptance === "unavailable")).toBe(true);
  });
  it("preserves unavailable container execution instead of accepting leftover observations", async () => {
    const result = await runAttemptSubmissions(spec, context(), { runtime: async () => runtime(), container: async () => ({ ...container(), process: { ...container().process, exitCode: 137 } }) });
    expect(result).toHaveLength(1); expect(result[0]!.evaluation.acceptance).toBe("unavailable");
    const thrown = await runAttemptSubmissions(spec, context(), { runtime: async () => runtime(), container: async () => { throw new Error("synthetic infrastructure failure"); } });
    expect(thrown).toHaveLength(1); expect(thrown[0]!.submissionFailure).toBe("container-unavailable");
  });
  it("does not dispatch after cancellation or a failed actual-request isolation gate", async () => {
    let dispatched = 0;
    await expect(runAttemptSubmissions(spec, { ...context(), signal: AbortSignal.abort() }, { runtime: async () => { dispatched += 1; return runtime(); } })).rejects.toThrow(/canceled/);
    const probe: typeof probeCodexIsolation = async () => ({ kind: "synthetic-isolation-probe", available: true, runtime: runtime(), request: { model: "synthetic", instructions: undefined, input: [], tools: [] }, requestSha256: "synthetic", isolation: { approvedShape: false, advertisedTools: ["apply_patch"], issues: ["functional-or-unexpected-tool"] } });
    await expect((async () => { await requireIsolationGate(spec, { probe }); await runAttemptSubmissions(spec, context(), { runtime: async () => { dispatched += 1; return runtime(); } }); })()).rejects.toThrow(/isolation preflight/);
    expect(dispatched).toBe(0);
    const controller = new AbortController(); let executed = 0;
    const result = await runAttemptSubmissions(spec, { ...context(), signal: controller.signal }, { runtime: async () => { controller.abort(); return runtime(); }, container: async () => { executed += 1; return container(); } });
    expect(result).toHaveLength(1); expect(executed).toBe(0);
  });
});
