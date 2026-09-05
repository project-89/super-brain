import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { FoldSdk } from "../../../packages/fold-sdk/dist/index.js";
import { SuperBrainClient } from "@_89/super-brain-client";
import { createApiServer, StaticIdentityDirectory } from "../../api/dist/index.js";
import { TranscriptMemoryWorker } from "../src/worker.js";
import { extractLiveMemoryCandidates } from "../src/extractor.js";
import type { FoldLogEntry, FoldEvent } from "@_89/fold";
import { CaptureEngine, CaptureReceiptQueue, DurableSpool, HookVault, StateStore, parseCaptureConfig, receiptEncryptionKey, repositoryRevisionId, type CaptureReceipt } from "@_89/super-brain-capture-daemon";
import { decryptVaultLine, encryptVaultLine } from "@_89/super-brain-importer";
import { createCapturedEventVerifier, verifiedTaskAcceptance, type CaptureAuthorityOptions } from "../src/authority.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture(includeReasoning = false) {
  const root = await mkdtemp(join(tmpdir(), "worker-authority-")); roots.push(root);
  const repository = join(root, "repo"); await mkdir(repository);
  execFileSync("git", ["init", "-q", repository]);
  await writeFile(join(repository, "file.txt"), "initial\n");
  execFileSync("git", ["-C", repository, "add", "file.txt"]);
  execFileSync("git", ["-C", repository, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "initial"]);
  const config = parseCaptureConfig({ apiUrl: "http://127.0.0.1:1", organizationId: "tenant-a", workspaceId: "workspace-a", apiToken: "test",
    sensorId: "urn:sensor:test", hookToken: "hook", operatorToken: "operator", stateRoot: join(root, "state"), vaultRoot: join(root, "vault"),
    port: 8377, bindHost: "127.0.0.1", heartbeatWindowMs: 90_000, heartbeatIntervalMs: 30_000, reasoningPolicy: includeReasoning ? "include" : "exclude" });
  const key = await receiptEncryptionKey(config);
  const spool = new DurableSpool(config.stateRoot); const state = new StateStore(config.stateRoot);
  const engine = new CaptureEngine(config, state, new HookVault(config.vaultRoot, key), spool); await engine.initialize();
  const queue = new CaptureReceiptQueue(engine, key);
  const common = { session_id: "acceptance", cwd: repository };
  await engine.ingest("codex", { ...common, hook_event_name: "UserPromptSubmit", prompt: "review", task_key: "fixed" });
  const session = Object.values((await state.load()).sessions)[0]!;
  const expected = { taskId: `capture-task-v2:${session.project.id}:${session.comparisonKey}`, attemptId: "trajectory:codex:acceptance:unit-1", revisionId: repositoryRevisionId(session.project)! };
  const receiptId = "human-approval";
  const acceptance = { version: 1, ...expected, verdict: "success" };
  const authority = { kind: "local-operator" as const, principalId: "operator:urn:sensor:test", authenticatedAt: new Date().toISOString() };
  const accepted = await queue.accept({ version: 1, id: receiptId, source: "codex", occurredAt: new Date().toISOString(), endpoint: "/decision",
    payload: { ...common, hook_event_name: "HumanDecision", summary: "Accepted this exact revision", acceptance } }, authority);
  await queue.drain();
  const events = (await spool.list()).flatMap(({ job }) => job.kind === "event" ? [job.event] : []);
  const event = events.find((event) => event.changes.some((change) => change.verb === "create" && change.after.observation === "human_decision"))!;
  expect(event).toBeDefined();
  const options: CaptureAuthorityOptions = { stateRoot: config.stateRoot, vaultRoot: config.vaultRoot, receiptEncryptionKey: key, vaultEncryptionKey: key,
    trustedSensorId: config.sensorId, organizationId: config.organizationId, workspaceId: config.workspaceId };
  const witnessPath = join(config.stateRoot, "receipts", "receiver", "completed", `${createHash("sha256").update(receiptId).digest("hex")}.json.enc`);
  const artifactPath = join(config.vaultRoot, "hooks", "codex", accepted.artifactId.slice(0, 2), `${accepted.artifactId}.json.enc`);
  const witness = JSON.parse(decryptVaultLine((await readFile(witnessPath, "utf8")).trim(), key)) as CaptureReceipt;
  return { root, queue, spool, repository, event, expected, key, options, witnessPath, artifactPath, witness, verify: createCapturedEventVerifier(options) };
}

