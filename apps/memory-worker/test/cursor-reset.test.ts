import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetWorkerCursor } from "../src/cursor-migration.js";
import { DurableWorkerJobs, jobDigest } from "../src/jobs.js";
import { MEMORY_WORKER_EVENT_KINDS } from "../src/subscription.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "memory-cursor-reset-")); roots.push(root);
  const status = { cursor: { kind: "ingestion", sequence: "1234" }, legacyCursor: { t: 100, eventId: "old" }, headCursor: { kind: "ingestion", sequence: "2345" }, migrationRequired: false };
  const client = {
    ingestionConsumerStatus: vi.fn().mockResolvedValue(status),
    resetConsumerCursor: vi.fn().mockResolvedValue({ ...status, cursor: { kind: "ingestion", sequence: "0" } }),
  };
  return { root, client, options: { client, consumerId: "worker", organizationId: "org", workspaceId: "workspace", audience: "workspace" as const, stateRoot: join(root, "spool"), namespace: "namespace", expectedSequence: "1234", reason: "Repair incomplete ingestion replay" } };
}

describe("explicit worker cursor reset", () => {
  it("previews current and requested positions without any spool or cursor writes", async () => {
    const { root, client, options } = await fixture();
    expect(await resetWorkerCursor(options)).toMatchObject({ mode: "dry-run", expectedMatches: true, requestedReset: { expectedCursor: { kind: "ingestion", sequence: "1234" }, targetCursor: { kind: "ingestion", sequence: "0" } } });
    expect(client.ingestionConsumerStatus).toHaveBeenCalledExactlyOnceWith("worker", { kinds: MEMORY_WORKER_EVENT_KINDS });
    expect(client.resetConsumerCursor).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
    expect(await resetWorkerCursor({ ...options, expectedSequence: "1233" })).toMatchObject({ expectedMatches: false });
  });

  it("sends explicit expected cursor and reason under a claim while preserving completed receipts", async () => {
    const { client, options } = await fixture();
    const store = new DurableWorkerJobs(options.stateRoot, options.namespace);
    await store.open();
    const job = await store.enqueue("extract-run", "completed-run", {});
    await store.put({ ...job, state: "completed", updatedAt: job.updatedAt + 1 });
    await store.close();
    const result = await resetWorkerCursor({ ...options, confirm: true });
    expect(client.resetConsumerCursor).toHaveBeenCalledExactlyOnceWith("worker", { kind: "ingestion", sequence: "1234" }, options.reason, { kinds: MEMORY_WORKER_EVENT_KINDS });
    expect(result).toMatchObject({ mode: "apply", cursor: { kind: "ingestion", sequence: "0" }, legacyCursor: { t: 100, eventId: "old" } });
    const reopened = new DurableWorkerJobs(options.stateRoot, options.namespace);
    await reopened.open();
    try { expect(await reopened.coverage()).toMatchObject({ pending: 0, completed: 1 }); } finally { await reopened.close(); }
    expect(await readdir(join(options.stateRoot, jobDigest(options.namespace)))).not.toContain("lease.json");
  });

  it("refuses a running watcher and does not invoke reset", async () => {
    const { client, options } = await fixture();
    const store = new DurableWorkerJobs(options.stateRoot, options.namespace); await store.open();
    try {
      await expect(resetWorkerCursor({ ...options, confirm: true })).rejects.toThrow("owns this processing namespace");
      expect(client.resetConsumerCursor).not.toHaveBeenCalled();
    } finally { await store.close(); }
  });

  it.each([403, 409])("propagates server refusal %s without retrying and releases the claim", async (status) => {
    const { client, options } = await fixture();
    client.resetConsumerCursor.mockRejectedValueOnce(Object.assign(new Error(status === 403 ? "administrator required" : "expected cursor is stale"), { status }));
    await expect(resetWorkerCursor({ ...options, confirm: true })).rejects.toMatchObject({ status });
    expect(client.resetConsumerCursor).toHaveBeenCalledTimes(1);
    expect(await readdir(join(options.stateRoot, jobDigest(options.namespace)))).not.toContain("lease.json");
  });

  it("rejects malformed cursor and inadequate reset reasons before reading or claiming", async () => {
    const { client, options, root } = await fixture();
    for (const expectedSequence of ["-1", "01", "1.5", "9223372036854775808"]) {
      await expect(resetWorkerCursor({ ...options, expectedSequence, confirm: true })).rejects.toThrow("--expected-sequence");
    }
    await expect(resetWorkerCursor({ ...options, reason: "short", confirm: true })).rejects.toThrow("--reason");
    expect(client.resetConsumerCursor).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  });
});
