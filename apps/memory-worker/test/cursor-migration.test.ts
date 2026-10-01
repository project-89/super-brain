import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTranscriptRunEvent } from "@_89/fold-transcript";
import type { SuperBrainClient } from "@_89/super-brain-client";
import { migrateWorkerCursor } from "../src/cursor-migration.js";
import { DurableWorkerJobs, jobDigest } from "../src/jobs.js";
import { MEMORY_WORKER_EVENT_KINDS } from "../src/subscription.js";
import { TranscriptMemoryWorker } from "../src/worker.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "memory-cursor-migration-")); roots.push(root);
  const legacyCursor = { t: 1789496431054, eventId: "old-event" };
  const headCursor = { kind: "ingestion" as const, sequence: "90071992547409930" };
  const client = {
    ingestionConsumerStatus: vi.fn().mockResolvedValue({ cursor: null, legacyCursor, headCursor, migrationRequired: true }),
    migrateConsumerCursor: vi.fn().mockResolvedValue({ cursor: { kind: "ingestion", sequence: "0" }, legacyCursor, headCursor, migrationRequired: false }),
  };
  return {
    client, root, legacyCursor, headCursor,
    options: { client, consumerId: "existing-consumer", organizationId: "org", workspaceId: "workspace", audience: "workspace" as const, stateRoot: join(root, "spool"), namespace: "namespace" },
  };
}

describe("worker ingestion cursor migration", () => {
  it("defaults to a scoped metadata-only preview without creating the spool", async () => {
    const { client, options, root, legacyCursor, headCursor } = await fixture();
    const result = await migrateWorkerCursor(options);
    expect(client.ingestionConsumerStatus).toHaveBeenCalledExactlyOnceWith("existing-consumer", { kinds: MEMORY_WORKER_EVENT_KINDS });
    expect(client.migrateConsumerCursor).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
    expect(result).toMatchObject({ mode: "dry-run", scope: { organizationId: "org", workspaceId: "workspace", audience: "workspace" }, legacyCursor, headCursor, migrationRequired: true, reachedSampledHead: false });
  });

  it("requires confirmation for migration, preserves reported legacy metadata and does not enqueue", async () => {
    const { client, options, legacyCursor } = await fixture();
    const result = await migrateWorkerCursor({ ...options, confirm: true });
    expect(client.migrateConsumerCursor).toHaveBeenCalledExactlyOnceWith("existing-consumer", { kinds: MEMORY_WORKER_EVENT_KINDS });
    expect(client.ingestionConsumerStatus).not.toHaveBeenCalled();
    expect(result).toMatchObject({ mode: "apply", cursor: { kind: "ingestion", sequence: "0" }, legacyCursor, migrationRequired: false });
    const ledger = join(options.stateRoot, jobDigest(options.namespace));
    expect(await readdir(join(ledger, "active"))).toEqual([]);
    expect(await readdir(ledger)).not.toContain("lease.json");
  });

  it("refuses confirmation while the same watcher owns the spool, but allows a preview", async () => {
    const { client, options } = await fixture();
    const watcher = new DurableWorkerJobs(options.stateRoot, options.namespace);
    await watcher.open();
    try {
      await expect(migrateWorkerCursor({ ...options, confirm: true })).rejects.toThrow("owns this processing namespace");
      expect(client.migrateConsumerCursor).not.toHaveBeenCalled();
      await migrateWorkerCursor(options);
      expect(client.ingestionConsumerStatus).toHaveBeenCalledOnce();
    } finally { await watcher.close(); }
  });

  it("fails closed on authorization errors and releases a confirmed migration claim", async () => {
    const { client, options } = await fixture();
    client.ingestionConsumerStatus.mockRejectedValueOnce(new Error("access denied"));
    await expect(migrateWorkerCursor(options)).rejects.toThrow("access denied");
    expect(client.migrateConsumerCursor).not.toHaveBeenCalled();
    client.migrateConsumerCursor.mockRejectedValueOnce(new Error("access denied"));
    await expect(migrateWorkerCursor({ ...options, confirm: true })).rejects.toThrow("access denied");
    expect(await readdir(join(options.stateRoot, jobDigest(options.namespace)))).not.toContain("lease.json");
  });

  it("does not reinterpret or reset existing ingestion progress and compares bigint cursors exactly", async () => {
    const { client, options, headCursor, legacyCursor } = await fixture();
    for (const sequence of ["90071992547409929", "90071992547409930", "90071992547409931"]) {
      client.ingestionConsumerStatus.mockResolvedValueOnce({ cursor: { kind: "ingestion", sequence }, legacyCursor, headCursor, migrationRequired: false });
      const result = await migrateWorkerCursor(options);
      expect(result.cursor?.sequence).toBe(sequence);
      expect(result.reachedSampledHead).toBe(BigInt(sequence) >= BigInt(headCursor.sequence));
    }
    expect(client.migrateConsumerCursor).not.toHaveBeenCalled();
  });

  it("deduplicates replayed transcript work across restart with cognition disabled without dropping receipts", async () => {
    const { options } = await fixture();
    const event = makeTranscriptRunEvent({ author: { kind: "ingest", id: "importer" }, capture: { scope: { workspace: "workspace" }, identity: { source: "codex" } } }, { id: "historical-run", t: 1, worldDate: "2026-09-15" }, {
      id: "codex:session", nativeId: "session", source: "codex", artifactId: `artifact-${"a".repeat(64)}`,
      projectId: "project-a", projectResolution: "resolved", startedAt: "2026-09-15T10:00:00Z",
      counts: { records: 1, turns: 1, messages: 1, actions: 0, unknown: 0 }, segments: [],
    });
    const client = { identity: vi.fn().mockResolvedValue({ principalId: "worker", organizationId: "org", workspaceId: "workspace" }) };
    const workerOptions = { client: client as unknown as SuperBrainClient, vaultRoot: "/unused", stateRoot: options.stateRoot, autoPromote: true };
    const original = new TranscriptMemoryWorker({ ...workerOptions, continuousCognition: true });
    expect(await original.scheduleEvent(event)).toBe(1);
    await original.close();
    const worker = new TranscriptMemoryWorker({ ...workerOptions, continuousCognition: false });
    try {
      expect(await worker.scheduleEvent(event)).toBe(0);
      expect(await worker.coverage()).toMatchObject({ pending: 1, byKind: { "extract-run": 1 } });
      const store = (worker as unknown as { store: DurableWorkerJobs }).store;
      const [job] = await store.active();
      await store.put({ ...job!, state: "completed", updatedAt: 2 });
      expect(await worker.scheduleEvent(event)).toBe(0);
      expect(await worker.coverage()).toMatchObject({ pending: 0, completed: 1 });
    } finally { await worker.close(); }
  });

  it("opts only the durable watcher into batched checkpoints with the same migration subscription", async () => {
    const { options } = await fixture();
    const consumeEvents = vi.fn().mockResolvedValue(undefined);
    const client = { identity: vi.fn().mockResolvedValue({ principalId: "worker", workspaceId: "workspace" }), memoryCandidates: vi.fn().mockResolvedValue([]),
      transcriptRuns: vi.fn().mockResolvedValue([]), listEvents: vi.fn().mockResolvedValue([]), consumeEvents };
    await new TranscriptMemoryWorker({ client: client as unknown as SuperBrainClient, vaultRoot: "/unused", stateRoot: options.stateRoot, pollIntervalMs: 1 }).watch({ consumerId: options.consumerId });
    expect(consumeEvents).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      consumerId: options.consumerId, checkpointEvery: 100, kinds: MEMORY_WORKER_EVENT_KINDS,
    }));
  });
});