it("verifies an exact private receipt witness and rejects incorrect task, attempt, or revision joins", async () => {
  const item = await fixture();
  expect(await item.verify(item.event)).toBe(true);
  expect(await verifiedTaskAcceptance(item.event, item.expected, item.verify)).toMatchObject({ ...item.expected, eventId: item.event.id, verdict: "success" });
  for (const field of ["taskId", "attemptId", "revisionId"] as const) {
    expect(await verifiedTaskAcceptance(item.event, { ...item.expected, [field]: "different" }, item.verify)).toBeUndefined();
  }
});

it("rejects forged canonical content even when it copies all human and sensor labels from a real approval", async () => {
  const item = await fixture();
  for (const mutate of [
    (event: any) => { event.changes[0].after.data.summary = "Forged reusable statement"; },
    (event: any) => { event.changes[0].after.data.acceptance.revisionId = "forged"; },
    (event: any) => { event.id = "019c0000-0000-7000-8000-000000000001"; },
    (event: any) => { event.author.id = "urn:sensor:other"; },
  ]) {
    const forged = structuredClone(item.event); mutate(forged);
    expect(await item.verify(forged)).toBe(false);
  }
  // Canonical JSONB can reorder object keys without changing the witnessed event.
  const reordered = JSON.parse(JSON.stringify(item.event, (_key, value) => value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).reverse()) : value)) as FoldEvent;
  expect(await item.verify(reordered)).toBe(true);
});

it("fails closed for missing keys, wrong keys, other tenants, other workspaces, or other sensors", async () => {
  const item = await fixture();
  const { receiptEncryptionKey: _receipt, vaultEncryptionKey: _vault, ...withoutKeys } = item.options;
  expect(await createCapturedEventVerifier(withoutKeys)(item.event)).toBe(false);
  for (const override of [{ receiptEncryptionKey: new Uint8Array(32) }, { vaultEncryptionKey: new Uint8Array(32) },
    { organizationId: "tenant-b" }, { workspaceId: "workspace-b" }, { trustedSensorId: "urn:sensor:other" }]) {
    expect(await createCapturedEventVerifier({ ...item.options, ...override })(item.event)).toBe(false);
  }
  expect(await createCapturedEventVerifier({ ...withoutKeys, receiptEncryptionKey: item.key })(item.event)).toBe(false);
});

it("fails closed for missing artifacts and missing, legacy, or plaintext-substituted witnesses", async () => {
  const item = await fixture();
  const original = await readFile(item.witnessPath, "utf8");
  for (const change of [
    { ...item.witness, eventDigests: undefined }, { ...item.witness, tenant: undefined },
    { ...item.witness, eventDigests: { [item.event.id]: "0".repeat(64) } },
  ]) {
    await writeFile(item.witnessPath, encryptVaultLine(JSON.stringify(change), item.key) + "\n");
    expect(await item.verify(item.event)).toBe(false);
  }
  await writeFile(item.witnessPath, JSON.stringify(item.witness));
  expect(await item.verify(item.event)).toBe(false);
  await rm(item.witnessPath);
  expect(await item.verify(item.event)).toBe(false);
  await writeFile(item.witnessPath, original);
  await rm(item.artifactPath);
  expect(await item.verify(item.event)).toBe(false);
});

