import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  CaptureEngine,
  CaptureHttpServer,
  DurableSpool,
  HookInbox,
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
    const server = new CaptureHttpServer(config, engine, spool, update, undefined, undefined, () => delivery.snapshot());
    const address = await server.start();
    const url = `http://${address.host}:${address.port}/settings`;
    try {
      const health = await fetch(`http://${address.host}:${address.port}/health`);
      await expect(health.json()).resolves.toMatchObject({
        status: "ok", delivery: { status: "idle", countersSinceStart: { attempted: 0, delivered: 0, failures: 0 } },
      });
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

      const decisionUrl = `http://${address.host}:${address.port}/decision`;
      const decision = { session_id: "decision-session", summary: "Checked the outcome", verdict: "success" };
      expect((await fetch(decisionUrl, { method: "POST", headers: { "x-super-brain-hook-token": "hook-token" }, body: JSON.stringify(decision) })).status).toBe(401);
      const ingest = vi.spyOn(engine, "ingest");
      expect((await fetch(decisionUrl, { method: "POST", headers, body: JSON.stringify(decision) })).status).toBe(202);
      expect(ingest).toHaveBeenLastCalledWith("unknown", expect.objectContaining({ hook_event_name: "HumanDecision" }), "operator");
      expect((await fetch(`http://${address.host}:${address.port}/hook`, {
        method: "POST", headers: { "x-super-brain-hook-token": "hook-token" },
        body: JSON.stringify({ ...decision, hook_event_name: "HumanDecision", authority: "operator" }),
      })).status).toBe(202);
      expect(ingest).toHaveBeenLastCalledWith("unknown", expect.objectContaining({ authority: "operator" }), "agent");

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

  it("acknowledges lifecycle hooks from the durable inbox before normalization", async () => {
    const root = await mkdtemp(join(tmpdir(), "super-brain-capture-server-inbox-"));
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
    const inbox = new HookInbox(config.stateRoot);
    await engine.initialize();
    await inbox.initialize();
    const ingest = vi.spyOn(engine, "ingest");
    const server = new CaptureHttpServer(config, engine, spool, undefined, undefined, inbox);
    const address = await server.start();
    try {
      const response = await fetch(`http://${address.host}:${address.port}/hook`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-agent-source": "codex",
          "x-super-brain-hook-token": "hook-token",
        },
        body: JSON.stringify({ session_id: "session-a", hook_event_name: "SessionStart" }),
      });

      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toMatchObject({ accepted: true, inboxId: expect.any(String) });
      expect(ingest).not.toHaveBeenCalled();
      await expect(inbox.snapshot()).resolves.toMatchObject({ pendingHooks: 1, failedHooks: 0 });
    } finally {
      await server.close();
    }
  });
});
