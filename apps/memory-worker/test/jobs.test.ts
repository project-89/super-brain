import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseEvent, type FoldEvent } from "@_89/fold";
import { makeTranscriptRunEvent, type TranscriptRun } from "@_89/fold-transcript";
import { type SuperBrainClient } from "@_89/super-brain-client";
import { mergeMemoryCandidateEvidence } from "@_89/fold-epistemic";
import { extractMemoryCandidatePage, ProcessingJobStore, processingDigest, readProcessingCoverage, TranscriptMemoryWorker, RULE_EXTRACTOR } from "../src/index.js";

const roots: string[] = [];
const cognitionOptions = { continuousCognition: true, cognitionEveryEvents: 1 };
async function directory() { const root = await mkdtemp(join(tmpdir(), "memory-jobs-")); roots.push(root); return root; }
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const run: TranscriptRun = {
  id: "codex:session", nativeId: "session", source: "codex", artifactId: `artifact-${"a".repeat(64)}`,
  projectId: "project-a", projectResolution: "resolved", startedAt: "2026-09-15T10:00:00Z",
  counts: { records: 30, turns: 30, messages: 30, actions: 0, unknown: 0 }, segments: [],
};
const runEvent = makeTranscriptRunEvent({ author: { kind: "ingest", id: "importer" }, capture: { scope: { workspace: "workspace" }, identity: { source: "codex" } } }, { id: "run-imported", t: 100, worldDate: "2026-09-15" }, run);
function trigger(id: string, kind = "memory.recorded"): FoldEvent {
  return parseEvent({ specVersion: "0.7", id, kind, title: "Trigger", at: { t: 100, worldDate: "2026-09-15", granularity: "beat" }, author: { kind: "human", id: "user" }, participants: [], capture: { scope: { workspace: "workspace" } }, changes: [{ verb: "create", subject: "trigger", nodeKind: "fact", after: { label: "trigger" }, provenance: { basis: "authored" } }] });
}
async function writeVault(root: string, count = 31) {
  const path = join(root, "codex", "aa"); await mkdir(path, { recursive: true });
  await writeFile(join(path, `${"a".repeat(64)}.jsonl`), Array.from({ length: count }, (_, index) => JSON.stringify({ type: "response_item", timestamp: "2026-09-15T10:00:00Z", payload: { type: "message", id: `message-${index}`, role: "user", content: [{ type: "input_text", text: `We decided that component ${index} must retain its canonical evidence permanently.` }] } })).join("\n"));
}
function mockClient(events = [runEvent]) {
  const proposed: any[] = [];
  const client = {
    eventById: vi.fn().mockImplementation(async (id) => events.find((event) => event.id === id)),
    transcriptRuns: vi.fn().mockResolvedValue([run]),
    listEvents: vi.fn().mockResolvedValue(events.map((event) => ({ event, status: "canon" }))),
    memoryCandidates: vi.fn().mockImplementation(async () => proposed.map((candidate) => ({ candidate: { ...candidate, audience: "workspace" }, status: "proposed" }))),
    proposeMemoryCandidates: vi.fn().mockImplementation(async (batch) => { proposed.push(...batch); }),
    addMemoryCandidateEvidence: vi.fn().mockImplementation(async (id, input) => {
      const index = proposed.findIndex((candidate) => candidate.id === id);
      proposed[index] = { ...proposed[index], evidence: mergeMemoryCandidateEvidence(proposed[index].evidence, input.evidence) };
      return { candidate: { ...proposed[index], audience: "workspace" } };
    }),
  };
  return { client, proposed, options: { client: client as unknown as SuperBrainClient } };
}

