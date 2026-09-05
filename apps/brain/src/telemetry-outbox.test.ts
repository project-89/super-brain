import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import type { TelemetryBatch } from "@_89/super-brain-client";
import { BrowserTelemetryOutbox } from "./telemetry-outbox";

const alice = { organizationId: "fixture-org", workspaceId: "fixture-workspace", principalId: "alice" };
const bob = { ...alice, principalId: "bob" };
function batch(id = "batch-a"): TelemetryBatch {
  return { version: 1, subject: alice, stamp: { id, t: 10, worldDate: "2026-09-04" }, items: [{ stamp: { id: `${id}-item`, t: 9, worldDate: "2026-09-04" }, memoryId: "memory-a", input: { version: 2, memoryRevision: 0, recallId: "recall-a", signal: "offered", rank: 1, detail: "private question must not persist" } }] };
}
describe("durable browser feedback", () => {
  it("survives reopening and retries the same exact batch after a lost acknowledgement", async () => {
    const indexedDB = new IDBFactory(); let now = 100; const delivered: TelemetryBatch[] = [];
    const first = new BrowserTelemetryOutbox({ indexedDB, now: () => now, subject: async () => alice, deliver: async (value) => { delivered.push(value); throw new TypeError("lost acknowledgement"); } });
    await first.enqueue(batch()); await first.flush(); expect(await first.status()).toMatchObject({ retry: 1 }); await first.close();
    now += 10_000;
    const reopened = new BrowserTelemetryOutbox({ indexedDB, now: () => now, subject: async () => alice, deliver: async (value) => { delivered.push(value); } });
    await reopened.flush(); expect(delivered).toHaveLength(2); expect(delivered[1]).toEqual(delivered[0]); expect(JSON.stringify(delivered)).not.toContain("private question"); expect(delivered[0]?.items[0]?.input.memoryRevision).toBe(0); expect(await reopened.status()).toMatchObject({ pending: 0, retry: 0 }); await reopened.close();
  });
  it("defers another account's partition and sends the original expected subject", async () => {
    let identity = bob; const deliver = vi.fn(async (_batch: TelemetryBatch) => undefined); const store = new BrowserTelemetryOutbox({ indexedDB: new IDBFactory(), subject: async () => identity, deliver });
    await store.enqueue(batch()); await store.flush(); expect(deliver).not.toHaveBeenCalled(); expect(await store.status()).toMatchObject({ pending: 0 }); identity = alice; await store.flush(); expect(deliver.mock.calls[0]?.[0]).toMatchObject({ subject: alice }); await store.close();
  });
  it("handles token/account change during dispatch as a deferred batch without consuming retry budget", async () => {
    let now = 100; const deliver = vi.fn().mockRejectedValueOnce({ status: 409, code: "feedback_subject_changed" }).mockResolvedValue(undefined);
    const store = new BrowserTelemetryOutbox({ indexedDB: new IDBFactory(), subject: async () => alice, deliver, now: () => now, maxAttempts: 1 });
    await store.enqueue(batch()); await store.flush(); expect(await store.status()).toMatchObject({ pending: 1, denied: 0, exhausted: 0 }); now += 6_000; await store.flush(); expect(await store.status()).toMatchObject({ pending: 0 }); await store.close();
  });
  it("deduplicates exact enqueue, rejects changed bodies, and bounds the queue", async () => {
    const store = new BrowserTelemetryOutbox({ indexedDB: new IDBFactory(), subject: async () => alice, deliver: async () => undefined, maxBatches: 1 });
    await store.enqueue(batch()); await store.enqueue(batch()); expect(await store.status()).toMatchObject({ pending: 1 });
    await expect(store.enqueue({ ...batch(), items: [{ ...batch().items[0]!, memoryId: "different" }] })).rejects.toThrow("reused");
    await expect(store.enqueue(batch("batch-b"))).rejects.toThrow("full"); await store.close();
  });
  it("claims across two tabs, retaining stable identity if a lease is recovered", async () => {
    const indexedDB = new IDBFactory(); let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); const deliver = vi.fn(async () => gate);
    const options = { indexedDB, subject: async () => alice, deliver };
    const first = new BrowserTelemetryOutbox(options); const second = new BrowserTelemetryOutbox(options);
    await first.enqueue(batch()); const draining = first.flush(); await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce()); await second.flush(); expect(deliver).toHaveBeenCalledOnce(); release(); await draining; await first.close(); await second.close();
  });
  it("exposes denied, exhausted and unavailable storage without losing reads", async () => {
    const store = new BrowserTelemetryOutbox({ indexedDB: new IDBFactory(), subject: async () => alice, deliver: async () => { throw { status: 403 }; } });
    await store.enqueue(batch()); await store.flush(); expect(await store.status()).toMatchObject({ denied: 1 }); await store.close();
    const retry = new BrowserTelemetryOutbox({ indexedDB: new IDBFactory(), subject: async () => alice, maxAttempts: 1, deliver: async () => { throw new TypeError("offline"); } });
    await retry.enqueue(batch()); await retry.flush(); expect(await retry.status()).toMatchObject({ exhausted: 1 }); await retry.close();
    const broken = new BrowserTelemetryOutbox({ indexedDB: { open() { throw new Error("quota unavailable"); } } as unknown as IDBFactory, subject: async () => alice, deliver: async () => undefined });
    await expect(broken.enqueue(batch())).rejects.toThrow("quota unavailable"); expect(await broken.status()).toMatchObject({ unavailable: "quota unavailable" }); await broken.close();
  });
});

