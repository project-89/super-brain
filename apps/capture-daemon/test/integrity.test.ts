import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import {
  CaptureEngine, CaptureHttpServer, CaptureReceiptQueue, DurableSpool, HookOutbox, HookVault, StateStore,
  capturedEventDigest, deliverOccurrence, mergeRecoveredSteps, normalizeHookEvidence, parseCaptureConfig, receiptEncryptionKey,
  recoverCapturedSteps, type CaptureReceipt, type HookAuthority,
} from "../src/index.js";

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "capture-integrity-"));
  const config = { ...parseCaptureConfig({ apiUrl: "http://127.0.0.1:3003", workspaceId: "workspace-a", apiToken: "api-token",
    sensorId: "urn:sensor:test", hookToken: "hook-token", operatorToken: "operator-token", stateRoot: join(root, "state"),
    vaultRoot: join(root, "vault"), port: 8377, bindHost: "127.0.0.1", heartbeatWindowMs: 90_000, heartbeatIntervalMs: 30_000, orphanAfterMs: 86_400_000, reasoningPolicy: "exclude" }), port: 0 };
  const key = await receiptEncryptionKey(config);
  const spool = new DurableSpool(config.stateRoot);
  const state = new StateStore(config.stateRoot);
  const vault = new HookVault(config.vaultRoot, key);
  const engine = new CaptureEngine(config, state, vault, spool);
  await engine.initialize();
  return { root, config, key, spool, state, vault, engine, queue: new CaptureReceiptQueue(engine, key) };
}
const authority: HookAuthority = { kind: "local-operator", principalId: "operator:urn:sensor:test", authenticatedAt: "2026-09-01T00:00:00.000Z" };

it("keeps failed tests and later successful lint as individual checks with unknown task acceptance", async () => {
  const { engine, state, spool, root } = await setup();
  const common = { session_id: "checks", cwd: root, turn_id: "turn-a" };
  await engine.ingest("codex", { ...common, hook_event_name: "UserPromptSubmit", prompt: "verify task" });
  for (const [command, result] of [["pnpm test", { exit_code: 1 }], ["pnpm lint", { exit_code: 0 }], ["pnpm build", undefined]] as const) {
    await engine.ingest("codex", { ...common, hook_event_name: "PostToolUse", tool_name: "exec_command", tool_input: { command }, ...(result === undefined ? {} : { tool_response: result }) });
  }
  await engine.ingest("codex", { ...common, hook_event_name: "Stop" });
  expect(Object.values((await state.load()).sessions)[0]?.checks?.map(({ result }) => result)).toEqual(["failure", "success", "unknown"]);
  expect((await spool.list()).find(({ job }) => job.kind === "trajectory")?.job).toMatchObject({ input: { outcome: "unknown" } });
});

it("normalizes live and recovered results identically and corrects legacy guessed success", async () => {
  const { engine, vault, state, root } = await setup();
  const common = { session_id: "parity", cwd: root, turn_id: "turn-a" };
  await engine.ingest("codex", { ...common, hook_event_name: "UserPromptSubmit", prompt: "check" });
  await engine.ingest("codex", { ...common, hook_event_name: "PreToolUse", tool_name: "exec_command", tool_use_id: "call", tool_input: { command: "pnpm test" } });
  await engine.ingest("codex", { session_id: "parity", cwd: root, hook_event_name: "PostToolUse", tool_name: "exec_command", tool_use_id: "call", tool_input: { command: "pnpm test" } });
  const recovered = recoverCapturedSteps(await vault.sessionArtifacts("codex", "parity"));
  const session = Object.values((await state.load()).sessions)[0]!;
  const steps = (await engine.stepStore.synchronize(session)).steps;
  expect(recovered.map(({ role, content, turnId }) => ({ role, content, turnId }))).toEqual(steps.map(({ role, content, turnId }) => ({ role, content, turnId })));
  const legacy = recovered.map((step) => ({ ...step, content: step.content.replace("result unknown", "completed").replace("verification unknown", "verification passed") }));
  const merged = mergeRecoveredSteps(legacy, recovered);
  expect(merged.steps.map(({ content }) => content)).toEqual(recovered.map(({ content }) => content));
  expect(normalizeHookEvidence({ hook_event_name: "PostToolUse", success: true, result: { exitCode: 1 } }).result).toBe("failure");
});