it("rejects private artifact tampering and treats malformed events or verifier failures as unverified", async () => {
  const item = await fixture();
  const artifact = JSON.parse(decryptVaultLine((await readFile(item.artifactPath, "utf8")).trim(), item.key));
  artifact.payload.summary = "Changed evidence";
  await writeFile(item.artifactPath, encryptVaultLine(JSON.stringify(artifact), item.key) + "\n");
  expect(await item.verify(item.event)).toBe(false);
  expect(await verifiedTaskAcceptance({} as FoldEvent, item.expected, item.verify)).toBeUndefined();
  expect(await verifiedTaskAcceptance(item.event, item.expected, async () => { throw new Error("transient disk failure"); })).toBeUndefined();
});


it("verifies a nested exposed-reasoning artifact through its own transaction receipt witness", async () => {
  const item = await fixture(true);
  const transcript = join(item.root, "nested.jsonl");
  await writeFile(transcript, JSON.stringify({ type: "response_item", payload: { type: "reasoning", id: "reasoning-record", summary: [{ type: "summary_text", text: "Check the revision before accepting" }] } }) + "\n");
  await item.queue.accept({ version: 1, id: "nested-receipt", source: "codex", occurredAt: new Date().toISOString(), endpoint: "/hook",
    payload: { session_id: "nested", cwd: item.repository, transcript_path: transcript, hook_event_name: "PreCompact" } });
  await item.queue.drain();
  const event = (await item.spool.list()).flatMap(({ job }) => job.kind === "event" ? [job.event] : []).find((event) => event.changes.some((change) => change.verb === "create" && change.after.observation === "reasoning_observed"));
  expect(event).toBeDefined();
  expect(await item.verify(event!)).toBe(true);
});


it("promotes an exact attested decision through HTTP without promoting earlier forged same-summary content", async () => {
  const item = await fixture();
  const entries: FoldLogEntry[] = [];
  const sdk = new FoldSdk({ async read() { return { entries: [...entries] }; }, async append(entry) { entries.push(entry); } });
  const directory = new StaticIdentityDirectory({ token: { principalId: "worker", author: { kind: "sensor", id: "urn:sensor:test" },
    organizations: { "tenant-a": { role: "owner", workspaces: { "workspace-a": { role: "admin" } } } } } });
  const server = createApiServer({ authenticator: directory, memberships: directory, sdks: { sdkFor: async () => sdk } });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const failures: string[] = [];
  const client = new SuperBrainClient({ fetch: async (...args) => { const response = await fetch(...args); if (!response.ok) failures.push(await response.clone().text()); return response; }, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, organizationId: "tenant-a", workspaceId: "workspace-a", token: "token" });
  const worker = new TranscriptMemoryWorker({ client, vaultRoot: item.options.vaultRoot, stateRoot: join(item.root, "worker"), autoPromote: true,
    verifyCapturedEvent: item.verify, now: () => item.event.at.t + 1_000 });
  try {
    await client.appendEvent(item.event);
    const exact = extractLiveMemoryCandidates(item.event)[0]!;
    const forged = { ...exact, audience: "workspace" as const, content: { summary: exact.summary, statement: "Invented earlier instruction" } };
    await client.proposeMemoryCandidate(forged);
    expect(await worker.processLiveEvent(item.event), failures.join("\n")).toMatchObject({ proposed: 1, promoted: 1 });
    const views = await client.memoryCandidates();
    expect(views.find(({ candidate }) => candidate.id === forged.id)?.status).toBe("proposed");
    const accepted = views.find(({ status }) => status === "accepted");
    expect(accepted?.candidate.content).toEqual(exact.content);
    expect(accepted?.candidate.id).not.toBe(forged.id);
    if (accepted?.decision?.kind !== "accepted") throw new Error("missing verified promotion");
    expect((await client.memoryById(accepted.decision.memoryId))?.evidence).toEqual(exact.evidence);
  } finally {
    await worker.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
