import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeTrajectoryRecordedEvent, traceRuntimeObservationSchema, trajectoryLogRecordsFromEvent } from "@_89/fold-trajectory";
import { ensureVaultKey, RecordAnonymizer } from "@_89/super-brain-importer";
import { CaptureEngine, CaptureReceiptQueue, DurableSpool, HookVault, StateStore, captureAttemptContext, captureRuntimeObservation, createCapturedTrajectoryVerifier, gitBytes, nativeRuntimeObservation, parseCaptureConfig, readCompletedCaptureReceipt, type HookAuthority } from "../src/index.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "capture-attempt-")); const repository = join(root, "repo"); await mkdir(repository);
  await gitBytes(repository, ["init", "--quiet"]); await writeFile(join(repository, "file.txt"), "initial\n"); await gitBytes(repository, ["add", "."]);
  await gitBytes(repository, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--quiet", "-m", "initial"]);
  const { key } = await ensureVaultKey(join(root, "vault.key")); const anonymizer = new RecordAnonymizer("pseudonymous", key);
  const config = parseCaptureConfig({ apiUrl: "http://127.0.0.1:1", organizationId: "tenant-a", workspaceId: "workspace-a", apiToken: "test", sensorId: "urn:sensor:test", hookToken: "hook", operatorToken: "operator",
    stateRoot: join(root, "state"), vaultRoot: join(root, "vault"), vaultKeyPath: join(root, "vault.key"), anonymizationPolicy: "pseudonymous", anonymizationKeyPath: join(root, "vault.key"),
    port: 8377, bindHost: "127.0.0.1", heartbeatWindowMs: 90_000, heartbeatIntervalMs: 30_000, reasoningPolicy: "exclude" });
  const state = new StateStore(config.stateRoot); const spool = new DurableSpool(config.stateRoot); const vault = new HookVault(config.vaultRoot, key, { anonymizer });
  const engine = new CaptureEngine(config, state, vault, spool, anonymizer); await engine.initialize(); const queue = new CaptureReceiptQueue(engine, key);
  let occurrence = 0;
  const hook = async (hook_event_name: string, data: Record<string, unknown> = {}, authority?: HookAuthority) => { const id = `occurrence-${++occurrence}`;
    await queue.accept({ version: 1, id, source: "codex", endpoint: hook_event_name === "HumanDecision" ? "/decision" : "/hook", occurredAt: new Date().toISOString(), payload: { session_id: "session", cwd: repository, hook_event_name, ...data } }, authority); await queue.drain(); return id;
  };
  const authority: HookAuthority = { kind: "local-operator", principalId: "operator:urn:sensor:test", authenticatedAt: new Date().toISOString() };
  const verifyOptions = { stateRoot: config.stateRoot, receiptEncryptionKey: key, trustedSensorId: config.sensorId, organizationId: config.organizationId, workspaceId: config.workspaceId };
  return { root, repository, config, key, anonymizer, state, spool, vault, engine, queue, hook, authority, verifyOptions };
}

