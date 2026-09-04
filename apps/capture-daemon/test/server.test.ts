import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  CaptureEngine,
  CaptureHttpServer,
  DurableSpool,
  HookVault,
  StateStore,
  parseCaptureConfig,
} from "../src/index.js";

describe("capture operator settings", () => {
  it("requires the separate operator token and applies validated policy changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "super-brain-capture-server-"));
    const parsed = parseCaptureConfig({
      apiUrl: "http://127.0.0.1:3003",
      workspaceId: "workspace-a",
      apiToken: "api-token",
      sensorId: "urn:sensor:super-brain-capture:test",
      hookToken: "hook-token",
      operatorToken: "operator-token",
      bindHost: "127.0.0.1",
      port: 8377,
      heartbeatWindowMs: 90_000,
      heartbeatIntervalMs: 30_000,
      orphanAfterMs: 86_400_000,
      stateRoot: join(root, "state"),
      vaultRoot: join(root, "vault"),
      reasoningPolicy: "exclude",
    });
    const config = { ...parsed, port: 0 };
    const spool = new DurableSpool(config.stateRoot);
    const engine = new CaptureEngine(config, new StateStore(config.stateRoot), new HookVault(config.vaultRoot), spool);
    await engine.initialize();
    const update = vi.fn(async (patch) => ({ ...config, ...patch }));
    const server = new CaptureHttpServer(config, engine, spool, update);
    const address = await server.start();
    const url = `http://${address.host}:${address.port}/settings`;
    try {
      expect((await fetch(url)).status).toBe(401);
      const headers = { "x-super-brain-operator-token": "operator-token" };
      const initial = await fetch(url, { headers });
      await expect(initial.json()).resolves.toMatchObject({
        policy: { anonymizationPolicy: "none", treeSnapshotEveryEvents: 25 },
        restartRequired: false,
      });
      const changed = await fetch(url, {
        method: "PATCH",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          reasoningPolicy: "include",
          reasoningTreePolicy: "summaries",
          retainEncryptedReasoning: true,
          anonymizationPolicy: "strict",
          treeSnapshotEveryEvents: 40,
        }),
      });
      expect(changed.status).toBe(200);
      await expect(changed.json()).resolves.toMatchObject({
        policy: { reasoningPolicy: "include", anonymizationPolicy: "strict", treeSnapshotEveryEvents: 40 },
        restartRequired: true,
      });
      expect(update).toHaveBeenCalledOnce();
    } finally {
      await server.close();
    }
  });
});