it("rejects forged human ingress through every route and ignores caller-picked authority", async () => {
  const { engine, config, spool, root, queue } = await setup();
  const server = new CaptureHttpServer(config, engine, spool);
  const address = await server.start();
  const url = `http://${address.host}:${address.port}`;
  const common = { session_id: "decision", cwd: root, hook_event_name: "HumanDecision", summary: "approved", verdict: "success", authority };
  try {
    for (const path of ["/hook", "/decision"]) {
      const response = await fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-super-brain-hook-token": config.hookToken }, body: JSON.stringify(common) });
      expect(response.status).toBe(401);
    }
    await expect(engine.ingest("codex", common)).rejects.toThrow("operator authority");
    const response = await fetch(`${url}/decision`, { method: "POST", headers: { "content-type": "application/json", "x-super-brain-operator-token": config.operatorToken }, body: JSON.stringify(common) });
    expect(response.status).toBe(202);
    await server.close();
    const events = (await spool.list()).flatMap(({ job }) => job.kind === "event" ? [job.event] : []);
    const observation = events.flatMap((event) => event.changes).find((change) => change.verb === "create" && change.after.observation === "human_decision");
    expect(observation).toMatchObject({ after: { data: { authority: { principalId: "operator:urn:sensor:test", kind: "local-operator" } } } });
    expect(JSON.stringify(observation)).not.toContain('"verdict":"success"');
  } finally { await server.close(); }
});

it("does not assert offline or host heartbeat merely from daemon timers", async () => {
  const { engine, spool, root } = await setup();
  await engine.ingest("codex", { session_id: "idle", cwd: root, hook_event_name: "SessionStart" });
  await engine.heartbeat(Date.now() + engine.config.orphanAfterMs + 1);
  const events = (await spool.list()).flatMap(({ job }) => job.kind === "event" ? [job.event] : []);
  expect(events.flatMap((event) => event.lifecycle?.phase ?? [])).toEqual(["online"]);
  expect(JSON.stringify(events)).toContain('"liveness":"unknown"');
});

it("durably acknowledges before blocked processing and keeps identical occurrences distinct", async () => {
  const { engine, config, spool, root, queue, key } = await setup();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const original = engine.processReceipt.bind(engine);
  const process = vi.spyOn(engine, "processReceipt").mockImplementation(async (...args) => { await gate; return original(...args); });
  const server = new CaptureHttpServer(config, engine, spool);
  const address = await server.start();
  const url = `http://${address.host}:${address.port}/hook`;
  const payload = { session_id: "burst", cwd: root, hook_event_name: "ReasoningCheckpoint", summary: "Private correction token=abcdefghijklmnop" };
  try {
    const send = (id: string) => fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-super-brain-hook-token": config.hookToken, "x-super-brain-receipt-id": id }, body: JSON.stringify(payload) }).then(async (r) => { expect(r.status).toBe(202); return r.json(); });
    const accepted = await Promise.all(Array.from({ length: 8 }, (_, i) => send(`occurrence-${i}`)));
    expect(new Set(accepted.map((r) => r.artifactId)).size).toBe(8);
    expect(await send("occurrence-0")).toEqual(accepted[0]);
    expect((await queue.list()).length).toBe(8);
    expect((await spool.list()).length).toBe(0);
    const files = await readdir(join(config.stateRoot, "receipts", "receiver"));
    const bytes = await readFile(join(config.stateRoot, "receipts", "receiver", files[0]!), "utf8");
    expect(bytes).not.toContain("Private correction");
    expect(bytes).not.toContain("abcdefghijklmnop");
    release();
    await server.close();
    process.mockRestore();
    await queue.drain();
    expect((await queue.snapshot()).completed).toBe(8);
    const count = engine.snapshot().receivedHooks;
    const occurrence = { version: 1 as const, id: "occurrence-0", source: "unknown" as const, occurredAt: new Date().toISOString(), endpoint: "/hook" as const, payload };
    expect(await queue.accept(occurrence)).toEqual(accepted[0]);
    await queue.drain();
    expect(engine.snapshot().receivedHooks).toBe(count);
    expect((await queue.list()).length).toBe(0);
  } finally { release(); await server.close(); }
});

