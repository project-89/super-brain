import { mkdtemp, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseEvent, type FoldEvent } from "@_89/fold";
import { describe, expect, it, vi } from "vitest";

import { DurableSpool, parseCaptureConfig, SpoolProcessor } from "../src/index.js";

function config(stateRoot: string) {
  return parseCaptureConfig({
    apiUrl: "http://127.0.0.1:3003",
    workspaceId: "workspace-a",
    apiToken: "api-token",
    sensorId: "urn:sensor:test",
    hookToken: "hook-token",
    operatorToken: "operator-token",
    bindHost: "127.0.0.1",
    port: 8377,
    heartbeatWindowMs: 90_000,
    heartbeatIntervalMs: 30_000,
    orphanAfterMs: 86_400_000,
    stateRoot,
    vaultRoot: join(stateRoot, "vault"),
    reasoningPolicy: "exclude",
  });
}

function event(index: number): FoldEvent {
  const id = `01991c00-0000-7000-8000-${index.toString().padStart(12, "0")}`;
  return parseEvent({
    specVersion: "0.7",
    id: `01991c00-0000-7000-8000-${index.toString().padStart(12, "0")}`,
    kind: "test.observation",
    title: id,
    author: { kind: "sensor", id: "urn:sensor:test" },
    at: { t: index, worldDate: "2026-09-06" },
    capture: { scope: { workspace: "workspace-a" } },
    changes: [{
      verb: "create",
      subject: `urn:test:${id}`,
      nodeKind: "fact",
      after: { id },
      provenance: { basis: "observed", method: { kind: "sensor", id: "urn:sensor:test" } },
    }],
  });
}

async function queuedSpool(count: number): Promise<DurableSpool> {
  const root = await mkdtemp(join(tmpdir(), "super-brain-delivery-"));
  const spool = new DurableSpool(root);
  for (let index = 0; index < count; index += 1) {
    await spool.enqueue({
      version: 1,
      kind: "event",
      id: event(index).id,
      createdAt: new Date(index).toISOString(),
      event: event(index),
    });
  }
  return spool;
}

