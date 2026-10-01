import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseEvent } from "@_89/fold";
import { DurableWindowScheduler, ProcessingBackpressureError, ProcessingJobStore, processingDigest, type SchedulingWindow } from "../src/index.js";

const roots: string[] = [];
const policy = processingDigest("exact-v1"); const partition = processingDigest("workspace");
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const event = (id: string, time = 10) => parseEvent({ specVersion: "0.7", id, kind: "memory.recorded", title: "Source", at: { t: time, worldDate: "2026-09-15", granularity: "beat" }, author: { kind: "human", id: "user" }, participants: [], capture: { scope: { workspace: "workspace" } }, changes: [{ verb: "create", subject: id, nodeKind: "fact", after: { label: id }, provenance: { basis: "authored" } }] });
async function fixture(every = 3, elapsedMs = 100, capacity = 1_000) {
  const root = await mkdtemp(join(tmpdir(), "scheduler-")); roots.push(root);
  const store = new ProcessingJobStore(root); await store.open();
  const delivered: SchedulingWindow[] = [];
  const deliver = vi.fn(async (window: SchedulingWindow) => { delivered.push(window); });
  const scheduler = new DurableWindowScheduler(store, policy, { every, elapsedMs, capacity, deliver }); await scheduler.open("0");
  return { root, store, scheduler, delivered, deliver };
}
describe("durable exact scheduling", () => {
  it("counts exactly N eligible arrivals, ignores replay, and includes old source timestamps", async () => {
    const { store, scheduler, delivered } = await fixture();
    await scheduler.observe("1", { event: event("a", 1_000), partition }, 10);
    await scheduler.observe("1", { event: event("a", 1_000), partition }, 11);
    await scheduler.observe("2", undefined, 12);
    await scheduler.observe("3", { event: event("b", 1), partition }, 13);
    expect(delivered).toHaveLength(0);
    await scheduler.observe("4", { event: event("c", -1), partition }, 14);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ trigger: "count", sources: [{ eventId: "a" }, { eventId: "b" }, { eventId: "c" }] });
    await store.close();
  });
  it("retains the exact count/deadline across restart and seals idle elapsed windows once", async () => {
    const { root, store, scheduler, deliver, delivered } = await fixture();
    await scheduler.observe("1", { event: event("a"), partition }, 10); await store.close();
    const reopened = new ProcessingJobStore(root); await reopened.open();
    const resumed = new DurableWindowScheduler(reopened, policy, { every: 3, elapsedMs: 100, deliver }); await resumed.open("999");
    await resumed.tick(109); expect(delivered).toHaveLength(0);
    await resumed.tick(110); await resumed.tick(111);
    expect(delivered).toHaveLength(1); expect(delivered[0]?.trigger).toBe("elapsed");
    await reopened.close();
  });
  it("recovers an atomic outbox after enqueue success and response loss without losing its source", async () => {
    const { root, store, scheduler, deliver } = await fixture(1);
    deliver.mockImplementationOnce(async (window) => { await store.enqueue("synthesis", window.id, event("a"), policy, window); throw new Error("lost result"); });
    await expect(scheduler.observe("1", { event: event("a"), partition }, 10)).rejects.toThrow("lost result");
    expect(store.due()).toHaveLength(1); await store.close();
    const reopened = new ProcessingJobStore(root); await reopened.open();
    const resumed = new DurableWindowScheduler(reopened, policy, { every: 1, elapsedMs: 100, deliver: (window, source) => reopened.enqueue("synthesis", window.id, source, policy, window) });
    await resumed.open("0"); await resumed.observe("1", { event: event("a"), partition }, 20);
    expect(reopened.due()).toHaveLength(1);
    expect((await reopened.readSchedulerState(policy) as any).outbox).toHaveLength(0);
    await reopened.close();
  });
  it("isolates partitions and makes completion/capacity explicit without dropping sources", async () => {
    const { store, scheduler, delivered } = await fixture(10, 100, 2);
    await scheduler.observe("1", { event: event("a"), partition }, 1);
    await scheduler.observe("2", { event: event("b"), partition: processingDigest("other") }, 2);
    await scheduler.observe("3", { event: event("c"), partition }, 3);
    await scheduler.observe("4", { event: event("d"), partition: processingDigest("other"), completion: true }, 4);
    expect(delivered.map(window => window.trigger)).toEqual(["capacity", "completion"]);
    expect(delivered.flatMap(window => window.sources.map(source => source.eventId)).sort()).toEqual(["a", "b", "c", "d"]);
    await store.close();
  });
  it("seals only one window when count and completion coincide", async () => {
    const { store, scheduler, delivered } = await fixture(2);
    await scheduler.observe("1", { event: event("a"), partition }, 1);
    await scheduler.observe("2", { event: event("b"), partition, completion: true }, 2);
    await scheduler.tick(1000);
    expect(delivered).toHaveLength(1); expect(delivered[0]?.trigger).toBe("completion");
    await store.close();
  });
  it("stores excluded counts without identifiers and starts a new policy only after its supplied baseline", async () => {
    const { store, scheduler } = await fixture();
    await scheduler.observe("1", undefined, 1, true); await scheduler.observe("1", undefined, 2, true);
    expect(await store.readSchedulerState(policy)).toMatchObject({ excluded: 1, windows: [] });
    const nextPolicy = processingDigest("exact-v2"); const deliver = vi.fn();
    const next = new DurableWindowScheduler(store, nextPolicy, { every: 1, elapsedMs: 100, deliver }); await next.open("10");
    await next.observe("9", { event: event("historical"), partition }, 2);
    await next.observe("11", { event: event("new"), partition }, 3);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(await store.readSchedulerState(policy)).toMatchObject({ through: "1", excluded: 1 });
    await store.close();
  });
  it("fails before advancing on a state write error and retries the same event", async () => {
    const { store, scheduler, delivered } = await fixture(1);
    vi.spyOn(store, "writeSchedulerState").mockRejectedValueOnce(new Error("disk full"));
    await expect(scheduler.observe("1", { event: event("a"), partition }, 10)).rejects.toThrow("disk full");
    expect(delivered).toHaveLength(0);
    await scheduler.observe("1", { event: event("a"), partition }, 10);
    expect(delivered).toHaveLength(1); await store.close();
  });
  it("quarantines malformed persisted state instead of skipping work", async () => {
    const { root, store } = await fixture(); await store.writeSchedulerState(policy, { version: 1, policy, through: "garbage" }); await store.close();
    const reopened = new ProcessingJobStore(root); await reopened.open();
    await expect(new DurableWindowScheduler(reopened, policy, { every: 3, elapsedMs: 100, deliver: vi.fn() }).open("0")).rejects.toThrow("Invalid durable scheduler state");
    await reopened.close();
  });
  it("can seal and drain an admitted window close to the byte limit", async () => {
    const { store, scheduler, delivered } = await fixture(3);
    const large = { ...event("large"), title: "x".repeat(15 * 1024 * 1024 - 2_000) };
    await scheduler.observe("1", { event: large, partition }, 1);
    expect(delivered).toHaveLength(0);
    await scheduler.tick(101);
    expect(delivered).toHaveLength(1);
    expect(await store.readSchedulerState(policy)).toMatchObject({ windows: [], outbox: [] });
    await store.close();
  });
  it("restarts with a full processing queue and retained outbox, then drains without losing either job", async () => {
    const root = await mkdtemp(join(tmpdir(), "scheduler-full-")); roots.push(root);
    const store = new ProcessingJobStore(root, undefined, 1); await store.open();
    await store.enqueue("live", "existing", event("existing"));
    const scheduler = new DurableWindowScheduler(store, policy, { every: 1, elapsedMs: 100,
      deliver: (window, source) => store.enqueue("synthesis", window.id, source, policy, window) });
    await scheduler.open("0");
    await scheduler.observe("1", { event: event("queued"), partition }, 1);
    expect(await store.readSchedulerState(policy)).toMatchObject({ through: "1", outbox: [{ anchor: { id: "queued" } }] });
    await store.close();
    const reopened = new ProcessingJobStore(root, undefined, 1); await reopened.open();
    const resumed = new DurableWindowScheduler(reopened, policy, { every: 1, elapsedMs: 100,
      deliver: (window, source) => reopened.enqueue("synthesis", window.id, source, policy, window) });
    await resumed.open("1"); await resumed.tick(101);
    expect(reopened.due()).toHaveLength(1);
    expect(await reopened.readSchedulerState(policy)).toMatchObject({ outbox: [{ anchor: { id: "queued" } }] });
    await reopened.save({ ...reopened.due()[0]!, status: "complete" });
    await resumed.tick(102);
    expect(reopened.due()).toMatchObject([{ kind: "synthesis", input: { id: "queued" } }]);
    expect(await reopened.readSchedulerState(policy)).toMatchObject({ outbox: [] });
    expect((await reopened.coverage()).completedReceipts).toBe(1); await reopened.close();
  });
  it("keeps timed windows durable when sealing hits temporary capacity and allows the drain pump to continue", async () => {
    const { store, scheduler, delivered } = await fixture();
    await scheduler.observe("1", { event: event("a"), partition }, 1);
    vi.spyOn(store, "writeSchedulerState").mockRejectedValueOnce(new ProcessingBackpressureError("full outbox"));
    await expect(scheduler.tick(101)).resolves.toBeUndefined();
    expect(delivered).toHaveLength(0);
    expect(await store.readSchedulerState(policy)).toMatchObject({ windows: [{ sources: [{ eventId: "a" }] }], outbox: [] });
    await scheduler.tick(102); expect(delivered).toHaveLength(1);
    await store.close();
  });
});
