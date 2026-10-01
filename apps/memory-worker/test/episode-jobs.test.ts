import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseEvent } from "@_89/fold";
import { SuperBrainApiError, type SuperBrainClient } from "@_89/super-brain-client";
import type { TranscriptRun } from "@_89/fold-transcript";
import { TranscriptMemoryWorker, processingDigest, type DurableWorkerJobs, type WorkerJob } from "../src/index.js";

const roots: string[] = [];
const workers: TranscriptMemoryWorker[] = [];
afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.close()));
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const source = (id: string, project = "project-a", creator?: string) => parseEvent({ specVersion: "0.7", id, kind: "terminal.observation", title: "Observation", at: { t: 10, worldDate: "2026-09-15", granularity: "beat" }, author: { kind: "human", id: "user" }, participants: [], capture: { scope: { workspace: "workspace", ...(creator === undefined ? {} : { creator }) }, identity: { repo: project } }, changes: [{ verb: "create", subject: id, nodeKind: "fact", after: { label: id }, provenance: { basis: "authored" } }] });
const runs = [{ id: "run", projectId: "project-a", segments: [] }] as unknown as TranscriptRun[];
async function active(worker: TranscriptMemoryWorker): Promise<WorkerJob[]> {
  await worker.coverage();
  return (worker as unknown as { store: DurableWorkerJobs }).store.active();
}
async function fixture(count = 2) {
  const root = await mkdtemp(join(tmpdir(), "episode-jobs-")); roots.push(root);
  const events = Array.from({ length: count }, (_, index) => source(`event-${index}`));
  const synthesizeEpisodeWindow = vi.fn(async (input: any) => ({ schemaVersion: 1 as const, windowId: input.windowId,
    projectId: input.projectId, audience: input.audience, trigger: input.trigger, ...(input.parentWindowId === undefined ? {} : { parentWindowId: input.parentWindowId }),
    producer: { id: "metadata-coverage", version: "1" }, episodes: [],
    sources: input.sourceEventIds.map((eventId: string) => ({ eventId, sha256: processingDigest(events.find(event => event.id === eventId)) })),
    ungrouped: input.sourceEventIds.map((eventId: string) => ({ eventId, reason: "insufficient_content" })),
  }));
  const client = {
    identity: vi.fn().mockResolvedValue({ principalId: "worker-a", organizationId: "org-a", workspaceId: "workspace-a" }),
    eventById: vi.fn(async (id: string) => events.find(event => event.id === id)), synthesizeEpisodeWindow, publishEpisodeWindow: vi.fn().mockResolvedValue({}),
    episodePage: vi.fn().mockResolvedValue({ items: [], total: 0 }), memoryById: vi.fn(),
    transcriptRuns: vi.fn().mockResolvedValue(runs) };
  let now = 1_000;
  const options = { client: client as unknown as SuperBrainClient, vaultRoot: "/unused", stateRoot: join(root, "jobs"), episodeFormation: true, episodeEveryEvents: count, retryBaseMs: 1, now: () => now };
  const open = () => { const worker = new TranscriptMemoryWorker(options); worker.configureProjectRoots(runs); workers.push(worker); return worker; };
  const at = (time: number) => { now = time; };
  return { worker: open(), open, at, client, events };
}
describe("durable episode publication", () => {
  it("previews chosen sources without writes and queues identical manual sets exactly once", async () => {
    const { worker, client, events } = await fixture();
    const ids = events.map(event => event.id);
    const preview = await worker.queueEpisodeSources(ids, "project-a");
    expect(preview).toMatchObject({ mode: "dry-run", eligible: true, selected: 2 });
    expect(client.identity).not.toHaveBeenCalled(); expect(client.synthesizeEpisodeWindow).not.toHaveBeenCalled();
    expect(await worker.queueEpisodeSources([...ids].reverse(), "project-a", true)).toMatchObject({ queued: true, windowId: (preview as any).windowId });
    expect(await worker.queueEpisodeSources(ids, "project-a", true)).toMatchObject({ queued: false });
    expect((await worker.coverage()).byKind.episode).toBe(1);
    expect(await worker.queueEpisodeSources(ids, "other-project")).toMatchObject({ eligible: false, problems: [{ eventId: ids[0] }, { eventId: ids[1] }] });
    await expect(worker.queueEpisodeSources(ids, "other-project", true)).rejects.toThrow("queue refused");
  });
  it("persists preparation before delivery and retries a lost response without a second model call", async () => {
    const { worker, open, at, client, events } = await fixture();
    for (const [index, event] of events.entries()) await worker.scheduleEvent(event, String(index + 1));
    client.publishEpisodeWindow.mockRejectedValueOnce(new Error("response lost"));
    await worker.drainModelJobs();
    expect(client.synthesizeEpisodeWindow).toHaveBeenCalledTimes(1);
    expect((await active(worker))[0]?.payload).toHaveProperty("episode");
    await worker.close();
    at(10_000);
    const reopened = open();
    await reopened.drainModelJobs();
    expect(client.synthesizeEpisodeWindow).toHaveBeenCalledTimes(1);
    expect(client.publishEpisodeWindow).toHaveBeenCalledTimes(2);
    expect((await reopened.coverage()).completed).toBe(1);
  });
  it("splits oversized windows without dropping sources and blocks an oversized singleton directly", async () => {
    const { worker, at, client, events } = await fixture(4);
    for (const [index, event] of events.entries()) await worker.scheduleEvent(event, String(index + 1));
    const prepare = client.synthesizeEpisodeWindow.getMockImplementation()!;
    client.synthesizeEpisodeWindow.mockImplementation(async (input: any) => {
      if (input.sourceEventIds.length > 1 || input.sourceEventIds[0] === "event-0") throw new SuperBrainApiError(413, "episode_input_too_large", "Too large");
      return prepare(input);
    });
    await worker.drainModelJobs(); at(1_001);
    await worker.drainModelJobs(); at(1_002);
    await worker.drainModelJobs();
    expect(await worker.coverage()).toMatchObject({ pending: 0, retry: 0, waiting: 0, blocked: 1 });
    expect(await active(worker)).toEqual([expect.objectContaining({ kind: "episode", state: "blocked", attempts: 0, reason: expect.stringContaining("single episode source") })]);
    expect(client.publishEpisodeWindow.mock.calls.flatMap(([input]) => input.sources.map((item: any) => item.eventId)).sort()).toEqual(["event-1", "event-2", "event-3"]);
    expect(client.publishEpisodeWindow.mock.calls.every(([input]) => typeof input.parentWindowId === "string")).toBe(true);
    expect(await worker.retryBlocked()).toBe(1);
  });
  it("excludes private, unknown, and mixed project sources before scheduling model work", async () => {
    const { worker, client } = await fixture(1);
    await worker.scheduleEvent(source("private", "project-a", "someone"), "1");
    await worker.scheduleEvent(source("unknown", "https://repo.example/a"), "2");
    await worker.drainModelJobs();
    expect(client.synthesizeEpisodeWindow).not.toHaveBeenCalled(); expect((await worker.coverage()).byKind.episode).toBe(0);
    expect(await worker.schedulingCoverage()).toEqual([expect.objectContaining({ through: "2", excludedSources: 2, openWindows: 0 })]);
  });
  it("does not publish a saved preparation after a trigger source becomes unavailable", async () => {
    const { worker, at, client, events } = await fixture(1);
    await worker.scheduleEvent(events[0]!, "1");
    client.publishEpisodeWindow.mockRejectedValueOnce(new Error("response lost"));
    await worker.drainModelJobs();
    client.eventById.mockResolvedValue(undefined);
    at(10_000); await worker.drainModelJobs();
    expect(client.publishEpisodeWindow).toHaveBeenCalledTimes(1);
    expect((await worker.coverage()).waiting).toBe(1);
  });
  it("restarts a partial split without duplicating its already queued child", async () => {
    const { worker, open, at, client, events } = await fixture(4);
    for (const [index, event] of events.entries()) await worker.scheduleEvent(event, String(index + 1));
    const prepare = client.synthesizeEpisodeWindow.getMockImplementation()!;
    client.synthesizeEpisodeWindow.mockImplementation(async (input: any) => {
      if (input.sourceEventIds.length > 2) throw new SuperBrainApiError(413, "episode_input_too_large", "Too large");
      return prepare(input);
    });
    const store = (worker as unknown as { store: DurableWorkerJobs }).store;
    const enqueue = store.enqueue.bind(store);
    let calls = 0;
    vi.spyOn(store, "enqueue").mockImplementation(async (...args) => { if (++calls === 2) throw new Error("crash before second child"); return enqueue(...args); });
    await worker.drainModelJobs(); await worker.close();
    const resumed = open();
    at(10_000); await resumed.drainModelJobs(); at(10_001); await resumed.drainModelJobs();
    expect(client.publishEpisodeWindow).toHaveBeenCalledTimes(2);
    expect(client.publishEpisodeWindow.mock.calls.flatMap(([input]) => input.sources.map((item: any) => item.eventId)).sort()).toEqual(events.map(event => event.id));
    expect(await active(resumed)).toHaveLength(0);
  });
  it("selects only bounded exact-scope context and discards stale prepared output on conflict", async () => {
    const { worker, at, client, events } = await fixture(1);
    client.episodePage.mockResolvedValue({ items: [
      { episodeId: "private", projectId: "project-a", audience: "personal" },
      { episodeId: "other", projectId: "project-b", audience: "workspace" },
      ...Array.from({ length: 7 }, (_, index) => ({ episodeId: `context-${index}`, projectId: "project-a", audience: "workspace" })),
    ], total: 9 });
    await worker.scheduleEvent(events[0]!, "1");
    client.publishEpisodeWindow.mockRejectedValueOnce(new SuperBrainApiError(409, "episode_conflict", "Revised"));
    await worker.drainModelJobs();
    expect(client.synthesizeEpisodeWindow.mock.calls[0]![0].contextEpisodeIds).toEqual(["context-0", "context-1", "context-2", "context-3", "context-4"]);
    const [saved] = await active(worker);
    expect(saved?.payload).not.toHaveProperty("episode"); expect(saved?.payload).not.toHaveProperty("episodeContext");
    at(10_000); await worker.drainModelJobs();
    expect(client.episodePage).toHaveBeenCalledTimes(2); expect(client.synthesizeEpisodeWindow).toHaveBeenCalledTimes(2);
    expect(await active(worker)).toHaveLength(0);
  });
  it("retries without oversized optional context before splitting source windows", async () => {
    const { worker, at, client, events } = await fixture(1);
    client.episodePage.mockResolvedValue({ items: [{ episodeId: "context", projectId: "project-a", audience: "workspace" }], total: 1 });
    await worker.scheduleEvent(events[0]!, "1");
    client.synthesizeEpisodeWindow.mockRejectedValueOnce(new SuperBrainApiError(413, "episode_input_too_large", "Too large"));
    await worker.drainModelJobs();
    expect((await active(worker))[0]?.payload).toMatchObject({ episodeContext: { ids: [], omitted: true } });
    at(10_000); await worker.drainModelJobs();
    expect(client.synthesizeEpisodeWindow.mock.calls[1]![0].contextEpisodeIds).toEqual([]);
    expect(client.publishEpisodeWindow).toHaveBeenCalledTimes(1); expect((await worker.coverage()).completed).toBe(1);
  });
});
