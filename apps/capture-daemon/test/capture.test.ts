import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CaptureEngine,
  DurableSpool,
  HookVault,
  StateStore,
  mergedHookSettings,
  parseCaptureConfig,
  type CaptureConfig,
} from "../src/index.js";

function config(root: string): CaptureConfig {
  return parseCaptureConfig({
    apiUrl: "http://127.0.0.1:3003",
    workspaceId: "workspace-a",
    apiToken: "api-token",
    sensorId: "urn:sensor:super-brain-capture:test",
    hookToken: "hook-token",
    bindHost: "127.0.0.1",
    port: 8377,
    heartbeatWindowMs: 90_000,
    heartbeatIntervalMs: 30_000,
    stateRoot: join(root, "state"),
    vaultRoot: join(root, "vault"),
    reasoningPolicy: "exclude",
  });
}

describe("capture daemon", () => {
  it("rejects non-loopback listeners", () => {
    const root = "/tmp/capture";
    expect(() => parseCaptureConfig({ ...config(root), bindHost: "0.0.0.0" }))
      .toThrow("only bind to a loopback address");
  });

  it("durably captures a real hook trajectory without canonical prompt content", async () => {
    const root = await mkdtemp(join(tmpdir(), "super-brain-capture-"));
    const current = config(root);
    const spool = new DurableSpool(current.stateRoot);
    const vault = new HookVault(current.vaultRoot);
    const state = new StateStore(current.stateRoot);
    const engine = new CaptureEngine(current, state, vault, spool);
    await engine.initialize();
    const session = "session-a";
    const common = { session_id: session, cwd: process.cwd() };

    await engine.ingest("codex", { ...common, hook_event_name: "SessionStart" });
    const prompt = await engine.ingest("codex", {
      ...common,
      hook_event_name: "UserPromptSubmit",
      prompt: "Fix the refresh-token race token=abcdefghijklmnop",
    });
    await engine.ingest("codex", {
      ...common,
      hook_event_name: "PreToolUse",
      tool_name: "exec_command",
      tool_use_id: "tool-a",
      tool_input: { command: "pnpm test" },
    });
    await engine.ingest("codex", {
      ...common,
      hook_event_name: "PostToolUse",
      tool_name: "exec_command",
      tool_use_id: "tool-a",
      tool_input: { command: "pnpm test" },
      tool_response: { exit_code: 0, output: "private output" },
    });
    await engine.ingest("codex", {
      ...common,
      hook_event_name: "ReasoningCheckpoint",
      summary: "A stale cache entry is the leading hypothesis",
      evidence: "The focused test now passes after invalidation",
    });
    await engine.ingest("codex", { ...common, hook_event_name: "SessionEnd", reason: "complete" });

    const jobs = await spool.list();
    const canonical = JSON.stringify(jobs.map(({ job }) => job));
    expect(canonical).not.toContain("Fix the refresh-token race");
    expect(canonical).not.toContain("private output");
    expect(canonical).toContain("A stale cache entry is the leading hypothesis");
    const trajectory = jobs.find(({ job }) => job.kind === "trajectory")?.job;
    expect(trajectory).toMatchObject({
      kind: "trajectory",
      input: { outcome: "success", model: { id: "codex" } },
      captureIdentity: { agent: "codex", session, project: "super-brain" },
    });
    if (trajectory?.kind !== "trajectory") throw new Error("missing trajectory job");
    expect(trajectory.input.steps.map((step) => step.role)).toContain("model_thought");
    expect(trajectory.tree.nodes.at(-1)).toMatchObject({ kind: "outcome", label: "Outcome success" });

    const artifactPath = join(
      current.vaultRoot,
      "hooks",
      "codex",
      prompt.artifactId.slice(0, 2),
      `${prompt.artifactId}.json`,
    );
    const artifact = await readFile(artifactPath, "utf8");
    expect(artifact).toContain("[REDACTED]");
    expect(artifact).not.toContain("abcdefghijklmnop");
    expect((await stat(artifactPath)).mode & 0o777).toBe(0o600);

    const restored = await state.load();
    expect(Object.values(restored.sessions)[0]).toMatchObject({ active: false, finalized: true });
  });

  it("merges hooks while removing only legacy listeners on the capture port", () => {
    const settings = {
      model: "claude-sonnet",
      hooks: {
        Stop: [
          { hooks: [{ type: "command", command: "notify-send done" }] },
          { hooks: [{ type: "command", command: "curl http://127.0.0.1:8377/hook" }] },
        ],
      },
    };
    const merged = mergedHookSettings(settings, "/repo/dist/main.js", "/config.json", "claude-code");
    expect(merged.model).toBe("claude-sonnet");
    const stop = (merged.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>).Stop;
    expect(stop).toBeDefined();
    expect(stop!.map((group) => group.hooks[0]?.command)).toEqual([
      "notify-send done",
      expect.stringContaining("super-brain-capture"),
    ]);
    expect(Object.keys(merged.hooks as object)).toContain("PostToolUseFailure");
  });
});
