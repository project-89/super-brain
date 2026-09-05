import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { MemoryCandidateInput, MemoryCandidateView, PersonalMemory } from "@_89/fold-epistemic";
import type { SuperBrainClient } from "@_89/super-brain-client";
import type { TranscriptRun } from "@_89/fold-transcript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TranscriptMemoryWorker, consolidateCandidateEvidence, RULE_EXTRACTOR, type ExtractedCandidate } from "../src/index.js";

const roots: string[] = [];
const workers: TranscriptMemoryWorker[] = [];
afterEach(async () => { await Promise.all(workers.splice(0).map((worker) => worker.close())); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const id = (n: number) => `019c0000-0000-7000-8000-${String(n).padStart(12, "0")}`;
function candidate(n = 1, overrides: Partial<ExtractedCandidate> = {}): ExtractedCandidate {
  return { id: id(n), audience: "workspace", projectIds: ["project-a"], applicability: { kind: "projects", projectIds: ["project-a"] },
    source: "transcript-rule", summary: "Postgres remains the canonical event store", content: { statement: "Postgres remains canonical" },
    evidence: [{ eventId: `evidence-${n}`, runId: "run-a", turnId: `turn-${n}` }], tags: [], confidence: 0.8, salience: 0.8,
    extractor: { kind: "rule", id: "extractor", version: "2" }, ...overrides };
}
function memory(n: number, projectId: string): PersonalMemory {
  return { id: id(n), workspaceId: "workspace-a", creatorId: "human-reviewer", audience: "workspace", projectIds: [projectId],
    applicability: { kind: "projects", projectIds: [projectId] }, currentness: { status: "current", reasons: [] },
    source: "conversation", summary: `Evidence for ${projectId}`, content: { statement: `Current ${projectId}` }, tags: [], entities: [],
    evidence: [{ eventId: `evidence-${n}`, projectId }], createdAt: 100, updatedAt: 100, revision: 0 };
}
function clientFixture(initial: MemoryCandidateView[] = [], memories: PersonalMemory[] = []) {
  const views = [...initial];
  const client = {
    identity: vi.fn().mockResolvedValue({ principalId: "worker-a", organizationId: "org-a", workspaceId: "workspace-a" }),
    memoryCandidates: vi.fn().mockImplementation(({ offset = 0, limit = 1000 } = {}) => Promise.resolve(views.slice(offset, offset + limit))),
    proposeMemoryCandidate: vi.fn().mockImplementation(async (input: MemoryCandidateInput, _causedBy: unknown, { stamp }: any) => {
      views.push({ candidate: { ...input, workspaceId: "workspace-a", proposerId: "worker-a", audience: input.audience ?? "workspace",
        projectIds: input.projectIds ?? [], tags: input.tags ?? [], entities: input.entities ?? [], proposedAt: stamp.t, updatedAt: stamp.t, proposalEventId: stamp.id }, status: "proposed" });
      return { candidate: views.at(-1)!.candidate };
    }),
    contributeMemoryCandidateEvidence: vi.fn().mockImplementation(async (candidateId: string, { evidence }: any) => {
      const index = views.findIndex(({ candidate }) => candidate.id === candidateId);
      views[index] = { ...views[index]!, candidate: { ...views[index]!.candidate, evidence: [...views[index]!.candidate.evidence, ...evidence] } };
      return { candidate: views[index]!.candidate };
    }),
    memoryById: vi.fn().mockImplementation(async (memoryId: string) => memories.find(({ id }) => id === memoryId)),
    contributeMemoryEvidence: vi.fn().mockImplementation(async (memoryId: string, { evidence }: any) => {
      const index = memories.findIndex(({ id }) => id === memoryId);
      memories[index] = { ...memories[index]!, revision: memories[index]!.revision + 1, evidence: [...(memories[index]!.evidence ?? []), ...evidence] };
      return { memory: memories[index] };
    }),
    memoryPage: vi.fn().mockResolvedValue({ memories, total: memories.length }),
    reasoningProviders: vi.fn().mockResolvedValue({ providers: [{ id: "model:test", kind: "model", configured: true, configRevision: "model-config-v1" }] }),
    askReasoning: vi.fn().mockImplementation(async () => ({ answer: "Shared evidence warrants a reusable verification procedure.",
      citations: memories.map(({ id }) => id), citationRefs: memories.map(({ id, revision }) => ({ memoryId: id, revision })), provider: { kind: "model", id: "model:test" } })),
    acceptMemoryCandidate: vi.fn().mockResolvedValue({}),
    transcriptRuns: vi.fn().mockResolvedValue([]), listEvents: vi.fn().mockImplementation(async ({ eventIds = [] }: { eventIds?: string[] } = {}) => eventIds.map((eventId) => ({ event: { id: eventId, at: { t: 100 } } }))), transcriptRun: vi.fn().mockResolvedValue(undefined),
  };
  return { client, views, memories };
}
async function worker(fixture: ReturnType<typeof clientFixture>, options: Partial<ConstructorParameters<typeof TranscriptMemoryWorker>[0]> = {}) {
  const root = await mkdtemp(join(tmpdir(), "worker-durable-test-")); roots.push(root);
  const instance = new TranscriptMemoryWorker({ client: fixture.client as unknown as SuperBrainClient, vaultRoot: join(root, "vault"), stateRoot: join(root, "jobs"), now: () => 10_000, retryBaseMs: 1, cognitionProviderId: "model:test", ...options });
  workers.push(instance); return { instance, root };
}

describe("durable memory processing", () => {
  it("retains pending and in-batch duplicate evidence without crossing visibility or applicability", async () => {
    const fixture = clientFixture(); const { instance } = await worker(fixture);
    expect(await instance.propose([candidate(1), candidate(2)])).toBe(1);
    expect(fixture.views[0]!.candidate.evidence).toHaveLength(2);
    await instance.propose([candidate(3), candidate(4, { evidence: [{ eventId: "evidence-3", runId: "run-a", turnId: "turn-3", relation: "opposes" }] })]);
    expect(fixture.views[0]!.candidate.evidence).toHaveLength(4);
    expect(fixture.client.contributeMemoryCandidateEvidence).toHaveBeenCalledOnce();
    await instance.propose([candidate(5, { spaceId: "space-a" }), candidate(6, { audience: "personal" }), candidate(7, { projectIds: [], applicability: { kind: "unresolved" } }), candidate(8, { projectIds: [], applicability: { kind: "global" } })]);
    expect(fixture.views).toHaveLength(5);
  });

  it("adds only new support to a human-accepted shared memory without impersonating its creator", async () => {
    const source = candidate(1); const accepted: PersonalMemory = { ...memory(20, "project-a"), source: source.source, summary: source.summary, content: source.content };
    const view: MemoryCandidateView = { candidate: { ...source, workspaceId: "workspace-a", proposerId: "worker-a", audience: "workspace", projectIds: ["project-a"], tags: [], entities: [], proposedAt: 100, proposalEventId: "proposal" },
      status: "accepted", decision: { kind: "accepted", candidateId: source.id, memoryId: accepted.id, actorId: "human-reviewer", eventId: "acceptance", atMs: 101 } };
    const fixture = clientFixture([view], [accepted]); const { instance } = await worker(fixture);
    await instance.propose([candidate(2)]);
    expect(fixture.client.contributeMemoryEvidence).toHaveBeenCalledWith(accepted.id, { evidence: candidate(2).evidence, expectedRevision: accepted.revision }, { stamp: expect.any(Object) });
    expect(fixture.memories[0]!.creatorId).toBe("human-reviewer");
  });

  it("replays an uncertain proposal acknowledgement without another mutation", async () => {
    const fixture = clientFixture(); const original = fixture.client.proposeMemoryCandidate.getMockImplementation()!;
    fixture.client.proposeMemoryCandidate.mockImplementationOnce(async (...args: any[]) => { await original(...args); throw new Error("lost acknowledgement"); });
    let now = 10_000; const { instance, root } = await worker(fixture, { now: () => now });
    await instance.propose([candidate()]);
    expect((await instance.coverage()).retry).toBe(1);
    await instance.close(); now += 10;
    const restarted = new TranscriptMemoryWorker({ client: fixture.client as unknown as SuperBrainClient, vaultRoot: join(root, "vault"), stateRoot: join(root, "jobs"), now: () => now }); workers.push(restarted);
    await restarted.drainJobs();
    expect(fixture.client.proposeMemoryCandidate).toHaveBeenCalledOnce();
    expect((await restarted.coverage()).retry).toBe(0);
  });

  it("keeps a missing artifact waiting across restart then extracts its late arrival", async () => {
    const fixture = clientFixture(); let now = 10_000;
    const { instance, root } = await worker(fixture, { now: () => now });
    const record = JSON.stringify({ type: "user", uuid: "native-message", timestamp: "2026-09-04T00:00:00Z", message: { content: "We decided that durable job storage must survive process restarts." } }) + "\n";
    const sha = createHash("sha256").update(record).digest("hex");
    const run: TranscriptRun = { id: "opaque-run", nativeId: "native-run", source: "claude-code", artifactId: "opaque-artifact", projectId: "project-a", projectResolution: "resolved",
      counts: { records: 1, turns: 1, messages: 1, actions: 0, unknown: 0 }, segments: [] };
    fixture.client.transcriptRun.mockResolvedValue({ run, artifact: { id: run.artifactId, source: run.source, sha256: sha, storedSha256: sha, parser: { id: "claude-jsonl", version: "2" }, stored: true },
      chunks: [{ turns: [{ id: "opaque-canonical-turn", ordinal: 0, roles: ["user"] }] }] });
    await instance.processRun(run, "run-event", true);
    expect((await instance.coverage()).waiting).toBe(1);
    await instance.close();
    const directory = join(root, "vault", run.source, sha.slice(0, 2)); await mkdir(directory, { recursive: true }); await writeFile(join(directory, `${sha}.jsonl`), record);
    now += 10;
    const restarted = new TranscriptMemoryWorker({ client: fixture.client as unknown as SuperBrainClient, vaultRoot: join(root, "vault"), stateRoot: join(root, "jobs"), now: () => now }); workers.push(restarted);
    await restarted.drainJobs();
    expect((await restarted.coverage()).waiting).toBe(0);
    expect(fixture.views).toHaveLength(1);
    expect(fixture.views[0]!.candidate.evidence[0]!.turnId).toBe("opaque-canonical-turn");
    const namespace = (await readdir(join(root, "jobs")))[0]!;
    const completed = await readdir(join(root, "jobs", namespace, "completed"));
    const bytes = await readFile(join(root, "jobs", namespace, "completed", completed[0]!), "utf8");
    expect(bytes).not.toContain("durable job storage");
  });

  it("isolates a failed model job and reuses its durable model result after proposal failure", async () => {
    const fixture = clientFixture([], [memory(21, "project-a"), memory(22, "project-b")]); let now = 10_000;
    const { instance } = await worker(fixture, { now: () => now, continuousCognition: true, cognitionEveryEvents: 1 });
    fixture.client.askReasoning.mockRejectedValueOnce(new Error("provider unavailable"));
    const event = { id: "model-trigger", kind: "memory.recorded", at: { t: 100, worldDate: "2026-09-04" } };
    await instance.synthesizeAcrossProjects(event);
    expect((await instance.coverage()).retry).toBe(1);
    expect(await instance.propose([candidate()])).toBe(1);
    now += 10;
    fixture.client.proposeMemoryCandidate.mockRejectedValueOnce(new Error("proposal unavailable"));
    await instance.drainModelJobs(); await instance.drainJobs();
    expect(fixture.client.askReasoning).toHaveBeenCalledTimes(2);
    now += 10; await instance.drainJobs();
    expect(fixture.client.askReasoning).toHaveBeenCalledTimes(2);
    expect(fixture.views.some(({ candidate }) => candidate.source === "continuous-cognition")).toBe(true);
    await instance.synthesizeAcrossProjects(event);
    expect(fixture.client.askReasoning).toHaveBeenCalledTimes(2);
  });

  it("excludes forgotten evidence from synthesis and does not promote caller labels", async () => {
    const fixture = clientFixture([], [memory(21, "project-a"), memory(22, "project-b")]);
    fixture.client.memoryById.mockResolvedValue(undefined);
    const { instance } = await worker(fixture, { continuousCognition: true, cognitionEveryEvents: 1, autoPromote: true });
    await instance.synthesizeAcrossProjects({ id: "forgotten-trigger", kind: "memory.recorded", at: { t: 100, worldDate: "2026-09-04" } });
    expect(fixture.client.askReasoning).not.toHaveBeenCalled();
    expect((await instance.coverage()).excluded).toBe(1);
    expect(await instance.promote([candidate(1, { source: "live-human-decision", confidence: 1 })])).toBe(0);
    expect(fixture.client.acceptMemoryCandidate).not.toHaveBeenCalled();
  });

  it("keeps independently scoped evidence in a single consolidation policy", () => {
    const merged = consolidateCandidateEvidence([candidate(1), candidate(2), candidate(3, { spaceId: "space-b" })], { principalId: "worker", audience: "workspace" });
    expect(merged).toHaveLength(2); expect(merged[0]!.evidence).toHaveLength(2);
  });
  it("keeps same-summary claims with different content separate and avoids counting one source twice", async () => {
    const fixture = clientFixture(); const { instance } = await worker(fixture);
    await instance.propose([candidate(1), candidate(2, { content: { statement: "SQLite remains canonical" } })]);
    expect(fixture.views).toHaveLength(2);
    await instance.propose([candidate(3, { evidence: [{ ...candidate(1).evidence[0]!, eventId: "replayed-import" }] })]);
    expect(fixture.views[0]!.candidate.evidence).toHaveLength(1);
    expect(fixture.client.contributeMemoryCandidateEvidence).not.toHaveBeenCalled();
    const repeated = consolidateCandidateEvidence([
      candidate(4, { extractor: RULE_EXTRACTOR, content: { statement: "Same claim", role: "user", runId: "a", turnId: "one" } }),
      candidate(5, { extractor: RULE_EXTRACTOR, content: { statement: "Same claim", role: "user", runId: "b", turnId: "two" } }),
    ], { principalId: "worker", audience: "workspace" });
    expect(repeated).toHaveLength(1); expect(repeated[0]!.evidence).toHaveLength(2);
  });

  it("bounds model failures, cancels timed-out requests, and permits explicit retry", async () => {
    const fixture = clientFixture([], [memory(21, "project-a"), memory(22, "project-b")]); let now = 10_000;
    const { instance, root } = await worker(fixture, { now: () => now, continuousCognition: true, cognitionEveryEvents: 1, modelTimeoutMs: 5, maxModelAttempts: 2 });
    const aborted: AbortSignal[] = [];
    fixture.client.askReasoning.mockImplementation((_request: unknown, { signal }: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => { aborted.push(signal); reject(signal.reason); }, { once: true });
    }));
    await instance.synthesizeAcrossProjects({ id: "timeout", kind: "memory.recorded", at: { t: 100, worldDate: "2026-09-04" } });
    now += 10; await instance.drainModelJobs();
    expect(aborted).toHaveLength(2); expect((await instance.coverage()).exhausted).toBe(1);
    now += 100; await instance.drainModelJobs(); expect(fixture.client.askReasoning).toHaveBeenCalledTimes(2);
    const namespace = (await readdir(join(root, "jobs")))[0]!;
    const exhaustedId = (await readdir(join(root, "jobs", namespace, "exhausted")))[0]!.replace(/\.enc$/, "");
    await instance.retryJob(exhaustedId); await instance.drainModelJobs();
    expect(fixture.client.askReasoning).toHaveBeenCalledTimes(3);
  });

  it("awaits held identity initialization during close without acquiring a later lease", async () => {
    const fixture = clientFixture(); let release!: (value: unknown) => void;
    fixture.client.identity.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const { instance, root } = await worker(fixture);
    const opening = instance.coverage().then(() => "opened", () => "closed");
    let done = false; const closing = instance.close().then(() => { done = true; });
    await Promise.resolve(); expect(done).toBe(false);
    release({ principalId: "worker-a", workspaceId: "workspace-a" });
    await closing; expect(await opening).toBe("closed");
    expect(await readdir(root)).toEqual([]);
    await expect(instance.coverage()).rejects.toThrow("closed");
  });

  it("uses revised applicability rather than stale legacy project labels for synthesis", async () => {
    const first = memory(21, "project-a");
    const second = { ...memory(22, "project-b"), applicability: { kind: "projects" as const, projectIds: ["project-a"] } };
    const fixture = clientFixture([], [first, second]);
    const { instance } = await worker(fixture, { continuousCognition: true, cognitionEveryEvents: 1 });
    await instance.synthesizeAcrossProjects({ id: "same-project-after-revision", kind: "memory.recorded", at: { t: 100, worldDate: "2026-09-04" } });
    expect(fixture.client.askReasoning).not.toHaveBeenCalled();
  });

  it("persists first dispatch after future source events and latest candidate contributions", async () => {
    const fixture = clientFixture(); const { instance } = await worker(fixture);
    fixture.client.listEvents.mockImplementation(async ({ eventIds = [] }: { eventIds?: string[] } = {}) => eventIds.map((eventId) => ({ event: { id: eventId, at: { t: 200_000 } } })));
    await instance.propose([candidate(1)]);
    expect(fixture.client.proposeMemoryCandidate.mock.calls[0]![2].stamp.t).toBe(200_001);
    fixture.views[0] = { ...fixture.views[0]!, candidate: { ...fixture.views[0]!.candidate, updatedAt: 300_000 } };
    await instance.propose([candidate(2)]);
    expect(fixture.client.contributeMemoryCandidateEvidence.mock.calls[0]![2].stamp.t).toBe(300_001);
  });

  it("cancels an owned model request during close and releases the namespace", async () => {
    const fixture = clientFixture([], [memory(21, "project-a"), memory(22, "project-b")]);
    const { instance, root } = await worker(fixture, { continuousCognition: true, cognitionEveryEvents: 1 });
    let began!: () => void; const started = new Promise<void>((resolve) => { began = resolve; });
    let owned: AbortSignal | undefined;
    fixture.client.askReasoning.mockImplementation((_request: unknown, { signal }: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      owned = signal; began(); signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const run = instance.synthesizeAcrossProjects({ id: "shutdown", kind: "memory.recorded", at: { t: 1, worldDate: "2026-09-04" } }).catch(() => undefined);
    await started; await instance.close(); await run;
    expect(owned?.aborted).toBe(true);
    const namespace = (await readdir(join(root, "jobs")))[0]!;
    expect(await readdir(join(root, "jobs", namespace))).not.toContain("lease.json");
  });

});