it("preserves shared transport classifications, repairs terminal rows and recovers temporary database failure", async () => {
  const { SuperBrainApiError } = await import("@_89/super-brain-client");
  for (const [code, status, expected] of [["token_unavailable", 0, "pending"], ["aborted", 0, "pending"], ["invalid_response", 0, "exhausted"], ["bad_input", 400, "exhausted"], ["workspace_access_denied", 403, "denied"]] as const) {
    const store = new BrowserTelemetryOutbox({ indexedDB: new IDBFactory(), subject: async () => alice, deliver: async () => { throw new SuperBrainApiError(status, code, code); } });
    await store.enqueue(batch()); await store.flush(); expect((await store.status())[expected]).toBe(1);
    if (expected !== "pending") { expect(await store.retryTerminal()).toBe(1); expect(await store.status()).toMatchObject({ pending: 1, denied: 0, exhausted: 0 }); }
    await store.close();
  }
  const factory = new IDBFactory(); let unavailable = true;
  const store = new BrowserTelemetryOutbox({ indexedDB: { open(...args: Parameters<IDBFactory["open"]>) { if (unavailable) throw new Error("temporary storage failure"); return factory.open(...args); } } as IDBFactory, subject: async () => alice, deliver: async () => undefined });
  await expect(store.enqueue(batch())).rejects.toThrow("temporary"); unavailable = false;
  expect((await store.status()).unavailable).toContain("Some feedback was not stored"); await store.retryTerminal(); await store.enqueue(batch()); expect(await store.status()).toMatchObject({ pending: 1 }); await store.close();
});

it("retains a rejection with an undefined reason, and closes a cancelled drain without losing the batch", async () => {
  const store = new BrowserTelemetryOutbox({ indexedDB: new IDBFactory(), subject: async () => alice, deliver: async () => Promise.reject(undefined) });
  await store.enqueue(batch()); await store.flush(); expect(await store.status()).toMatchObject({ retry: 1 }); await store.close();
  const indexedDB = new IDBFactory(); let started!: () => void; const begun = new Promise<void>((resolve) => { started = resolve; });
  const active = new BrowserTelemetryOutbox({ indexedDB, subject: async () => alice, deliver: async (_batch, signal) => { started(); await new Promise<void>((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true })); } });
  await active.enqueue(batch()); const draining = active.flush(); await begun; await active.close(); await draining;
  const reopened = new BrowserTelemetryOutbox({ indexedDB, subject: async () => alice, deliver: async () => undefined }); expect(await reopened.status()).toMatchObject({ pending: 1, exhausted: 0 }); await reopened.close();
});