it("retains the redacted encrypted sender payload through downtime and a lost acknowledgement", async () => {
  const { config, key, engine, spool, root } = await setup();
  const outbox = new HookOutbox(config.stateRoot, key);
  const occurrence = await outbox.persist("codex", { session_id: "sender", cwd: root, hook_event_name: "SessionStart", secret: "token=abcdefghijklmnop" }, "/hook", "retry-forever");
  await expect(deliverOccurrence(config, outbox, occurrence, vi.fn(async () => { throw new Error("offline"); }))).rejects.toThrow("offline");
  expect((await outbox.pending())[0]).toMatchObject({ id: occurrence.id, payload: { secret: expect.not.stringContaining("abcdefghijklmnop") } });
  const server = new CaptureHttpServer(config, engine, spool);
  const address = await server.start();
  const local = { ...config, port: address.port };
  try {
    const lostAck: typeof fetch = async (...args) => { await fetch(...args); throw new Error("lost acknowledgement"); };
    await expect(deliverOccurrence(local, outbox, occurrence, lostAck)).rejects.toThrow("lost acknowledgement");
    expect(await outbox.pending()).toHaveLength(1);
    await deliverOccurrence(local, outbox, (await outbox.pending())[0]!);
    expect(await outbox.pending()).toHaveLength(0);
    await server.close();
    expect(engine.snapshot().receivedHooks).toBe(1);
  } finally { await server.close(); }
});

it("recovers a prepared receipt after a crash between state and spool publication without new event identities", async () => {
  const { engine, config, spool, state, vault, root, queue, key } = await setup();
  const occurrence = { version: 1 as const, id: "crash-receipt", source: "codex" as const, occurredAt: new Date().toISOString(), endpoint: "/hook" as const,
    payload: { session_id: "crash", cwd: root, hook_event_name: "ReasoningCheckpoint", summary: "Remember this" } };
  const accepted = await queue.accept(occurrence);
  const fail = vi.spyOn(spool, "enqueue").mockRejectedValueOnce(new Error("simulated publication crash"));
  await queue.drain();
  const pending = (await queue.list())[0]!;
  expect(pending.status).toBe("prepared");
  const expectedIds = pending.prepared!.jobs.map((job) => job.id);
  fail.mockRestore();
  const restarted = new CaptureEngine(config, state, vault, spool);
  await restarted.initialize();
  const resumed = new CaptureReceiptQueue(restarted, key);
  expect((await resumed.snapshot()).completed).toBe(1);
  const { decryptVaultLine } = await import("@_89/super-brain-importer");
  const completedRoot = join(config.stateRoot, "receipts", "receiver", "completed");
  const completedPath = join(completedRoot, (await readdir(completedRoot))[0]!);
  const witness = JSON.parse(decryptVaultLine((await readFile(completedPath, "utf8")).trim(), key)) as CaptureReceipt;
  for (const job of pending.prepared!.jobs) if (job.kind === "event") expect(witness.eventDigests?.[job.event.id]).toBe(capturedEventDigest(job.event));
  expect(witness.prepared).toBeUndefined();
  expect((await spool.list()).map(({ job }) => job.id)).toEqual(expectedIds);
  expect(await resumed.accept(occurrence)).toEqual(accepted);
  await resumed.drain();
  expect(restarted.snapshot().receivedHooks).toBe(1);
  expect((await spool.list()).map(({ job }) => job.id)).toEqual(expectedIds);
});

