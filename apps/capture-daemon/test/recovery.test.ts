import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CaptureEngine,
  DurableSpool,
  HookVault,
  SessionStepStore,
  StateStore,
  parseCaptureConfig,
  recoverCapturedSteps,
  type CaptureConfig,
  type CaptureSession,
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
    orphanAfterMs: 24 * 60 * 60_000,
    stateRoot: join(root, "state"),
    vaultRoot: join(root, "vault"),
    reasoningPolicy: "exclude",
  });
}

describe("capture recovery", () => {
  it("reconstructs a capped journal from encrypted hook artifacts during initialization", async () => {
    const root = await mkdtemp(join(tmpdir(), "super-brain-capture-recovery-"));
    const current = config(root);
    const key = new Uint8Array(32).fill(7);
    const vault = new HookVault(current.vaultRoot, key);
    const common = { session_id: "capped-session", cwd: root };
    const started = await vault.store("codex", { ...common, hook_event_name: "SessionStart" }, 1_000);
    const prompted = await vault.store("codex", {
      ...common,
      hook_event_name: "UserPromptSubmit",
      prompt: "Recover this trajectory",
    }, 2_000);
    await vault.store("codex", {
      ...common,
      hook_event_name: "PreToolUse",
      tool_name: "exec_command",
      tool_use_id: "verify-a",
      tool_input: { command: "pnpm test" },
    }, 3_000);
    await vault.store("codex", {
      ...common,
      hook_event_name: "PostToolUse",
      tool_name: "exec_command",
      tool_use_id: "verify-a",
      tool_input: { command: "pnpm test" },
      tool_response: { exit_code: 0 },
    }, 3_250);

    const partial: CaptureSession = {
      sessionId: "capped-session",
      source: "codex",
      agent: "codex",
      startedAt: started.receivedAt,
      project: { id: root, name: "project", root, branch: "main" },
      steps: [
        {
          id: "step-1",
          stepNumber: 1,
          nodeKind: "observation",
          role: "decision",
          content: "Coding-agent session started",
          artifactId: started.id,
          eventId: "existing-lifecycle-link",
        },
        {
          id: "step-2",
          stepNumber: 2,
          nodeKind: "observation",
          role: "decision",
          content: "User submitted a task prompt",
          artifactId: prompted.id,
          eventId: "existing-prompt-link",
        },
      ],
      truncatedStepCount: 3,
      finalized: false,
      active: true,
      lastSeenAt: prompted.receivedAt,
    };
    const stepStore = new SessionStepStore(current.stateRoot);
    const persisted = await stepStore.synchronize(partial);
    const stateStore = new StateStore(current.stateRoot);
    await stateStore.save({
      version: 1,
      lastEventTime: 3_250,
      seenArtifacts: [],
      sessions: { "codex:capped-session": persisted },
    });

    const storedArtifacts = await vault.sessionArtifacts("codex", "capped-session");
    expect(storedArtifacts).toHaveLength(4);
    expect(recoverCapturedSteps(storedArtifacts).map(({ content }) => content)).toEqual([
      "Coding-agent session started",
      "User submitted a task prompt",
      "Invoke exec_command",
      "exec_command completed",
      "test verification passed",
    ]);

    const engine = new CaptureEngine(
      current,
      stateStore,
      vault,
      new DurableSpool(current.stateRoot),
      undefined,
      new SessionStepStore(current.stateRoot),
    );
    await engine.initialize();

    expect(engine.snapshot()).toMatchObject({ truncatedSteps: 0 });
    const recovered = (await stateStore.load()).sessions["codex:capped-session"]!;
    expect(recovered).toMatchObject({ stepCount: 5, recoveredStepCount: 3 });
    expect(recovered.truncatedStepCount).toBeUndefined();
    const hydrated = await new SessionStepStore(current.stateRoot).synchronize(recovered);
    expect(hydrated.steps).toHaveLength(5);
    expect(hydrated.steps[0]).toMatchObject({ eventId: "existing-lifecycle-link" });
    expect(hydrated.steps[1]).toMatchObject({ eventId: "existing-prompt-link" });
  });

  it("backfills retained response boundaries once as real evaluation units", async () => {
    const root = await mkdtemp(join(tmpdir(), "super-brain-capture-unit-backfill-"));
    const current = config(root);
    const vault = new HookVault(current.vaultRoot);
    const common = { session_id: "historical-session", cwd: root };
    const firstPrompt = await vault.store("codex", {
      ...common,
      hook_event_name: "UserPromptSubmit",
      prompt: "Compare alpha",
    }, 1_000);
    const firstStop = await vault.store("codex", { ...common, hook_event_name: "Stop" }, 2_000);
    const secondPrompt = await vault.store("codex", {
      ...common,
      hook_event_name: "UserPromptSubmit",
      prompt: "Compare beta",
    }, 3_000);
    const secondStop = await vault.store("codex", {
      ...common,
      hook_event_name: "Stop",
      turn_id: "second",
    }, 4_000);
    const historical: CaptureSession = {
      sessionId: "historical-session",
      source: "codex",
      agent: "codex",
      startedAt: firstPrompt.receivedAt,
      project: { id: root, name: "project", root, branch: "main" },
      steps: [
        { id: "step-1", stepNumber: 1, nodeKind: "observation", role: "decision", content: "User submitted a task prompt", artifactId: firstPrompt.id, eventId: "capture-0000000001000-001-observation" },
        { id: "step-2", stepNumber: 2, nodeKind: "observation", role: "model_output", content: "Agent completed a response", artifactId: firstStop.id, eventId: "capture-0000000002000-001-observation" },
        { id: "step-3", stepNumber: 3, nodeKind: "observation", role: "decision", content: "User submitted a task prompt", artifactId: secondPrompt.id, eventId: "capture-0000000003000-001-observation" },
        { id: "step-4", stepNumber: 4, nodeKind: "observation", role: "model_output", content: "Agent completed a response", artifactId: secondStop.id, eventId: "capture-0000000004000-001-observation" },
      ],
      finalized: false,
      active: false,
      lastSeenAt: secondStop.receivedAt,
    };
    const stepStore = new SessionStepStore(current.stateRoot);
    const stateStore = new StateStore(current.stateRoot);
    await stateStore.save({
      version: 1,
      lastEventTime: 4_000,
      seenArtifacts: [],
      sessions: { "codex:historical-session": await stepStore.synchronize(historical) },
    });
    const spool = new DurableSpool(current.stateRoot);
    const first = new CaptureEngine(
      current,
      stateStore,
      vault,
      spool,
      undefined,
      new SessionStepStore(current.stateRoot),
    );
    await first.initialize();
    const trajectories = (await spool.list()).map(({ job }) => job)
      .filter((job) => job.kind === "trajectory");
    expect(trajectories).toHaveLength(2);
    expect(trajectories.map(({ input }) => input.id)).toEqual([
      expect.stringMatching(/:unit-1$/),
      expect.stringMatching(/:unit-2$/),
    ]);
    expect(new Set(trajectories.map(({ input }) => input.taskId)).size).toBe(2);
    expect((await stateStore.load()).sessions["codex:historical-session"]).toMatchObject({
      evaluationUnitVersion: 2,
      completedUnitCount: 2,
      finalizedThroughStepNumber: 4,
    });

    const second = new CaptureEngine(
      current,
      stateStore,
      vault,
      spool,
      undefined,
      new SessionStepStore(current.stateRoot),
    );
    await second.initialize();
    expect((await spool.list()).filter(({ job }) => job.kind === "trajectory")).toHaveLength(2);
  });
});