describe("durable memory processing", () => {
  it("requeues legacy completed receipts under the new support policy without reinterpreting old active progress", async () => {
    const root = await directory(); const { options } = mockClient();
    const store = new ProcessingJobStore(root); await store.open();
    const legacy = { extractor: RULE_EXTRACTOR, audience: "workspace", autoPromote: false };
    await store.enqueue("transcript", [runEvent.id, legacy], runEvent, processingDigest(legacy));
    await store.save({ ...store.due()[0]!, status: "complete" });
    const worker = new TranscriptMemoryWorker({ ...options, vaultRoot: "/missing" });
    expect(await worker.scheduleEvent(store, runEvent)).toBe(1);
    expect(await worker.scheduleEvent(store, runEvent)).toBe(0);
    expect((await store.coverage()).completedReceipts).toBe(1);
    expect(store.due()).toHaveLength(1);
    const other = { ...runEvent, id: "old-active" };
    await store.enqueue("transcript", [other.id, legacy], other, processingDigest(legacy));
    await worker.drainProcessingJobs(store, 1000);
    expect((await store.coverage()).active.some((job) => job.status === "blocked" && job.reason?.includes("policy changed"))).toBe(true);
    await store.close();
  });
  it("retains late same-summary support and corrections beyond page 25 across a lost-response restart", async () => {
    const root = await directory(); const vault = await directory(); const { options, client, proposed } = mockClient();
    const path = join(vault, "codex", "aa"); await mkdir(path, { recursive: true });
    await writeFile(join(path, `${"a".repeat(64)}.jsonl`), Array.from({ length: 33 }, (_, index) => [
      JSON.stringify({ type: "turn_context", payload: { turn_id: `turn-${index}` } }), JSON.stringify({
      type: "response_item", timestamp: "2026-09-15T10:00:00Z", payload: { type: "message", id: `message-${index}`, role: "assistant", content: [{ type: "output_text",
        text: `<observation><title>Durable queue contract</title><fact>${index === 32 ? "Correction: retain failed jobs for review" : "Persist jobs before acknowledging events"}</fact></observation>` }] },
    })]).flat().join("\n"));
    const store = new ProcessingJobStore(root); await store.open();
    const worker = new TranscriptMemoryWorker({ ...options, vaultRoot: vault });
    await worker.scheduleEvent(store, runEvent); await worker.drainProcessingJobs(store, 1_000);
    expect(proposed).toHaveLength(1); expect(proposed[0].evidence).toHaveLength(25);
    const appendSupport = client.addMemoryCandidateEvidence.getMockImplementation()!;
    client.addMemoryCandidateEvidence.mockImplementationOnce(async (...args) => { await appendSupport(...args); throw new Error("response lost"); });
    await worker.drainProcessingJobs(store, 1_001);
    expect((await store.coverage()).active[0]?.status).toBe("retry");
    await store.close();
    const restarted = new ProcessingJobStore(root); await restarted.open();
    await new TranscriptMemoryWorker({ ...options, vaultRoot: vault }).drainProcessingJobs(restarted, 10_000);
    expect(proposed).toHaveLength(2);
    expect(proposed[0].evidence).toHaveLength(32);
    expect(proposed[1].content.facts).toEqual(["Correction: retain failed jobs for review"]);
    expect((await restarted.coverage()).completedReceipts).toBe(1);
    await restarted.close();
  });
  it("uses canonical source digests regardless of JSON object key order", () => {
    expect(processingDigest({ a: 1, nested: { c: 3, b: 2 } })).toBe(processingDigest({ nested: { b: 2, c: 3 }, a: 1 }));
  });
  it("pages beyond the first 25 candidates, including an intra-message boundary", () => {
    const messages = [{ role: "user" as const, turnId: "turn", text: Array.from({ length: 33 }, (_, index) => `We decided that component ${index} must retain its canonical evidence permanently.`).join(" ") }];
    const first = extractMemoryCandidatePage(run, runEvent.id, messages);
    expect(first.candidates).toHaveLength(25);
    expect(first.next).toEqual({ message: 0, candidate: 25 });
    const last = extractMemoryCandidatePage(run, runEvent.id, messages, first.next);
    expect(last.candidates).toHaveLength(8);
    expect(last.candidates.at(-1)?.summary).toContain("component 32");
    expect(last.next).toBeUndefined();
  });

  it("retains waiting missing-artifact jobs after restart and resumes through late candidates", async () => {
    const root = await directory(); const vault = await directory(); const { options, proposed } = mockClient();
    const first = new ProcessingJobStore(root); await first.open();
    const worker = new TranscriptMemoryWorker({ ...options, vaultRoot: vault, maxCandidatesPerRun: 25 });
    await worker.scheduleEvent(first, runEvent);
    await worker.drainProcessingJobs(first, 1_000);
    expect((await first.coverage()).active[0]).toMatchObject({ status: "waiting", reason: "vault artifact unavailable" });
    await first.close();
    await writeVault(vault);
    const resumed = new ProcessingJobStore(root); await resumed.open();
    const restarted = new TranscriptMemoryWorker({ ...options, vaultRoot: vault });
    await restarted.drainProcessingJobs(resumed, 10_000);
    expect((await resumed.coverage()).active[0]).toMatchObject({ status: "pending", candidatesProcessed: 25 });
    await restarted.drainProcessingJobs(resumed, 10_001);
    expect(proposed).toHaveLength(31);
    expect(proposed.at(-1).summary).toContain("component 30");
    expect((await resumed.coverage()).completedReceipts).toBe(1);
    await restarted.scheduleEvent(resumed, runEvent);
    expect((await resumed.coverage()).active).toEqual([]);
    await resumed.close();
  });

  it("retries a delivery crash after the server accepted without skipping or duplicating a page", async () => {
    const root = await directory(); const vault = await directory(); await writeVault(vault, 2);
    const { client, options, proposed } = mockClient();
    client.proposeMemoryCandidates.mockImplementationOnce(async (batch) => { proposed.push(...batch); throw new Error("lost response"); });
    const first = new ProcessingJobStore(root); await first.open();
    const worker = new TranscriptMemoryWorker({ ...options, vaultRoot: vault });
    await worker.scheduleEvent(first, runEvent); await worker.drainProcessingJobs(first, 1_000);
    expect((await first.coverage()).active[0]).toMatchObject({ status: "retry" });
    await first.close();
    const resumed = new ProcessingJobStore(root); await resumed.open();
    await new TranscriptMemoryWorker({ ...options, vaultRoot: vault }).drainProcessingJobs(resumed, 10_000);
    expect(proposed).toHaveLength(2);
    expect((await resumed.coverage()).completedReceipts).toBe(1);
    await resumed.close();
  });

  it("does not silently complete a modified or malformed source or a revoked event", async () => {
    const root = await directory(); const vault = await directory(); await writeVault(vault, 2);
    const { client, options } = mockClient(); const store = new ProcessingJobStore(root); await store.open();
    const worker = new TranscriptMemoryWorker({ ...options, vaultRoot: vault, maxCandidatesPerRun: 1 });
    await worker.scheduleEvent(store, runEvent); await worker.drainProcessingJobs(store, 1_000);
    await writeVault(vault, 3); await worker.drainProcessingJobs(store, 1_001);
    expect((await store.coverage()).active[0]?.status).toBe("retry");
    client.eventById.mockResolvedValue(undefined);
    await worker.drainProcessingJobs(store, 100_000);
    expect((await store.coverage()).active[0]).toMatchObject({ status: "waiting", reason: "source event unavailable" });
    expect((await store.coverage()).completedReceipts).toBe(0);
    await store.close();
  });

  it("persists before subscriber acknowledgment and fails closed if the spool cannot accept work", async () => {
    const root = await directory(); const { options, client } = mockClient();
    const consumeEvents = vi.fn().mockImplementation(async ({ onEvent }) => {
      await onEvent({ entry: { event: runEvent, status: "canon" } });
      const receipt = await readProcessingCoverage(root);
      expect(receipt.active).toHaveLength(1);
    });
    await new TranscriptMemoryWorker({ ...options, client: { ...client, consumeEvents } as unknown as SuperBrainClient, vaultRoot: "/missing", processingRoot: root }).watch({ consumerId: "test" });
    await expect(new TranscriptMemoryWorker({ ...options, vaultRoot: "/missing" }).watch({ consumerId: "test" })).rejects.toThrow("requires processingRoot");
  });

  it("does not acknowledge a source when durable enqueue fails", async () => {
    const root = await directory(); const { options, client } = mockClient();
    let acknowledged = false;
    const consumeEvents = vi.fn().mockImplementation(async ({ onEvent }) => {
      await onEvent({ entry: { event: runEvent, status: "canon" } });
      acknowledged = true;
    });
    const failing = vi.spyOn(ProcessingJobStore.prototype, "enqueue").mockRejectedValueOnce(new Error("disk full"));
    try {
      await expect(new TranscriptMemoryWorker({ ...options, client: { ...client, consumeEvents } as unknown as SuperBrainClient, vaultRoot: "/unused", processingRoot: root }).watch({ consumerId: "test" })).rejects.toThrow("disk full");
      expect(acknowledged).toBe(false);
    } finally { failing.mockRestore(); }
  });

  it("malformed archive data remains incomplete rather than reporting zero-candidate success", async () => {
    const root = await directory(); const vault = await directory(); await writeVault(vault, 1);
    await writeFile(join(vault, "codex", "aa", `${"a".repeat(64)}.jsonl`), "{malformed");
    const { options } = mockClient(); const worker = new TranscriptMemoryWorker({ ...options, vaultRoot: vault });
    const store = new ProcessingJobStore(root); await store.open();
    await worker.scheduleEvent(store, runEvent); await worker.drainProcessingJobs(store, 1_000);
    expect((await store.coverage()).active[0]?.status).toBe("retry");
    expect((await store.coverage()).completedReceipts).toBe(0);
    await store.close();
  });

  it.each([{ space: "private-space" }, { creator: "private-owner" }])("does not publish scoped source evidence into unscoped output: %s", async (scope) => {
    const root = await directory(); const vault = await directory(); await writeVault(vault, 1);
    const privateEvent = { ...runEvent, capture: { ...runEvent.capture, scope: { workspace: "workspace", ...scope } } };
    const { client, options } = mockClient([privateEvent]);
    const worker = new TranscriptMemoryWorker({ ...options, vaultRoot: vault });
    const store = new ProcessingJobStore(root); await store.open();
    await worker.scheduleEvent(store, privateEvent); await worker.drainProcessingJobs(store, 1_000);
    expect(client.proposeMemoryCandidates).not.toHaveBeenCalled();
    expect((await store.coverage()).excludedReceipts).toBe(1);
    expect((await store.coverage()).completedReceipts).toBe(0);
    expect(await worker.processRun(run, runEvent.id, true)).toMatchObject({ proposed: 0, skippedReason: "source publication scope incompatible with unscoped worker output" });
    await store.close();
  });

  it("rejects concurrent owners, detects corrupt checkpoints, and preserves jobs across credential rotation", async () => {
    const root = await directory(); const store = new ProcessingJobStore(root, "credential-a"); await store.open();
    await store.enqueue("live", "event", trigger("source"));
    await expect(new ProcessingJobStore(root, "credential-a").open()).rejects.toThrow("already in use");
    const [name] = await readdir(join(root, "active"));
    expect((await stat(join(root, "active", name!))).mode & 0o777).toBe(0o600);
    await store.close();
    await expect(new ProcessingJobStore(root, "credential-b").open()).rejects.toThrow("credential changed");
    const path = join(root, "active", name!); const job = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...job, nextAttemptAt: "invalid" }));
    await expect(new ProcessingJobStore(root, "credential-a").open()).rejects.toThrow("Invalid memory processing job");
  });

  it("invalidates a prepared synthesis when its source changes without exposing its payload in coverage", async () => {
    const root = await directory(); const event = trigger("synthesis"); const { client, options } = mockClient([event]);
    const memory = { id: "memory-a", revision: 0, audience: "workspace" };
    const synthesis = { candidate: { id: "candidate-a", summary: "Private model text", projectIds: [], source: "continuous-cognition" }, dependencies: [{ memoryId: "memory-a", digest: processingDigest(memory) }], identity: processingDigest("output") };
    const store = new ProcessingJobStore(root); await store.open();
    await new TranscriptMemoryWorker({ ...options, ...cognitionOptions, vaultRoot: "/unused" }).scheduleEvent(store, event, "1");
    const job = store.due()[0]!; await store.save({ ...job, progress: { synthesis } });
    const memoryById = vi.fn().mockResolvedValue({ ...memory, revision: 1 });
    await new TranscriptMemoryWorker({ ...options, ...cognitionOptions, client: { ...client, memoryById } as unknown as SuperBrainClient, vaultRoot: "/unused" }).drainProcessingJobs(store, 1_000);
    expect(client.proposeMemoryCandidates).not.toHaveBeenCalled();
    expect((await store.coverage()).active[0]).toMatchObject({ status: "waiting", reason: "synthesis dependency revised or unavailable; result invalidated" });
    expect(JSON.stringify(await readProcessingCoverage(root))).not.toContain("Private model text");
    await store.close();
  });

  it("a failed model job does not prevent an unrelated transcript from completing", async () => {
    const root = await directory(); const vault = await directory(); await writeVault(vault, 1);
    const event = trigger("model-failure"); const { options, proposed } = mockClient([event, runEvent]);
    const worker = new TranscriptMemoryWorker({ ...options, vaultRoot: vault, continuousCognition: true, cognitionEveryEvents: 1 });
    vi.spyOn(worker, "synthesizeAcrossProjects").mockRejectedValue(new Error("model failure"));
    const store = new ProcessingJobStore(root); await store.open();
    await worker.scheduleEvent(store, event, "1"); await worker.scheduleEvent(store, runEvent, "2");
    await worker.drainProcessingJobs(store, 1_000);
    expect(proposed).toHaveLength(1);
    expect((await store.coverage()).active).toEqual([expect.objectContaining({ kind: "synthesis", status: "retry" })]);
    expect((await store.coverage()).completedReceipts).toBe(1);
    await store.close();
  });

  it("a pending model request does not block new extraction in its independent lane", async () => {
    const root = await directory(); const vault = await directory(); await writeVault(vault, 1);
    const event = trigger("slow-model"); const { options, proposed } = mockClient([event, runEvent]);
    const worker = new TranscriptMemoryWorker({ ...options, vaultRoot: vault, continuousCognition: true, cognitionEveryEvents: 1 });
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    vi.spyOn(worker, "synthesizeAcrossProjects").mockImplementation(async () => {
      entered(); await new Promise<void>((resolve) => { release = resolve; });
      throw new Error("model unavailable");
    });
    const store = new ProcessingJobStore(root); await store.open();
    await worker.scheduleEvent(store, event, "1");
    const slow = worker.drainProcessingJobs(store, 1_000, "synthesis"); await started;
    await worker.scheduleEvent(store, runEvent);
    await worker.drainProcessingJobs(store, 1_001, "extraction");
    expect(proposed).toHaveLength(1);
    expect((await store.coverage()).completedReceipts).toBe(1);
    release(); await slow; await store.close();
  });

  it("blocks a saved page when promotion policy changes, preserving progress instead of reinterpreting it", async () => {
    const root = await directory(); const vault = await directory(); await writeVault(vault, 2);
    const { options, client } = mockClient(); const store = new ProcessingJobStore(root); await store.open();
    const first = new TranscriptMemoryWorker({ ...options, vaultRoot: vault, maxCandidatesPerRun: 1 });
    await first.scheduleEvent(store, runEvent); await first.drainProcessingJobs(store, 1_000);
    client.proposeMemoryCandidates.mockClear();
    await new TranscriptMemoryWorker({ ...options, vaultRoot: vault, autoPromote: true }).drainProcessingJobs(store, 1_001);
    expect(client.proposeMemoryCandidates).not.toHaveBeenCalled();
    expect((await store.coverage()).active[0]).toMatchObject({ status: "blocked", candidatesProcessed: 1, reason: "processing policy changed; restore or explicitly migrate the saved job policy" });
    await store.close();
  });

  it("quarantines malformed progress without blocking unrelated extraction", async () => {
    const root = await directory(); const vault = await directory(); await writeVault(vault, 1);
    const { options, proposed } = mockClient(); const store = new ProcessingJobStore(root); await store.open();
    await store.enqueue("synthesis", "bad-progress", trigger("bad-progress"));
    await store.save({ ...store.due()[0]!, progress: { cursor: { message: -1, candidate: 0 } } });
    const worker = new TranscriptMemoryWorker({ ...options, vaultRoot: vault });
    await worker.scheduleEvent(store, runEvent); await worker.drainProcessingJobs(store, 1_000);
    expect(proposed).toHaveLength(1);
    expect((await store.coverage()).active[0]).toMatchObject({ status: "blocked", reason: "invalid source or processing checkpoint; inspect preserved job" });
    await store.close();
  });

  it("a saved model output is retried after restart without requesting a different model answer", async () => {
    const root = await directory(); const event = trigger("prepared-model"); const { client, options, proposed } = mockClient([event]);
    const memory = { id: "memory-a", revision: 0, audience: "workspace" };
    const candidate = { id: "candidate-a", summary: "Prepared answer", projectIds: [], applicability: "unresolved", source: "continuous-cognition", evidence: [] };
    const synthesis = { candidate, dependencies: [{ memoryId: memory.id, digest: processingDigest(memory) }], identity: processingDigest("output") };
    const store = new ProcessingJobStore(root); await store.open();
    await new TranscriptMemoryWorker({ ...options, ...cognitionOptions, vaultRoot: "/unused" }).scheduleEvent(store, event, "1");
    await store.save({ ...store.due()[0]!, progress: { synthesis } });
    client.proposeMemoryCandidates.mockRejectedValueOnce(new Error("offline"));
    const finalClient = { ...client, memoryById: vi.fn().mockResolvedValue(memory), askReasoning: vi.fn() };
    await new TranscriptMemoryWorker({ ...options, ...cognitionOptions, client: finalClient as unknown as SuperBrainClient, vaultRoot: "/unused" }).drainProcessingJobs(store, 1_000);
    expect((await store.coverage()).active[0]?.status).toBe("retry");
    await store.close();
    const restarted = new ProcessingJobStore(root); await restarted.open();
    await new TranscriptMemoryWorker({ ...options, ...cognitionOptions, client: finalClient as unknown as SuperBrainClient, vaultRoot: "/unused" }).drainProcessingJobs(restarted, 10_000);
    expect(finalClient.askReasoning).not.toHaveBeenCalled();
    expect(proposed).toEqual([candidate]);
    expect((await restarted.coverage()).completedReceipts).toBe(1);
    await restarted.close();
  });

  it("previews historical scheduling read-only, then queues the same durable job idempotently", async () => {
    const root = await directory(); const vault = await directory(); const { options, client, proposed } = mockClient();
    const worker = new TranscriptMemoryWorker({ ...options, vaultRoot: vault, continuousCognition: false });
    expect(await worker.queueTranscriptBackfill()).toMatchObject({ mode: "dry-run", counts: { eligible: 1, queued: 0 } });
    expect(await readdir(root)).toEqual([]);
    expect(client.proposeMemoryCandidates).not.toHaveBeenCalled();
    const store = new ProcessingJobStore(root); await store.open();
    expect(await worker.queueTranscriptBackfill(store)).toMatchObject({ counts: { queued: 1 } });
    const watcher = new TranscriptMemoryWorker({ ...options, vaultRoot: vault, continuousCognition: true });
    expect(await watcher.scheduleEvent(store, runEvent)).toBe(0);
    expect(await worker.queueTranscriptBackfill(store)).toMatchObject({ counts: { existing: 1, queued: 0 } });
    await watcher.drainProcessingJobs(store, 1_000);
    expect((await store.coverage()).active[0]).toMatchObject({ status: "waiting", reason: "vault artifact unavailable" });
    await writeVault(vault, 31);
    await watcher.drainProcessingJobs(store, 10_000); await watcher.drainProcessingJobs(store, 10_001);
    expect(proposed).toHaveLength(31);
    expect(proposed.at(-1).summary).toContain("component 30");
    await store.close();
  });

  it("resumes a partially queued historical inventory after restart without duplicate jobs", async () => {
    const root = await directory();
    const secondRun = { ...run, id: "codex:second", nativeId: "second" };
    const secondEvent = makeTranscriptRunEvent({ author: { kind: "ingest", id: "importer" }, capture: runEvent.capture }, { id: "second-import", t: 101, worldDate: "2026-09-15" }, secondRun);
    const { options, client } = mockClient([runEvent, secondEvent]); client.transcriptRuns.mockResolvedValue([run, secondRun]);
    client.eventById.mockRejectedValueOnce(new Error("offline"));
    const store = new ProcessingJobStore(root); await store.open();
    const worker = new TranscriptMemoryWorker({ ...options, vaultRoot: "/missing" });
    await worker.scheduleEvent(store, runEvent);
    await expect(worker.queueTranscriptBackfill(store)).rejects.toThrow("offline");
    await store.close();
    const resumed = new ProcessingJobStore(root); await resumed.open();
    expect(await new TranscriptMemoryWorker({ ...options, vaultRoot: "/missing" }).queueTranscriptBackfill(resumed)).toMatchObject({ counts: { queued: 1, existing: 1 } });
    expect((await resumed.coverage()).active).toHaveLength(2);
    expect(client.proposeMemoryCandidates).not.toHaveBeenCalled();
    await resumed.close();
  });
});