it("accepts only an operator verdict bound to the active task, attempt and freshly observed revision", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { repositoryRevisionId } = await import("../src/index.js");
  const { engine, config, root, state, spool } = await setup();
  const repository = join(root, "repo");
  await mkdir(repository);
  execFileSync("git", ["init", "-q", repository]);
  await writeFile(join(repository, "file.txt"), "initial\n");
  execFileSync("git", ["-C", repository, "add", "file.txt"]);
  execFileSync("git", ["-C", repository, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "initial"]);
  const common = { session_id: "accepted", cwd: repository };
  await engine.ingest("codex", { ...common, hook_event_name: "UserPromptSubmit", prompt: "review", task_key: "fixed" });
  const session = Object.values((await state.load()).sessions)[0]!;
  const acceptance = { version: 1, taskId: `capture-task-v2:${session.project.id}:${session.comparisonKey}`, attemptId: "trajectory:codex:accepted:unit-1",
    revisionId: repositoryRevisionId(session.project), verdict: "success" };
  await expect(engine.ingest("codex", { ...common, hook_event_name: "HumanDecision", summary: "Wrong attempt", acceptance: { ...acceptance, attemptId: "other" } }, authority)).rejects.toThrow("active task, attempt");
  await engine.ingest("codex", { ...common, hook_event_name: "HumanDecision", summary: "Accepted revision", acceptance }, authority);
  await engine.ingest("codex", { ...common, hook_event_name: "Stop" });
  expect((await spool.list()).find(({ job }) => job.kind === "trajectory")?.job).toMatchObject({ input: { outcome: "success" } });
  await engine.ingest("codex", { ...common, hook_event_name: "UserPromptSubmit", prompt: "review new work", task_key: "fixed" });
  await writeFile(join(repository, "file.txt"), "changed\n");
  await expect(engine.ingest("codex", { ...common, hook_event_name: "HumanDecision", summary: "Stale revision", acceptance: { ...acceptance, attemptId: "trajectory:codex:accepted:unit-2" } }, authority)).rejects.toThrow("current repository revision");
});

it("preserves receipt order through a retryable failure before preparation", async () => {
  const { queue, engine, root, spool } = await setup();
  const occurrence = (id: string, hook_event_name: string) => ({ version: 1 as const, id, source: "codex" as const, occurredAt: new Date().toISOString(), endpoint: "/hook" as const,
    payload: { session_id: "ordered", cwd: root, hook_event_name, summary: "Evidence belongs before Stop" } });
  await queue.accept(occurrence("first", "ReasoningCheckpoint"));
  await queue.accept(occurrence("second", "Stop"));
  const failure = vi.spyOn(engine, "processReceipt").mockRejectedValueOnce(new Error("transient evidence read failure"));
  await queue.drain();
  expect(engine.snapshot().receivedHooks).toBe(0);
  expect(await queue.list()).toHaveLength(2);
  failure.mockRestore();
  await queue.drain();
  const trajectory = (await spool.list()).find(({ job }) => job.kind === "trajectory")?.job;
  expect(trajectory).toMatchObject({ input: { steps: expect.arrayContaining([expect.objectContaining({ content: "Evidence belongs before Stop" })]) } });
  expect(engine.snapshot().receivedHooks).toBe(2);
});

it("seeds receipt event time from committed and pending evidence across restart", async () => {
  const { queue, engine, config, state, vault, spool, root, key } = await setup();
  const fixed = vi.spyOn(Date, "now").mockReturnValue(Date.now());
  try {
    for (let i = 0; i < 6; i++) await queue.accept({ version: 1, id: `frozen-${i}`, source: "codex", occurredAt: new Date().toISOString(), endpoint: "/hook",
      payload: { session_id: "clock", cwd: root, hook_event_name: "SessionStart" } });
    const pendingMax = (await queue.list()).at(-1)!.artifact.eventTime;
    await queue.drain();
    const restarted = new CaptureEngine(config, state, vault, spool);
    await restarted.initialize();
    const resumed = new CaptureReceiptQueue(restarted, key);
    await resumed.accept({ version: 1, id: "after-restart", source: "codex", occurredAt: new Date().toISOString(), endpoint: "/hook",
      payload: { session_id: "clock", cwd: root, hook_event_name: "Stop" } });
    expect((await resumed.list())[0]!.artifact.eventTime).toBeGreaterThan(pendingMax);
  } finally { fixed.mockRestore(); }
});
