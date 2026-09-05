import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it } from "vitest";
import { type FoldLogEntry } from "@_89/fold";
import { SuperBrainClient } from "@_89/super-brain-client";
import { makeTerminalObservationEvent } from "../../../packages/fold-activity/dist/index.js";
import { FoldSdk } from "../../../packages/fold-sdk/dist/index.js";
import { createApiServer, StaticIdentityDirectory, type ReasoningProvider } from "../../api/dist/index.js";
import { TranscriptMemoryWorker, type ExtractedCandidate } from "../src/index.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const id = (number: number) => `019c0000-0000-7000-8000-${String(number).padStart(12, "0")}`;
async function fixture(reasoner?: ReasoningProvider) {
  const entries: FoldLogEntry[] = [];
  const sdk = new FoldSdk({ async read() { return { entries: [...entries] }; }, async append(entry) { entries.push(entry); } });
  const directory = new StaticIdentityDirectory({
    worker: { principalId: "worker", author: { kind: "sensor", id: "urn:sensor:worker" }, workspaces: { workspace: { role: "member", spaces: { private: "writer" } } } },
    human: { principalId: "human", workspaces: { workspace: { role: "admin", spaces: { private: "admin" } } } },
  });
  const server = createApiServer({ authenticator: directory, memberships: directory, sdks: { sdkFor: async () => sdk }, ...(reasoner === undefined ? {} : { reasoner }) });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  cleanups.push(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const machine = new SuperBrainClient({ baseUrl, workspaceId: "workspace", token: "worker" });
  const human = new SuperBrainClient({ baseUrl, workspaceId: "workspace", token: "human" });
  const root = await mkdtemp(join(tmpdir(), "worker-http-integration-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  let tick = 1_000;
  const worker = new TranscriptMemoryWorker({ client: machine, vaultRoot: join(root, "vault"), stateRoot: join(root, "jobs"), now: () => ++tick,
    ...(reasoner === undefined ? {} : { cognitionProviderId: reasoner.descriptor.id }),
    retryBaseMs: 1, continuousCognition: true, cognitionEveryEvents: 1 });
  cleanups.push(() => worker.close());
  async function evidence(number: number, projectId = "project-a", spaceId?: string) {
    const event = makeTerminalObservationEvent({ sensor: "urn:sensor:worker", sessionId: "session", heartbeatWindowMs: 90_000,
      capture: { scope: { workspace: "workspace", ...(spaceId === undefined ? {} : { space: spaceId }) }, identity: { principal: "worker", workspace: "workspace", agent: "machine", task: "task", branch: "main", session: "session", repo: projectId, project: "Display project name", runtime: "codex", turn: `turn-${number}` } } },
      { id: `evidence-${number}`, t: number, observedAt: "2026-09-04T00:00:00.000Z" },
      { kind: "reasoning_checkpoint", data: { summary: "Use Postgres", artifactId: "private-artifact" } });
    await machine.appendEvent(event);
    return { eventId: event.id, projectId, turnId: `turn-${number}` };
  }
  function candidate(number: number, reference: Awaited<ReturnType<typeof evidence>>, options: Partial<ExtractedCandidate> = {}): ExtractedCandidate {
    return { id: id(number), audience: "workspace", projectIds: [reference.projectId], applicability: { kind: "projects", projectIds: [reference.projectId] },
      source: "transcript-rule", summary: "Use Postgres", content: { statement: "Use Postgres" }, tags: [], evidence: [reference], confidence: 0.8, salience: 0.8,
      extractor: { kind: "rule", id: "integration", version: "2" }, ...options };
  }
  return { worker, machine, human, evidence, candidate, entries };
}

it("uses actual HTTP identity and memory commands for machine proposal, human acceptance, and later machine support", async () => {
  const context = await fixture();
  const first = await context.evidence(1);
  expect(await context.worker.propose([context.candidate(1, first)])).toBe(1);
  const view = (await context.machine.memoryCandidates())[0]!;
  expect(view.candidate.proposerId).toBe("worker");
  const accepted = await context.human.acceptMemoryCandidate(view.candidate.id, { memoryId: id(100), stamp: { id: "accept-human", t: 2_000, worldDate: "2026-09-04" } });
  expect(accepted.memory.creatorId).toBe("human");
  const second = await context.evidence(2);
  await context.worker.propose([context.candidate(2, second)]);
  const memory = await context.human.memoryById(accepted.memory.id);
  expect(memory?.creatorId).toBe("human");
  expect(memory?.evidence).toEqual(expect.arrayContaining([first, second]));
  const contribution = context.entries.find(({ event }) => event.kind === "memory.evidence-contributed")!;
  expect(contribution.event.capture.identity?.principal).toBe("worker");
  expect(contribution.event.author).toEqual({ kind: "sensor", id: "urn:sensor:worker" });
});

it("does not broaden private evidence into workspace-wide candidate content", async () => {
  const context = await fixture();
  const reference = await context.evidence(1, "project-a", "private");
  expect(await context.worker.propose([context.candidate(1, reference)])).toBe(0);
  expect(await context.machine.memoryCandidates()).toHaveLength(0);
  await context.worker.propose([context.candidate(2, reference, { spaceId: "private" })]);
  expect((await context.machine.memoryCandidates())[0]?.candidate.spaceId).toBe("private");
});

it("does not attach old-claim support to a human-corrected accepted memory", async () => {
  const context = await fixture();
  await context.worker.propose([context.candidate(1, await context.evidence(1))]);
  const accepted = await context.human.acceptMemoryCandidate(id(1), { memoryId: id(100), stamp: { id: "accept-human", t: 2_000, worldDate: "2026-09-04" } });
  await context.human.reviseMemory(accepted.memory.id, { summary: "Use SQLite", content: { statement: "Use SQLite" } }, undefined,
    { stamp: { id: "human-correction", t: 3_000, worldDate: "2026-09-04" } });
  const later = await context.evidence(2);
  await context.worker.propose([context.candidate(2, later)]);
  expect((await context.human.memoryById(accepted.memory.id))?.evidence).not.toEqual(expect.arrayContaining([later]));
});

it("rejects a model response when its exact source revision was forgotten while the provider was running", async () => {
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void; const began = new Promise<void>((resolve) => { started = resolve; });
  const context = await fixture({ descriptor: { id: "test-model", kind: "model" }, async answer(request) {
    started(); await gate; return { answer: "Only the supplied evidence supports this.", citations: request.evidence.map(({ memoryId }) => memoryId) };
  } });
  const { memory } = await context.human.recordMemory({ id: id(100), audience: "workspace", source: "conversation", applicability: { kind: "global" }, content: "Current decision" });
  const pending = context.machine.askReasoning({ question: "What applies?", memoryRefs: [{ memoryId: memory.id, revision: memory.revision }] });
  const result = pending.then(() => ({ ok: true }), (error: unknown) => ({ ok: false, error }));
  try { await began; await context.human.forgetMemory(memory.id, "Outdated source"); }
  finally { release(); }
  expect(await result).toMatchObject({ ok: false });
});

it("continues deterministic proposals while an independent model request remains unresolved", async () => {
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void; const began = new Promise<void>((resolve) => { started = resolve; });
  const context = await fixture({ descriptor: { id: "test-model", kind: "model", configRevision: "fixture-v1" }, async answer(request) {
    started(); await gate; return { answer: "A reusable procedure follows from both projects.", citations: request.evidence.map(({ memoryId }) => memoryId) };
  } });
  for (const [number, projectId] of [[1, "project-a"], [2, "project-b"]] as const) {
    const evidence = await context.evidence(number, projectId);
    await context.human.recordMemory({ id: id(100 + number), audience: "workspace", source: "conversation", projectIds: [projectId],
      applicability: { kind: "projects", projectIds: [projectId] }, summary: `Accepted ${projectId} fact`, content: { statement: `Accepted ${projectId} fact` }, evidence: [evidence] });
  }
  const model = context.worker.synthesizeAcrossProjects({ id: "cross-project-trigger", kind: "memory.recorded", at: { t: 10, worldDate: "2026-09-04" } });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([began, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("model did not start")), 2_000); })]);
    clearTimeout(timer);
    const evidence = await context.evidence(3);
    const proposal = context.worker.propose([context.candidate(3, evidence)]);
    expect(await Promise.race([proposal, new Promise<"blocked">((resolve) => { timer = setTimeout(() => resolve("blocked"), 1_000); })])).toBe(1);
  } finally { clearTimeout(timer); release(); await model; }
  expect((await context.machine.memoryCandidates()).some(({ candidate }) => candidate.source === "continuous-cognition")).toBe(true);
});
