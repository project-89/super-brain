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
  SpoolProcessor,
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
    const vault = new HookVault(config.vaultRoot);
    const engine = new CaptureEngine(config, new StateStore(config.stateRoot), vault, spool);
    await engine.initialize();
    const artifact = await vault.store("codex", { session_id: "session-a", hook_event_name: "PostToolUse", output: "complete" }, 1);
    const update = vi.fn(async (patch) => ({ ...config, ...patch }));
    const delivery = new SpoolProcessor(config, spool);
    const server = new CaptureHttpServer(config, engine, spool, update, undefined, () => delivery.snapshot());
    const address = await server.start();
    const url = `http://${address.host}:${address.port}/settings`;
    try {
      const health = await fetch(`http://${address.host}:${address.port}/health`);
      await expect(health.json()).resolves.toMatchObject({
        status: "ok", delivery: { status: "idle", countersSinceStart: { attempted: 0, delivered: 0, failures: 0 } },
      });
      expect((await fetch(url)).status).toBe(401);
      const processingUrl = `http://${address.host}:${address.port}/processing`;
      expect((await fetch(processingUrl, { headers: { "x-super-brain-token": "hook-token" } })).status).toBe(401);
      expect((await fetch(processingUrl, { headers: { "x-super-brain-operator-token": "operator-token" } })).status).toBe(200);
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

      const decisionUrl = `http://${address.host}:${address.port}/decision`;
      const decision = { session_id: "decision-session", summary: "Checked the outcome", verdict: "success" };
      expect((await fetch(decisionUrl, { method: "POST", headers: { "x-super-brain-hook-token": "hook-token" }, body: JSON.stringify(decision) })).status).toBe(401);
      const accepted = await fetch(decisionUrl, { method: "POST", headers, body: JSON.stringify(decision) });
      expect(accepted.status).toBe(202);
      await expect(accepted.json()).resolves.toMatchObject({ accepted: true, receiptId: expect.any(String) });
      // A caller-selected authority field on the agent hook interface cannot attest operator provenance.
      const claimed = await fetch(`http://${address.host}:${address.port}/hook`, {
        method: "POST", headers: { "x-super-brain-hook-token": "hook-token" },
        body: JSON.stringify({ ...decision, hook_event_name: "HumanDecision", authority: "operator" }),
      });
      expect(claimed.status).toBe(401);
      await expect(claimed.json()).resolves.toEqual({ error: "operator_authority_required" });

      const artifactUrl = `http://${address.host}:${address.port}/hook-artifacts/codex/${artifact.id}`;
      expect((await fetch(artifactUrl)).status).toBe(401);
      const artifactResponse = await fetch(artifactUrl, { headers });
      expect(artifactResponse.status).toBe(200);
      await expect(artifactResponse.json()).resolves.toMatchObject({
        artifact: { id: artifact.id, source: "codex", payload: { output: "complete" } },
      });
    } finally {
      await server.close();
    }
  });
});