describe("spool delivery scheduling", () => {
  it("uses the current-tree endpoint for capture without requesting full trajectory analysis", async () => {
    const root = await mkdtemp(join(tmpdir(), "super-brain-tree-delivery-"));
    const spool = new DurableSpool(root);
    const tree = { taskId: "task", rootNodeId: "root", nodes: [{ id: "root", kind: "observation" as const, label: "Observed" }], edges: [] };
    await spool.enqueue({ version: 1, kind: "trajectory-tree", id: "tree-job", createdAt: new Date(0).toISOString(), treeStamp: { id: "tree", t: 1, worldDate: "2026-09-15" }, tree, captureIdentity: { session: "session" } });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ record: { tree } }));
    const processor = new SpoolProcessor(config(root), spool, undefined, undefined, { fetch: fetcher });
    await processor.flush();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]![0]).toContain("/trajectory-tasks/task/tree");
    expect((await spool.list())).toEqual([]);
  });

  it("upgrades a relocated legacy transcript to a durable snapshot before backend delivery", async () => {
    const root = await mkdtemp(join(tmpdir(), "super-brain-relocated-delivery-"));
    const id = "01a06ea8-b61d-7c11-af0d-1fc3dc02779d";
    const name = `rollout-2026-09-04T16-02-25-${id}.jsonl`;
    await mkdir(join(root, "archived_sessions"));
    const moved = join(root, "archived_sessions", name);
    await writeFile(moved, JSON.stringify({ type: "session_meta", payload: { id, cwd: root, timestamp: "2026-09-04T16:02:25Z" } }) + "\n");
    const spool = new DurableSpool(join(root, "state"));
    await spool.enqueue({ version: 1, kind: "transcript", id: "legacy-transcript", createdAt: new Date(0).toISOString(),
      notBefore: new Date(0).toISOString(), deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      source: "codex", path: join(root, "sessions", "2026", "09", "04", name) });
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("unavailable", { status: 503 }));
    try {
      const processor = new SpoolProcessor(config(join(root, "state")), spool, undefined, undefined, { transientBackoffMs: 0 });
      await processor.flush();
      const queued = (await spool.list())[0]!.job;
      expect(queued).toMatchObject({ kind: "transcript", ownedSnapshot: true });
      if (queued.kind !== "transcript") throw new Error("expected transcript");
      await unlink(moved);
      expect(await readFile(queued.path, "utf8")).toContain(id);
      await processor.flush();
      expect((await spool.list())[0]!.job).toEqual(queued);
      expect(fetcher).toHaveBeenCalled();
      expect(await spool.snapshot()).toMatchObject({ failedJobs: 0, pendingJobs: 1 });
    } finally { fetcher.mockRestore(); }
  });

  it("delivers at most one bounded batch per flush", async () => {
    const spool = await queuedSpool(5);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ entry: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const processor = new SpoolProcessor(config(join(tmpdir(), "unused")), spool, undefined, undefined, {
      fetch: fetcher,
      batchSize: 2,
    });

    await processor.flush();

    expect(fetcher).toHaveBeenCalledTimes(2);
    await expect(spool.snapshot()).resolves.toMatchObject({ pendingJobs: 3 });
  });

  it("backs off the whole spool after a transient backend failure", async () => {
    const spool = await queuedSpool(3);
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("fetch failed"));
    const processor = new SpoolProcessor(config(join(tmpdir(), "unused")), spool, undefined, undefined, {
      fetch: fetcher,
      transientBackoffMs: 60_000,
    });

    await processor.flush();
    await processor.flush();

    expect(fetcher).toHaveBeenCalledOnce();
    await expect(spool.snapshot()).resolves.toMatchObject({ pendingJobs: 3 });
    expect(processor.snapshot()).toMatchObject({ status: "retrying",
      countersSinceStart: { attempted: 1, delivered: 0, failures: 1 },
      blockedJob: { kind: "event" },
      lastFailure: { category: "delivery_error", disposition: "retry", stage: "delivery" },
    });
    expect(processor.snapshot().nextRetryAt).toBeDefined();
  });

  it("reports stack overflow without exposing raw error or job content, then reports recovery", async () => {
    const spool = await queuedSpool(1);
    const fetcher = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new RangeError("Maximum call stack size exceeded secret-token private-source"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ entry: {} }), { status: 200 }));
    const processor = new SpoolProcessor(config(join(tmpdir(), "unused")), spool, undefined, undefined, {
      fetch: fetcher, transientBackoffMs: 0,
    });
    await processor.flush();
    expect(processor.snapshot()).toMatchObject({ status: "retrying", lastFailure: { category: "stack_overflow" } });
    expect(processor.snapshot().blockedJob?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    const snapshot = JSON.stringify(processor.snapshot());
    for (const secret of ["secret-token", "private-source", "Maximum call stack", event(0).id, "api-token"]) {
      expect(snapshot).not.toContain(secret);
    }
    await processor.flush();
    expect(processor.snapshot()).toMatchObject({ status: "idle",
      countersSinceStart: { attempted: 2, delivered: 1, failures: 1 },
    });
    expect(processor.snapshot().blockedJob).toBeUndefined();
    expect(processor.snapshot().currentJob).toBeUndefined();
    expect(processor.snapshot().lastDeliveredAt).toBeDefined();
  });

  it("exposes pending in-flight attempts and bounded queue read failures", async () => {
    const spool = await queuedSpool(1);
    let complete!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>(() => new Promise((resolve) => { complete = resolve; }));
    const processor = new SpoolProcessor(config(join(tmpdir(), "unused")), spool, undefined, undefined, { fetch: fetcher });
    const flush = processor.flush();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    expect(processor.snapshot()).toMatchObject({ status: "processing", currentJob: { kind: "event" } });
    complete(new Response(JSON.stringify({ entry: {} }), { status: 200 }));
    await flush;
    const list = vi.spyOn(spool, "list").mockRejectedValueOnce(new Error("sensitive local file"));
    await expect(processor.flush()).rejects.toThrow("sensitive local file");
    expect(processor.snapshot()).toMatchObject({ status: "retrying" });
    expect(processor.snapshot().nextRetryAt).toBeDefined();
    expect(processor.snapshot().lastFailure).toMatchObject({ stage: "queue", category: "delivery_error" });
    expect(JSON.stringify(processor.snapshot())).not.toContain("sensitive local file");
    await processor.flush();
    expect(list).toHaveBeenCalledOnce();
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    try {
      await processor.flush();
      expect(processor.snapshot().status).toBe("idle");
    } finally { now.mockRestore(); }
  });
});
