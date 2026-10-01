import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseEvent } from "@_89/fold";
import { SuperBrainApiError, type SuperBrainClient } from "@_89/super-brain-client";
import type { TranscriptRun } from "@_89/fold-transcript";
import { ProcessingJobStore, TranscriptMemoryWorker, processingDigest } from "../src/index.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const source = (id: string, project = "project-a", creator?: string) => parseEvent({ specVersion: "0.7", id, kind: "terminal.observation", title: "Observation", at: { t: 10, worldDate: "2026-09-15", granularity: "beat" }, author: { kind: "human", id: "user" }, participants: [], capture: { scope: { workspace: "workspace", ...(creator === undefined ? {} : { creator }) }, identity: { repo: project } }, changes: [{ verb: "create", subject: id, nodeKind: "fact", after: { label: id }, provenance: { basis: "authored" } }] });
async function fixture(count = 2) {
  const root = await mkdtemp(join(tmpdir(), "episode-jobs-")); roots.push(root);
  const events = Array.from({ length: count }, (_, index) => source(`event-${index}`));
  const synthesizeEpisodeWindow = vi.fn(async (input: any) => ({ schemaVersion: 1 as const, windowId: input.windowId,
    projectId: input.projectId, audience: input.audience, trigger: input.trigger, ...(input.parentWindowId === undefined ? {} : { parentWindowId: input.parentWindowId }),
    producer: { id: "metadata-coverage", version: "1" }, episodes: [],
    sources: input.sourceEventIds.map((eventId: string) => ({ eventId, sha256: processingDigest(events.find(event => event.id === eventId)) })),
    ungrouped: input.sourceEventIds.map((eventId: string) => ({ eventId, reason: "insufficient_content" })),
  }));
  const client = { eventById: vi.fn(async (id: string) => events.find(event => event.id === id)), synthesizeEpisodeWindow, publishEpisodeWindow: vi.fn().mockResolvedValue({}),
    episodePage: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    transcriptRuns: vi.fn().mockResolvedValue([{ id: "run", projectId: "project-a", segments: [] }]) };
  const options = { client: client as unknown as SuperBrainClient, vaultRoot: "/unused", episodeFormation: true, episodeEveryEvents: count };
  const worker = new TranscriptMemoryWorker(options);
  worker.configureProjectRoots([{ id: "run", projectId: "project-a", segments: [] }] as unknown as TranscriptRun[]);
  const store = new ProcessingJobStore(root); await store.open();
  return { root, store, worker, options, client, events };
}
describe("durable episode publication", () => {
  it("previews chosen sources without writes and queues identical manual sets exactly once", async () => {
    const { store, worker, client, events } = await fixture();
    const ids = events.map(event => event.id);
    const preview = await worker.queueEpisodeSources(ids, "project-a");
    expect(preview).toMatchObject({ mode: "dry-run", eligible: true, selected: 2 });
    expect(store.due()).toHaveLength(0); expect(client.synthesizeEpisodeWindow).not.toHaveBeenCalled();
    expect(await worker.queueEpisodeSources([...ids].reverse(), "project-a", store)).toMatchObject({ queued: true, windowId: (preview as any).windowId });
    expect(await worker.queueEpisodeSources(ids, "project-a", store)).toMatchObject({ queued: false });
    expect(store.due()).toHaveLength(1);
    expect(await worker.queueEpisodeSources(ids, "other-project")).toMatchObject({ eligible: false, problems: [{ eventId: ids[0] }, { eventId: ids[1] }] });
    await expect(worker.queueEpisodeSources(ids, "other-project", store)).rejects.toThrow("queue refused");
    await store.close();
  });
  it("persists preparation before delivery and retries a lost response without a second model call", async () => {
    const { root, store, worker, options, client, events } = await fixture();
    for (const [index, event] of events.entries()) await worker.scheduleEvent(store, event, String(index + 1));
    client.publishEpisodeWindow.mockRejectedValueOnce(new Error("response lost"));
    await worker.drainProcessingJobs(store, 1000);
    expect(client.synthesizeEpisodeWindow).toHaveBeenCalledTimes(1);
    expect(store.due(10000)[0]?.progress).toHaveProperty("episode");
    await store.close();
    const reopened = new ProcessingJobStore(root); await reopened.open();
    await new TranscriptMemoryWorker(options).drainProcessingJobs(reopened, 10000);
    expect(client.synthesizeEpisodeWindow).toHaveBeenCalledTimes(1);
    expect(client.publishEpisodeWindow).toHaveBeenCalledTimes(2);
    expect((await reopened.coverage()).completedReceipts).toBe(1); await reopened.close();
  });
  it("splits oversized windows without dropping sources and blocks an oversized singleton directly", async () => {
    const { store, worker, client, events } = await fixture(4);
    for (const [index, event] of events.entries()) await worker.scheduleEvent(store, event, String(index + 1));
    const prepare = client.synthesizeEpisodeWindow.getMockImplementation()!;
    client.synthesizeEpisodeWindow.mockImplementation(async (input: any) => {
      if (input.sourceEventIds.length > 1 || input.sourceEventIds[0] === "event-0") throw new SuperBrainApiError(413, "episode_input_too_large", "Too large");
      return prepare(input);
    });
    await worker.drainProcessingJobs(store, 1000);
    await worker.drainProcessingJobs(store, 1001);
    await worker.drainProcessingJobs(store, 1002);
    const coverage = await store.coverage();
    expect(coverage.active).toEqual([expect.objectContaining({ kind: "episode", status: "blocked", attempts: 0, reason: expect.stringContaining("single episode source") })]);
    expect(client.publishEpisodeWindow.mock.calls.flatMap(([input]) => input.sources.map((item: any) => item.eventId)).sort()).toEqual(["event-1", "event-2", "event-3"]);
    expect(client.publishEpisodeWindow.mock.calls.every(([input]) => typeof input.parentWindowId === "string")).toBe(true);
    await store.close();
  });
  it("excludes private, unknown, and mixed project sources before scheduling model work", async () => {
    const { store, worker, client } = await fixture(1);
    await worker.scheduleEvent(store, source("private", "project-a", "someone"), "1");
    await worker.scheduleEvent(store, source("unknown", "https://repo.example/a"), "2");
    await worker.drainProcessingJobs(store, 1000);
    expect(client.synthesizeEpisodeWindow).not.toHaveBeenCalled(); expect(store.due()).toHaveLength(0);
    await store.close();
  });
  it("does not publish a saved preparation after a trigger source becomes unavailable", async () => {
    const { store, worker, client, events } = await fixture(1);
    await worker.scheduleEvent(store, events[0]!, "1");
    client.publishEpisodeWindow.mockRejectedValueOnce(new Error("response lost"));
    await worker.drainProcessingJobs(store, 1000);
    client.eventById.mockResolvedValue(undefined);
    await worker.drainProcessingJobs(store, 10000);
    expect(client.publishEpisodeWindow).toHaveBeenCalledTimes(1);
    expect((await store.coverage()).active[0]?.status).toBe("waiting"); await store.close();
  });
  it("restarts a partial split without duplicating its already queued child", async () => {
    const { root, store, worker, options, client, events } = await fixture(4);
    for (const [index, event] of events.entries()) await worker.scheduleEvent(store, event, String(index + 1));
    const prepare = client.synthesizeEpisodeWindow.getMockImplementation()!;
    client.synthesizeEpisodeWindow.mockImplementation(async (input: any) => {
      if (input.sourceEventIds.length > 2) throw new SuperBrainApiError(413, "episode_input_too_large", "Too large");
      return prepare(input);
    });
    const enqueue = store.enqueue.bind(store);
    let calls = 0;
    vi.spyOn(store, "enqueue").mockImplementation(async (...args) => { if (++calls === 2) throw new Error("crash before second child"); return enqueue(...args); });
    await worker.drainProcessingJobs(store, 1000); await store.close();
    const reopened = new ProcessingJobStore(root); await reopened.open();
    const resumed = new TranscriptMemoryWorker(options);
    await resumed.drainProcessingJobs(reopened, 10000); await resumed.drainProcessingJobs(reopened, 10001);
    expect(client.publishEpisodeWindow).toHaveBeenCalledTimes(2);
    expect(client.publishEpisodeWindow.mock.calls.flatMap(([input]) => input.sources.map((item: any) => item.eventId)).sort()).toEqual(events.map(event => event.id));
    expect((await reopened.coverage()).active).toHaveLength(0); await reopened.close();
  });
  it("selects only bounded exact-scope context and discards stale prepared output on conflict", async () => {
    const { store, worker, client, events } = await fixture(1);
    client.episodePage.mockResolvedValue({ items: [
      { episodeId: "private", projectId: "project-a", audience: "personal" },
      { episodeId: "other", projectId: "project-b", audience: "workspace" },
      ...Array.from({ length: 7 }, (_, index) => ({ episodeId: `context-${index}`, projectId: "project-a", audience: "workspace" })),
    ], total: 9 });
    await worker.scheduleEvent(store, events[0]!, "1");
    client.publishEpisodeWindow.mockRejectedValueOnce(new SuperBrainApiError(409, "episode_conflict", "Revised"));
    await worker.drainProcessingJobs(store, 1000);
    expect(client.synthesizeEpisodeWindow.mock.calls[0]![0].contextEpisodeIds).toEqual(["context-0", "context-1", "context-2", "context-3", "context-4"]);
    expect(store.due(10000)[0]?.progress).toEqual({});
    await worker.drainProcessingJobs(store, 10000);
    expect(client.episodePage).toHaveBeenCalledTimes(2); expect(client.synthesizeEpisodeWindow).toHaveBeenCalledTimes(2);
    expect((await store.coverage()).active).toHaveLength(0); await store.close();
  });
  it("retries without oversized optional context before splitting source windows", async () => {
    const { store, worker, client, events } = await fixture(1);
    client.episodePage.mockResolvedValue({ items: [{ episodeId: "context", projectId: "project-a", audience: "workspace" }], total: 1 });
    await worker.scheduleEvent(store, events[0]!, "1");
    client.synthesizeEpisodeWindow.mockRejectedValueOnce(new SuperBrainApiError(413, "episode_input_too_large", "Too large"));
    await worker.drainProcessingJobs(store, 1000);
    expect(store.due(10000)[0]?.progress).toEqual({ episodeContext: { ids: [], omitted: true } });
    await worker.drainProcessingJobs(store, 10000);
    expect(client.synthesizeEpisodeWindow.mock.calls[1]![0].contextEpisodeIds).toEqual([]);
    expect(client.publishEpisodeWindow).toHaveBeenCalledTimes(1); expect((await store.coverage()).completedReceipts).toBe(1);
    await store.close();
  });
});
