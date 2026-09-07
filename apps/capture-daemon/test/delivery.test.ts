import { mkdtemp } from "node:fs/promises";
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
  });
});