describe("attempt provenance and finalized command witnesses", () => {
  it("retains original start state across edits/restart and attests exact finalized public acceptance", async () => {
    const f = await fixture();
    await f.hook("UserPromptSubmit", { prompt: "A private task prompt", task_goal: "Fix the regression", model: "native-model", task_key: "task", context: { memoryRefs: [{ memoryId: "memory:canonical", revision: 0 }] }, condition_id: "condition-a" });
    const start = Object.values((await f.state.load()).sessions)[0]!.manifest!;
    await writeFile(join(f.repository, "file.txt"), "modified\n");
    await f.hook("ReasoningCheckpoint", { summary: "Invalidate cached values before retrying", turn_id: "turn-a" });
    await f.hook("PreCompact");
    const acceptance = await f.engine.acceptanceContext("codex", "session"); expect(acceptance.revisionId).not.toEqual(start.attempt.startRevision.revisionId);
    await f.hook("HumanDecision", { summary: "Accepted this exact revision", acceptance: { version: 1, taskId: acceptance.taskId, attemptId: acceptance.attemptId, revisionId: acceptance.revisionId, verdict: "success" } }, f.authority);
    const restarted = new CaptureEngine(f.config, f.state, f.vault, f.spool, f.anonymizer); await restarted.initialize();
    expect(Object.values((await f.state.load()).sessions)[0]!.manifest).toEqual(start);
    const queue = new CaptureReceiptQueue(restarted, f.key); const receiptId = "finalization";
    await queue.accept({ version: 1, id: receiptId, source: "codex", endpoint: "/hook", occurredAt: new Date().toISOString(), payload: { session_id: "session", cwd: f.repository, hook_event_name: "Stop", usage: { input_tokens: 0, output_tokens: 10 } } }); await queue.drain();
    const job = (await f.spool.list()).map(({ job }) => job).find((job) => job.kind === "trajectory")!;
    if (job.kind !== "trajectory") throw new Error("missing trajectory");
    expect(job.input.manifest?.attempt.startRevision).toEqual(start.attempt.startRevision);
    expect(job.input.manifest?.attempt.finalRevision?.revisionId).toBe(acceptance.revisionId);
    expect(job.input.manifest?.attempt.acceptance).toMatchObject({ taskId: acceptance.taskId, attemptId: acceptance.attemptId, revisionId: acceptance.revisionId, verdict: "success" });
    expect(job.input.manifest?.attempt.context?.memoryRefs).toEqual([{ memoryId: "memory:canonical", revision: 0 }]);
    expect(job.input.manifest?.attempt.context?.lineage?.[0]?.kind).toBe("compaction");
    expect(job.input.outcome).toBe("success"); expect(Object.values(job.input.assignments).every((value) => value.kind === "mapped" && value.method.basis === "structural")).toBe(true);
    expect(JSON.stringify(job.input)).not.toContain("A private task prompt"); expect(JSON.stringify(job.input)).not.toContain(f.repository); expect(JSON.stringify(job.input)).not.toContain("git:");
    const event = makeTrajectoryRecordedEvent({ access: { principalId: "capture-service", workspaceId: f.config.workspaceId, workspaceRole: "owner", spaceRoles: {} }, author: { kind: "agent", id: "capture-service" }, capture: { scope: { workspace: f.config.workspaceId }, identity: { ...job.captureIdentity, principal: "capture-service", workspace: f.config.workspaceId } } }, job.runStamp, job.tree, job.input);
    const verify = createCapturedTrajectoryVerifier(f.verifyOptions); expect(await verify(event)).toBe(true);
    const receipt = await readCompletedCaptureReceipt({ stateRoot: f.config.stateRoot, receiptId, encryptionKey: f.key }); expect(receipt?.trajectoryWitnesses?.[event.id]).toBeDefined(); expect(receipt?.prepared).toBeUndefined();
    for (const mutation of [
      (value: any) => { value.changes[0].after.trajectory.steps[1].content = "Forged checkpoint"; },
      (value: any) => { value.changes[0].after.trajectory.manifest.attempt.finalRevision.revisionId = "revision:forged"; },
      (value: any) => { value.changes[0].after.trajectory.manifest.attempt.acceptance.eventId = "forged"; },
      (value: any) => { value.id = "copied-approval-trajectory"; },
      (value: any) => { value.capture.identity.receiptId = "missing"; value.changes[0].after.trajectory.capture = value.capture; },
      (value: any) => { value.capture.identity.organization = "forged-extra-identity"; value.changes[0].after.trajectory.capture = value.capture; },
    ]) { const changed = structuredClone(event); mutation(changed); expect(await verify(changed)).toBe(false); }
    expect(await createCapturedTrajectoryVerifier({ ...f.verifyOptions, receiptEncryptionKey: new Uint8Array(32) })(event)).toBe(false);
    const { receiptEncryptionKey: _key, ...missingKey } = f.verifyOptions; expect(await createCapturedTrajectoryVerifier(missingKey)(event)).toBe(false);
    expect(await createCapturedTrajectoryVerifier({ ...f.verifyOptions, trustedSensorId: "urn:sensor:other" })(event)).toBe(false);
    expect(trajectoryLogRecordsFromEvent(event)[0]).toMatchObject({ trajectory: { manifest: job.input.manifest } });
  });

  it("does not carry accepted success across an unhooked edit before finalization", async () => {
    const f = await fixture(); await f.hook("UserPromptSubmit", { prompt: "task" }); const expected = await f.engine.acceptanceContext("codex", "session");
    await f.hook("HumanDecision", { summary: "accepted", acceptance: { version: 1, taskId: expected.taskId, attemptId: expected.attemptId, revisionId: expected.revisionId, verdict: "success" } }, f.authority);
    await writeFile(join(f.repository, "file.txt"), "unreviewed\n"); await f.hook("Stop");
    const job = (await f.spool.list()).map(({ job }) => job).find((job) => job.kind === "trajectory");
    expect(job).toMatchObject({ input: { outcome: "unknown" } }); if (job?.kind === "trajectory") expect(job.input.manifest?.attempt.acceptance).toBeUndefined();
  });

  it("invalidates acceptance when hidden tracked changes bypass Git status", async () => {
    for (const hiding of ["assume-unchanged", "skip-worktree", "ignored-mode"] as const) {
      const f = await fixture(); await f.hook("UserPromptSubmit", { prompt: "review" }); const expected = await f.engine.acceptanceContext("codex", "session");
      await f.hook("HumanDecision", { summary: "accepted", acceptance: { version: 1, taskId: expected.taskId, attemptId: expected.attemptId, revisionId: expected.revisionId, verdict: "success" } }, f.authority);
      if (hiding === "ignored-mode") await gitBytes(f.repository, ["config", "core.filemode", "false"]);
      else await gitBytes(f.repository, ["update-index", `--${hiding}`, "file.txt"]);
      await writeFile(join(f.repository, "file.txt"), "hidden unreviewed change\n");
      expect((await f.engine.acceptanceContext("codex", "session")).fingerprintStatus).toBe("unavailable");
      await f.hook("Stop");
      const job = (await f.spool.list()).map(({ job }) => job).find((job) => job.kind === "trajectory");
      expect(job).toMatchObject({ input: { outcome: "unknown", manifest: { attempt: { finalRevision: { fingerprintStatus: "unavailable" } } } } });
      if (job?.kind === "trajectory") expect(job.input.manifest?.attempt.acceptance).toBeUndefined();
    }
  }, 15_000);

  it("keeps observed zero usage, excludes invalid metadata and leaves an unreported model absent", () => {
    const runtime = captureRuntimeObservation("codex", { authority: "native", runtime: { provenance: "native" }, settings: { temperature: 8, top_p: -1, max_output_tokens: 0 }, usage: { input_tokens: 0, output_tokens: -1, reasoning_tokens: NaN, cost: { amount: 9, currency: "usd" } } });
    expect(traceRuntimeObservationSchema.safeParse(runtime).success).toBe(true);
    expect(runtime).toMatchObject({ provenance: "hook-reported", settings: { maxOutputTokens: 0 }, usage: { inputTokens: 0 } }); expect(runtime.modelId).toBeUndefined(); expect(runtime.settings?.temperature).toBeUndefined(); expect(runtime.usage?.cost).toBeUndefined();
    expect(captureAttemptContext({ context: { memoryRefs: [{ memoryId: "memory", revision: 0 }, { memoryId: "invalid", revision: -1 }] } })?.memoryRefs).toEqual([{ memoryId: "memory", revision: 0 }]);
    expect(nativeRuntimeObservation("codex", { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100 } } } })).toBeUndefined();
    expect(nativeRuntimeObservation("codex", { type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 0, output_tokens: 20 } } } })?.runtime).toMatchObject({ provenance: "native", usage: { inputTokens: 0, outputTokens: 20 } });
  });

  it("captures native model/usage even with reasoning excluded and keeps source prompt text private", async () => {
    const f = await fixture(); const transcript = join(f.root, "source.jsonl");
    await writeFile(transcript, [
      { type: "turn_context", payload: { model: "observed-model", turn_id: "native-turn", effort: "high" } },
      { type: "response_item", payload: { type: "reasoning", summary: [{ text: "PRIVATE REASONING MUST STAY OUT" }] } },
      { type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 0, output_tokens: 12, cached_input_tokens: 0 } } } },
    ].map((record) => JSON.stringify(record)).join("\n") + "\n");
    await f.hook("UserPromptSubmit", { prompt: "private prompt", transcript_path: transcript }); await f.hook("Stop");
    const job = (await f.spool.list()).map(({ job }) => job).find((job) => job.kind === "trajectory");
    if (job?.kind !== "trajectory") throw new Error("missing trajectory");
    expect(job.input.model.id).toBe("observed-model"); expect(job.input.steps.some((step) => step.runtime?.provenance === "native" && step.runtime.usage?.inputTokens === 0)).toBe(true);
    expect(JSON.stringify(job.input)).not.toContain("PRIVATE REASONING MUST STAY OUT");
  });

  it("records one hook usage report when a tool result produces several derived steps", async () => {
    const f = await fixture(); await f.hook("UserPromptSubmit", { prompt: "check task" });
    await f.hook("PostToolUse", { tool_name: "exec_command", tool_input: { command: "pnpm test" }, tool_response: { exit_code: 0 }, usage: { input_tokens: 3, output_tokens: 5, cost: { amount: 0, currency: "USD" } } });
    await f.hook("Stop");
    const job = (await f.spool.list()).map(({ job }) => job).find((job) => job.kind === "trajectory"); if (job?.kind !== "trajectory") throw new Error("missing trajectory");
    expect(job.input.steps.filter((step) => step.role === "tool_call_response")).toHaveLength(2);
    const reports = job.input.steps.filter((step) => step.runtime?.usage !== undefined);
    expect(reports).toHaveLength(1); expect(reports[0]).toMatchObject({ content: "Hook runtime usage reported", eventId: expect.any(String), runtime: { usageInterpretation: "unknown", usageScope: "unknown", usage: { inputTokens: 3, outputTokens: 5, cost: { amount: 0, currency: "USD" } } } });
  });
});
