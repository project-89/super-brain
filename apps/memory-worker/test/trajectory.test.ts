import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { FoldEvent, FoldLogEntry } from "@_89/fold";
import { FoldSdk } from "../../../packages/fold-sdk/dist/index.js";
import { createApiServer, StaticIdentityDirectory } from "../../api/dist/index.js";
import { SuperBrainClient } from "@_89/super-brain-client";
import { CaptureEngine, CaptureReceiptQueue, DurableSpool, HookVault, StateStore, createCapturedTrajectoryVerifier, parseCaptureConfig, receiptEncryptionKey } from "@_89/super-brain-capture-daemon";
import { expect, it } from "vitest";
import { createCapturedEventVerifier } from "../src/authority.js";
import { TranscriptMemoryWorker } from "../src/worker.js";

it("requires exact finalized, acceptance, and checkpoint witnesses, then promotes durably after a late receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-trajectory-"));
  const repository = join(root, "repo"); await mkdir(repository);
  execFileSync("git", ["init", "-q", repository]); await writeFile(join(repository, "file.txt"), "baseline\n");
  execFileSync("git", ["-C", repository, "add", "."]);
  execFileSync("git", ["-C", repository, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "baseline"]);
  const config = parseCaptureConfig({ apiUrl: "http://127.0.0.1:1", organizationId: "local", workspaceId: "workspace", apiToken: "test", sensorId: "urn:sensor:test",
    hookToken: "hook", operatorToken: "operator", stateRoot: join(root, "capture"), vaultRoot: join(root, "vault"), port: 8377, bindHost: "127.0.0.1",
    heartbeatWindowMs: 90_000, heartbeatIntervalMs: 30_000, reasoningPolicy: "include" });
  const key = await receiptEncryptionKey(config);
  const spool = new DurableSpool(config.stateRoot); const state = new StateStore(config.stateRoot);
  const engine = new CaptureEngine(config, state, new HookVault(config.vaultRoot, key), spool); await engine.initialize();
  const queue = new CaptureReceiptQueue(engine, key);
  const common = { session_id: "attempt", cwd: repository };
  const hook = async (id: string, payload: Record<string, unknown>) => { await queue.accept({ version: 1, id, source: "codex", occurredAt: new Date().toISOString(), endpoint: "/hook", payload: { ...common, ...payload } }); await queue.drain(); };
  await hook("prompt", { hook_event_name: "UserPromptSubmit", prompt: "Verify immutable evidence", task_key: "fixed" });
  await hook("checkpoint", { hook_event_name: "ReasoningCheckpoint", summary: "Durable event evidence must retain its original immutable source.", hypothesis: "An immutable source permits independent review." });
  const context = await engine.acceptanceContext("codex", "attempt");
  await queue.accept({ version: 1, id: "approval", source: "codex", occurredAt: new Date().toISOString(), endpoint: "/decision",
    payload: { ...common, hook_event_name: "HumanDecision", summary: "Accepted this exact task and revision", acceptance: { version: 1, taskId: context.taskId, attemptId: context.attemptId, revisionId: context.revisionId, verdict: "success" } } },
    { kind: "local-operator", principalId: "operator:urn:sensor:test", authenticatedAt: new Date().toISOString() });
  await queue.drain(); await hook("stop", { hook_event_name: "Stop" });
  const jobs = (await spool.list()).map(({ job }) => job);
  const captured = jobs.flatMap((job) => job.kind === "event" ? [job.event] : []);
  const trajectory = jobs.find((job) => job.kind === "trajectory");
  if (trajectory?.kind !== "trajectory") throw new Error("missing captured trajectory");
  const checkpoint = captured.find((event) => event.changes.some((change) => change.verb === "create" && change.after.observation === "reasoning_checkpoint"))!;
  const entries: FoldLogEntry[] = [];
  const sdk = new FoldSdk({ async read() { return { entries: [...entries] }; }, async append(entry) { entries.push(entry); } });
  const directory = new StaticIdentityDirectory({ test: { principalId: "worker", author: { kind: "sensor", id: config.sensorId }, workspaces: { workspace: { role: "admin" } } } });
  const server = createApiServer({ authenticator: directory, memberships: directory, sdks: { sdkFor: async () => sdk } });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const client = new SuperBrainClient({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, workspaceId: "workspace", token: "test" });
  const authority = { stateRoot: config.stateRoot, vaultRoot: config.vaultRoot, receiptEncryptionKey: key, vaultEncryptionKey: key, organizationId: "local", workspaceId: "workspace", trustedSensorId: config.sensorId };
  const verifyCapturedEvent = createCapturedEventVerifier(authority), verifyCapturedTrajectory = createCapturedTrajectoryVerifier(authority);
  let now = Date.now() + 1_000;
  const options = { client, vaultRoot: config.vaultRoot, stateRoot: join(root, "worker"), autoPromote: true, verifyCapturedEvent, verifyCapturedTrajectory, now: () => now, retryBaseMs: 1 };
  let worker = new TranscriptMemoryWorker(options);
  try {
    for (const event of captured.sort((a, b) => a.at.t - b.at.t)) await client.appendEvent(event);
    await client.recordTrajectoryTree(trajectory.treeStamp, trajectory.tree, { captureIdentity: trajectory.captureIdentity });
    const canonical = (await client.recordTrajectory(trajectory.runStamp, trajectory.input, { captureIdentity: trajectory.captureIdentity })).event;
    expect(await verifyCapturedTrajectory(canonical)).toBe(true);
    expect(await worker.processLiveEvent(checkpoint)).toMatchObject({ proposed: 1, promoted: 0 });
    const forged = structuredClone(canonical) as FoldEvent;
    const raw = forged.changes[0];
    if (raw?.verb !== "create") throw new Error("unexpected event");
    (raw.after as any).trajectory.steps.find((step: any) => step.eventId === checkpoint.id).content = "Invented checkpoint content";
    expect(await verifyCapturedTrajectory(forged)).toBe(false);
    expect(await worker.promoteSuccessfulTrajectoryEvidence(forged)).toMatchObject({ promoted: 0, deferredReason: "trajectory-witness-unavailable" });
    const witnessPath = join(config.stateRoot, "receipts", "receiver", "completed", `${createHash("sha256").update("stop").digest("hex")}.json.enc`);
    const witness = await readFile(witnessPath); await unlink(witnessPath);
    expect(await worker.promoteSuccessfulTrajectoryEvidence(canonical)).toMatchObject({ promoted: 0, deferredReason: "trajectory-witness-unavailable" });
    await worker.close(); await writeFile(witnessPath, witness); now += 10;
    worker = new TranscriptMemoryWorker(options);
    expect((await worker.drainJobs()).promoted).toBe(1);
    const candidate = (await client.memoryCandidates()).find(({ candidate }) => candidate.source === "live-reasoning-checkpoint")!;
    expect(candidate.status).toBe("accepted");
    expect(candidate.candidate.evidence.map(({ eventId }) => eventId)).toEqual(expect.arrayContaining([checkpoint.id, canonical.id, trajectory.input.manifest!.attempt.acceptance!.eventId]));
    expect((await worker.promoteSuccessfulTrajectoryEvidence(canonical)).promoted).toBe(0);
  } finally { await worker.close(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});
