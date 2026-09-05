import { mkdir, mkdtemp, readFile, readdir, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CaptureEngine,
  DurableSpool,
  HookVault,
  SessionStepStore,
  StateStore,
  hookSource,
  mergedHookSettings,
  parseCaptureConfig,
  exportCaptureData,
  pruneHookArtifacts,
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

describe("capture daemon", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("prefers the authenticated relay source over a provider payload source", () => {
    expect(hookSource("codex", "startup")).toBe("codex");
    expect(hookSource(undefined, "hermes")).toBe("hermes");
    expect(hookSource(undefined, "startup")).toBe("unknown");
  });

  it("migrates an active provisional session when its source becomes known", async () => {
    const root = await mkdtemp(join(tmpdir(), "super-brain-capture-source-refinement-"));
    const current = config(root);
    const spool = new DurableSpool(current.stateRoot);
    const state = new StateStore(current.stateRoot);
    const engine = new CaptureEngine(current, state, new HookVault(current.vaultRoot), spool);
    await engine.initialize();
    const payload = { session_id: "refined-session", cwd: process.cwd() };
    await engine.ingest("unknown", { ...payload, hook_event_name: "SessionStart" });
    await engine.ingest("codex", { ...payload, hook_event_name: "UserPromptSubmit", prompt: "Refine this session" });
    expect(engine.snapshot()).toMatchObject({ activeSessions: 1, knownSessions: 1 });
    expect(Object.values((await state.load()).sessions)[0]).toMatchObject({ source: "codex", agent: "codex" });
  });

  it("establishes lifecycle coverage when the first observed hook is mid-session", async () => {
    const root = await mkdtemp(join(tmpdir(), "super-brain-capture-mid-session-"));
    const current = config(root);
    const spool = new DurableSpool(current.stateRoot);
    const engine = new CaptureEngine(current, new StateStore(current.stateRoot), new HookVault(current.vaultRoot), spool);
    await engine.initialize();
    await engine.ingest("codex", {
      session_id: "mid-session",
      cwd: process.cwd(),
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_use_id: "read-a",
    });
    const events = (await spool.list()).flatMap(({ job }) => job.kind === "event" ? [job.event] : []);
    expect(events.map(({ kind }) => kind)).toEqual(["lifecycle", "terminal.observation"]);
    expect(events[0]?.lifecycle?.phase).toBe("online");
  });

  it("rejects non-loopback listeners", () => {
    const root = "/tmp/capture";
    expect(() => parseCaptureConfig({ ...config(root), bindHost: "0.0.0.0" }))
      .toThrow("only bind to a loopback address");
  });

  it("validates periodic tree and privacy policy combinations", () => {
    const root = "/tmp/capture-policy";
    expect(config(root)).toMatchObject({
      reasoningTreePolicy: "exclude",
      treeSnapshotEveryEvents: 25,
      anonymizationPolicy: "none",
      retainEncryptedReasoning: false,
    });
    expect(() => parseCaptureConfig({
      ...config(root),
      reasoningPolicy: "exclude",
      reasoningTreePolicy: "summaries",
    })).toThrow("requires reasoningPolicy include");
    expect(() => parseCaptureConfig({
      ...config(root),
      reasoningPolicy: "exclude",
      retainEncryptedReasoning: true,
    })).toThrow("requires reasoningPolicy include");
    expect(() => parseCaptureConfig({
      ...config(root),
      anonymizationPolicy: "pseudonymous",
    })).toThrow("require anonymizationKeyPath");
    expect(() => parseCaptureConfig({
      ...config(root),
      treeSnapshotEveryEvents: -1,
    })).toThrow("must be a non-negative integer");
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

  it("invalidates stale verification after a later mutation and links tool evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "super-brain-capture-outcome-"));
    const current = config(root);
    const spool = new DurableSpool(current.stateRoot);
    const engine = new CaptureEngine(
      current,
      new StateStore(current.stateRoot),
      new HookVault(current.vaultRoot),
      spool,
    );
    await engine.initialize();
    const common = { session_id: "session-outcome", cwd: process.cwd(), turn_id: "turn-a" };
    await engine.ingest("codex", { ...common, hook_event_name: "SessionStart" });
    await engine.ingest("codex", {
      ...common,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_use_id: "verify-a",
      tool_input: { command: "pnpm test" },
    });
    await engine.ingest("codex", {
      ...common,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_use_id: "verify-a",
      tool_input: { command: "pnpm test" },
      tool_response: { exit_code: 0 },
    });
    const edit = await engine.ingest("codex", {
      ...common,
      hook_event_name: "PostToolUse",
      tool_name: "Edit",
      tool_use_id: "edit-a",
      tool_input: { file_path: join(process.cwd(), "README.md") },
      tool_response: { exit_code: 0 },
    });
    await engine.ingest("codex", { ...common, hook_event_name: "SessionEnd" });

    const jobs = (await spool.list()).map(({ job }) => job);
    const trajectory = jobs.find((job) => job.kind === "trajectory");
    expect(trajectory).toMatchObject({ kind: "trajectory", input: { outcome: "unknown" } });
    if (trajectory?.kind !== "trajectory") throw new Error("missing trajectory job");
    expect(trajectory.input.steps.some((step) => step.artifactId === edit.artifactId)).toBe(true);
    const observations = jobs.filter((job) => job.kind === "event" && job.event.kind === "terminal.observation");
    const toolResult = observations.find((job) => {
      if (job.kind !== "event") return false;
      const after = job.event.changes[0]?.verb === "create" ? job.event.changes[0].after : undefined;
      return after?.observation === "tool_result" && (after.data as Record<string, unknown>)?.toolUseId === "verify-a";
    });
    expect(toolResult?.kind === "event" ? toolResult.event.causedBy : undefined).toHaveLength(1);
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
    const hooks = merged.hooks as Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
    const stop = hooks.Stop;
    expect(stop).toBeDefined();
    expect(stop!.map((group) => group.hooks[0]?.command)).toEqual([
      "notify-send done",
      expect.stringContaining("super-brain-capture"),
    ]);
    expect(Object.keys(merged.hooks as object)).toContain("PostToolUseFailure");
    expect(hooks.FileChanged?.[0]?.matcher).toContain("package.json");
  });

  it("pages every changed path into canonical observations and maps watched file changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "super-brain-capture-path-pages-"));
    const current = config(root);
    const spool = new DurableSpool(current.stateRoot);
    const engine = new CaptureEngine(current, new StateStore(current.stateRoot), new HookVault(current.vaultRoot), spool);
    await engine.initialize();
    const common = { session_id: "path-pages", cwd: process.cwd() };
    await engine.ingest("claude-code", { ...common, hook_event_name: "SessionStart" });
    await engine.ingest("claude-code", {
      ...common,
      hook_event_name: "PostToolUse",
      tool_name: "Edit",
      tool_input: { file_path: Array.from({ length: 205 }, (_, index) => join(process.cwd(), `file-${index}.ts`)) },
    });
    await engine.ingest("claude-code", {
      ...common,
      hook_event_name: "FileChanged",
      file_path: join(process.cwd(), "package.json"),
      event: "change",
    });

    const changes = (await spool.list()).flatMap(({ job }) => {
      if (job.kind !== "event" || job.event.kind !== "terminal.observation") return [];
      const change = job.event.changes[0];
      if (change?.verb !== "create" || change.after.observation !== "file_changed") return [];
      return [change.after.data as Record<string, unknown>];
    });
    const paged = changes.filter((data) => data.pathPageCount === 2);
    expect(paged).toHaveLength(2);
    expect(paged.flatMap((data) => data.paths as string[])).toHaveLength(205);
    expect(changes.some((data) => (data.paths as string[]).some((path) => path.endsWith("package.json")) && data.event === "change")).toBe(true);
  });

  it("groups repeated prompts into one shared task with stable stage nodes", async () => {
    const root = await mkdtemp(join(tmpdir(), "super-brain-capture-comparison-"));
    const current = config(root);
    const spool = new DurableSpool(current.stateRoot);
    const engine = new CaptureEngine(current, new StateStore(current.stateRoot), new HookVault(current.vaultRoot), spool);
    await engine.initialize();
    for (const [sessionId, tool] of [["comparison-a", "Read"], ["comparison-b", "Search"]] as const) {
      const common = { session_id: sessionId, cwd: process.cwd() };
      await engine.ingest("codex", { ...common, hook_event_name: "SessionStart" });
      await engine.ingest("codex", { ...common, hook_event_name: "UserPromptSubmit", prompt: "Fix the same issue" });
      await engine.ingest("codex", { ...common, hook_event_name: "PreToolUse", tool_name: tool, tool_use_id: `${sessionId}-tool` });
      await engine.ingest("codex", { ...common, hook_event_name: "PostToolUse", tool_name: tool, tool_use_id: `${sessionId}-tool` });
      await engine.ingest("codex", { ...common, hook_event_name: "SessionEnd" });
    }
    const trajectories = (await spool.list()).flatMap(({ job }) => job.kind === "trajectory" ? [job] : []);
    expect(trajectories).toHaveLength(2);
    expect(trajectories[0]?.tree.taskId).toBe(trajectories[1]?.tree.taskId);
    expect(trajectories[0]?.tree.rootNodeId).toBe(trajectories[1]?.tree.rootNodeId);
    expect(trajectories[0]?.tree.nodes[2]?.id).not.toBe(trajectories[1]?.tree.nodes[2]?.id);
  });

  it("records periodic reasoning-tree snapshots without creating duplicate runs", async () => {
    const root = await mkdtemp(join(tmpdir(), "super-brain-capture-snapshots-"));
    const transcript = join(root, "session.jsonl");
    await writeFile(transcript, `${JSON.stringify({
      type: "response_item",
      payload: {
        type: "reasoning",
        id: "reason-a",
        summary: [{ type: "summary_text", text: "Inspect cache invalidation" }],
        encrypted_content: "opaque-provider-state",
      },
    })}\n`, "utf8");
    const current = parseCaptureConfig({
      ...config(root),
      reasoningPolicy: "include",
      retainEncryptedReasoning: true,
      reasoningTreePolicy: "summaries",
      treeSnapshotEveryEvents: 2,
    });
    const spool = new DurableSpool(current.stateRoot);
    const vault = new HookVault(current.vaultRoot, undefined, { retainEncryptedReasoning: true });
    const engine = new CaptureEngine(current, new StateStore(current.stateRoot), vault, spool);
    await engine.initialize();
    const common = { session_id: "snapshot-a", transcript_path: transcript, cwd: process.cwd() };
    await engine.ingest("codex", { ...common, hook_event_name: "SessionStart" });
    await engine.ingest("codex", { ...common, hook_event_name: "UserPromptSubmit", prompt: "Fix cache invalidation" });

    let jobs = (await spool.list()).map(({ job }) => job);
    const snapshot = jobs.find((job) => job.kind === "trajectory-tree");
    expect(snapshot).toMatchObject({ kind: "trajectory-tree", captureIdentity: { snapshot: "true", observedEvents: "2" } });
    if (snapshot?.kind !== "trajectory-tree") throw new Error("missing periodic tree snapshot");
    expect(snapshot.tree.nodes.some(({ label }) => label === "Inspect cache invalidation")).toBe(true);
    expect(jobs.filter((job) => job.kind === "trajectory")).toHaveLength(0);
    expect(jobs.filter((job) => job.kind === "event").some((job) =>
      job.kind === "event" && job.event.changes.some((change) =>
        change.verb === "create" && change.after.observation === "reasoning_observed"
      )
    )).toBe(true);
    const state = await new StateStore(current.stateRoot).load();
    const captured = state.sessions["codex:snapshot-a"];
    expect(captured?.reasoningCursor).toBeGreaterThan(0);
    const vaultFiles: string[] = [];
    const sourceRoot = join(current.vaultRoot, "hooks", "codex");
    for (const prefix of await readdir(sourceRoot)) {
      for (const name of await readdir(join(sourceRoot, prefix))) {
        vaultFiles.push(join(sourceRoot, prefix, name));
      }
    }
    const delta = (await Promise.all(vaultFiles.map((path) => readFile(path, "utf8"))))
      .map((value) => JSON.parse(value) as { payload?: Record<string, unknown> })
      .find(({ payload }) => payload?.hook_event_name === "TranscriptDelta");
    expect(delta?.payload).toMatchObject({ record_count: 1 });
    expect(JSON.stringify(delta)).toContain("opaque-provider-state");

    await engine.ingest("codex", { ...common, hook_event_name: "SessionEnd" });
    jobs = (await spool.list()).map(({ job }) => job);
    expect(jobs.filter((job) => job.kind === "trajectory")).toHaveLength(1);
  });

  it("captures the observable Hermes gateway step vocabulary", async () => {
    const root = await mkdtemp(join(tmpdir(), "super-brain-capture-hermes-"));
    const current = config(root);
    const spool = new DurableSpool(current.stateRoot);
    const engine = new CaptureEngine(current, new StateStore(current.stateRoot), new HookVault(current.vaultRoot), spool);
    await engine.initialize();
    const common = { session_id: "hermes-session", cwd: process.cwd() };
    await engine.ingest("hermes", { ...common, hook_event_name: "SessionStart" });
    await engine.ingest("hermes", { ...common, hook_event_name: "HermesStep", iteration: 2, tool_names: ["terminal", "web_search"] });
    await engine.ingest("hermes", { ...common, hook_event_name: "SessionEnd" });
    const jobs = (await spool.list()).map(({ job }) => job);
    const trajectory = jobs.find((job) => job.kind === "trajectory");
    expect(trajectory).toMatchObject({
      kind: "trajectory",
      input: { outcome: "unknown", model: { id: "hermes" } },
      captureIdentity: { runtime: "hermes" },
    });
    if (trajectory?.kind !== "trajectory") throw new Error("missing Hermes trajectory");
    expect(trajectory.input.steps.filter(({ role }) => role === "tool_call").map(({ toolName }) => toolName))
      .toEqual(["terminal", "web_search"]);
  });

  it("finalizes abandoned sessions as unknown after the configured timeout", async () => {
    const root = await mkdtemp(join(tmpdir(), "super-brain-capture-orphan-"));
    const current = { ...config(root), orphanAfterMs: 1 };
    const spool = new DurableSpool(current.stateRoot);
    const engine = new CaptureEngine(current, new StateStore(current.stateRoot), new HookVault(current.vaultRoot), spool);
    await engine.initialize();
    await engine.ingest("codex", { session_id: "orphan-a", cwd: process.cwd(), hook_event_name: "SessionStart" });
    await engine.heartbeat(Date.now() + 10);
    const jobs = (await spool.list()).map(({ job }) => job);
    expect(jobs.find((job) => job.kind === "trajectory")).toMatchObject({
      kind: "trajectory",
      input: { outcome: "unknown" },
      captureIdentity: { finalizationReason: "orphan-timeout" },
    });
    expect(engine.snapshot()).toMatchObject({ activeSessions: 0, unfinishedSessions: 0 });
  });

  it("hydrates durable steps before finalizing a session after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "super-brain-capture-step-restart-"));
    const current = config(root);
    const spool = new DurableSpool(current.stateRoot);
    const state = new StateStore(current.stateRoot);
    const first = new CaptureEngine(current, state, new HookVault(current.vaultRoot), spool);
    await first.initialize();
    const common = { session_id: "restart-steps", cwd: process.cwd() };
    await first.ingest("codex", { ...common, hook_event_name: "SessionStart" });
    await first.ingest("codex", { ...common, hook_event_name: "UserPromptSubmit", prompt: "Persist every step" });
    await first.ingest("codex", { ...common, hook_event_name: "Stop", last_assistant_message: "Done" });

    const second = new CaptureEngine(current, state, new HookVault(current.vaultRoot), spool);
    await second.initialize();
    await second.ingest("codex", { ...common, hook_event_name: "SessionEnd" });
    const trajectory = (await spool.list()).map(({ job }) => job)
      .find((job) => job.kind === "trajectory");
    expect(trajectory).toMatchObject({ kind: "trajectory" });
    if (trajectory?.kind !== "trajectory") throw new Error("missing trajectory job");
    expect(trajectory.input.steps.map(({ content }) => content)).toEqual([
      "User submitted a task prompt",
      "Agent completed a response",
      "Turn ended without a verified outcome",
    ]);
  });

  it("finalizes prompt-response turns without waiting for the parent CLI session to end", async () => {
    const root = await mkdtemp(join(tmpdir(), "super-brain-capture-turns-"));
    const current = config(root);
    const spool = new DurableSpool(current.stateRoot);
    const state = new StateStore(current.stateRoot);
    const engine = new CaptureEngine(current, state, new HookVault(current.vaultRoot), spool);
    await engine.initialize();
    const common = { session_id: "multi-turn", cwd: process.cwd() };
    await engine.ingest("codex", { ...common, hook_event_name: "SessionStart" });
    await engine.ingest("codex", { ...common, hook_event_name: "UserPromptSubmit", prompt: "Run the alpha check" });
    await engine.ingest("codex", {
      ...common,
      hook_event_name: "PreToolUse",
      tool_name: "exec_command",
      tool_use_id: "alpha",
      tool_input: { command: "pnpm test" },
    });
    await engine.ingest("codex", {
      ...common,
      hook_event_name: "PostToolUse",
      tool_name: "exec_command",
      tool_use_id: "alpha",
      tool_input: { command: "pnpm test" },
      tool_response: { exit_code: 0 },
    });
    const stop = { ...common, hook_event_name: "Stop", last_assistant_message: "Alpha complete" };
    await engine.ingest("codex", stop);
    await engine.ingest("codex", stop);
    await engine.ingest("codex", { ...common, hook_event_name: "UserPromptSubmit", prompt: "Inspect the beta path" });
    await engine.ingest("codex", {
      ...common,
      hook_event_name: "SteeringApplied",
      intention_ids: ["intention-beta"],
    });
    await engine.ingest("codex", { ...common, hook_event_name: "Stop", last_assistant_message: "Beta inspected" });
    const end = { ...common, hook_event_name: "SessionEnd", reason: "complete" };
    await engine.ingest("codex", end);
    const jobsBeforeRetry = await spool.list();
    await engine.ingest("codex", end);

    const jobs = (await spool.list()).map(({ job }) => job);
    expect(jobs).toHaveLength(jobsBeforeRetry.length);
    const trajectories = jobs.filter((job) => job.kind === "trajectory");
    expect(trajectories).toHaveLength(2);
    expect(trajectories.map(({ input }) => input.outcome)).toEqual(["success", "unknown"]);
    expect(trajectories.map(({ input }) => input.id)).toEqual([
      expect.stringMatching(/:unit-1$/),
      expect.stringMatching(/:unit-2$/),
    ]);
    expect(new Set(trajectories.map(({ input }) => input.taskId)).size).toBe(2);
    expect(trajectories[0]?.captureIdentity).toMatchObject({ finalizationReason: "stop", unit: "1" });
    expect(trajectories[1]?.captureIdentity).toMatchObject({
      finalizationReason: "stop",
      unit: "2",
      steeringIntentions: "intention-beta",
    });
    expect(engine.snapshot()).toMatchObject({ finalizedSessions: 1, finalizedUnits: 2, duplicateHooks: 2 });
    expect((await state.load()).sessions["codex:multi-turn"]).toMatchObject({
      finalized: true,
      completedUnitCount: 2,
    });
  });

  it("finalizes a lossless evaluation unit beyond the former 2,000-step boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "super-brain-capture-long-finalize-"));
    const current = config(root);
    const state = new StateStore(current.stateRoot);
    const stepStore = new SessionStepStore(current.stateRoot);
    const steps = Array.from({ length: 2_105 }, (_, index) => ({
      id: `step-${index + 1}`,
      stepNumber: index + 1,
      nodeKind: "action" as const,
      role: "tool_call" as const,
      content: `Invoke tool-${index + 1}`,
      toolName: `tool-${index + 1}`,
      artifactId: `artifact-${index + 1}`,
      eventId: `event-${index + 1}`,
    }));
    const session: CaptureSession = {
      sessionId: "long-finalize",
      source: "codex",
      agent: "codex",
      startedAt: "2026-09-04T00:00:00.000Z",
      project: { id: root, name: "project", root, branch: "main" },
      steps,
      currentUnitStartStepNumber: 1,
      completedUnitCount: 0,
      finalized: false,
      active: true,
      lastSeenAt: "2026-09-04T00:00:00.000Z",
    };
    const persisted = await stepStore.synchronize(session);
    await state.save({
      version: 1,
      lastEventTime: 1,
      seenArtifacts: [],
      sessions: { "codex:long-finalize": persisted },
    });
    const spool = new DurableSpool(current.stateRoot);
    const engine = new CaptureEngine(
      current,
      state,
      new HookVault(current.vaultRoot),
      spool,
      undefined,
      new SessionStepStore(current.stateRoot),
    );
    await engine.initialize();
    await engine.ingest("codex", {
      session_id: "long-finalize",
      cwd: root,
      hook_event_name: "Stop",
      last_assistant_message: "Complete",
    });
    const trajectory = (await spool.list()).map(({ job }) => job)
      .find((job) => job.kind === "trajectory");
    expect(trajectory).toMatchObject({ kind: "trajectory", captureIdentity: { unit: "1" } });
    if (trajectory?.kind !== "trajectory") throw new Error("missing long trajectory job");
    expect(trajectory.input.steps).toHaveLength(2_107);
    expect(trajectory.input.steps.at(-1)).toMatchObject({
      id: "step-2107",
      content: "Turn ended without a verified outcome",
    });
    expect(engine.snapshot()).toMatchObject({ truncatedSteps: 0, finalizedUnits: 1 });
  });

  it("queues an owned transcript snapshot before the harness source can disappear", async () => {
    const root = await mkdtemp(join(tmpdir(), "super-brain-capture-transcript-race-"));
    const current = config(root);
    const transcript = join(root, "01a06910-6c0e-7e93-a94c-7dfc2c3830be.jsonl");
    await writeFile(transcript, `${JSON.stringify({
      type: "session_meta",
      timestamp: "2026-09-04T00:00:00.000Z",
      payload: { id: "session-a", cwd: root },
    })}\n`, "utf8");
    const spool = new DurableSpool(current.stateRoot);
    const engine = new CaptureEngine(current, new StateStore(current.stateRoot), new HookVault(current.vaultRoot), spool);
    await engine.initialize();
    const common = { session_id: "snapshot-race", transcript_path: transcript, cwd: root };
    await engine.ingest("codex", { ...common, hook_event_name: "SessionStart" });
    await engine.ingest("codex", { ...common, hook_event_name: "SessionEnd" });
    await unlink(transcript);

    const transcriptJob = (await spool.list()).map(({ job }) => job)
      .find((job) => job.kind === "transcript");
    expect(transcriptJob).toMatchObject({ kind: "transcript", ownedSnapshot: true });
    if (transcriptJob?.kind !== "transcript") throw new Error("missing transcript job");
    expect(transcriptJob.path).not.toBe(transcript);
    await expect(stat(transcriptJob.path)).resolves.toMatchObject({ mode: expect.any(Number) });
  });

  it("previews retention before deleting only expired raw hook artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "super-brain-capture-retention-"));
    const current = config(root);
    const hooks = join(current.vaultRoot, "hooks", "codex", "aa");
    await mkdir(hooks, { recursive: true });
    const old = join(hooks, "old.json");
    const recent = join(hooks, "recent.json");
    await Promise.all([writeFile(old, "old"), writeFile(recent, "recent")]);
    await utimes(old, new Date(1_000), new Date(1_000));
    await utimes(recent, new Date(10_000), new Date(10_000));
    await expect(pruneHookArtifacts(current, 5_000)).resolves.toEqual({ matched: 1, deleted: 0, bytes: 3 });
    await expect(readFile(old, "utf8")).resolves.toBe("old");
    await expect(pruneHookArtifacts(current, 5_000, true)).resolves.toEqual({ matched: 1, deleted: 1, bytes: 3 });
    await expect(readFile(old, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(recent, "utf8")).resolves.toBe("recent");
  });

  it("previews and explicitly retries quarantined spool jobs", async () => {
    const root = await mkdtemp(join(tmpdir(), "super-brain-capture-retry-"));
    const spool = new DurableSpool(join(root, "state"));
    const current = config(root);
    const engine = new CaptureEngine(current, new StateStore(current.stateRoot), new HookVault(current.vaultRoot), spool);
    await engine.initialize();
    await engine.ingest("codex", { session_id: "retry-session", cwd: process.cwd(), hook_event_name: "SessionStart" });
    const pending = await spool.list();
    expect(pending).toHaveLength(1);
    await spool.reject(pending[0]!.path, "temporary schema mismatch");
    await expect(spool.retryFailed()).resolves.toEqual({ matched: 1, retried: 0, rebased: 0 });
    await expect(spool.list()).resolves.toHaveLength(0);
    await expect(spool.retryFailed(true)).resolves.toEqual({ matched: 1, retried: 1, rebased: 0 });
    await expect(spool.list()).resolves.toHaveLength(1);
  });

  it("archives an explicitly resolved failed job with its audit evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "super-brain-capture-resolve-"));
    const stateRoot = join(root, "state");
    const spool = new DurableSpool(stateRoot);
    const current = config(root);
    const engine = new CaptureEngine(current, new StateStore(current.stateRoot), new HookVault(current.vaultRoot), spool);
    await engine.initialize();
    await engine.ingest("codex", { session_id: "resolve-session", cwd: process.cwd(), hook_event_name: "SessionStart" });
    const [pending] = await spool.list();
    await spool.reject(pending!.path, "source artifact is permanently unavailable");

    await expect(spool.resolveFailed("confirmed unavailable")).resolves.toEqual({ matched: 1, resolved: 0 });
    await expect(spool.snapshot()).resolves.toMatchObject({ failedJobs: 1 });
    await expect(spool.resolveFailed("confirmed unavailable", true)).resolves.toEqual({ matched: 1, resolved: 1 });
    await expect(spool.snapshot()).resolves.toMatchObject({ failedJobs: 0 });

    const resolvedRoot = join(stateRoot, "spool", "resolved");
    const files = await readdir(resolvedRoot);
    expect(files).toEqual(expect.arrayContaining([
      expect.stringMatching(/\.json$/),
      expect.stringMatching(/\.error\.json$/),
      expect.stringMatching(/\.resolution\.json$/),
    ]));
    const resolution = files.find((name) => name.endsWith(".resolution.json"));
    expect(JSON.parse(await readFile(join(resolvedRoot, resolution!), "utf8"))).toMatchObject({
      reason: "confirmed unavailable",
      job: { kind: "event" },
      failure: { reason: "source artifact is permanently unavailable" },
    });
  });

  it("explicitly rebases an ordered quarantined event while retaining its source ID", async () => {
    const root = await mkdtemp(join(tmpdir(), "super-brain-capture-rebase-"));
    const spool = new DurableSpool(join(root, "state"));
    const current = config(root);
    const engine = new CaptureEngine(current, new StateStore(current.stateRoot), new HookVault(current.vaultRoot), spool);
    await engine.initialize();
    await engine.ingest("codex", { session_id: "rebase-session", cwd: process.cwd(), hook_event_name: "SessionStart" });
    const [pending] = await spool.list();
    const originalId = pending!.job.id;
    await spool.reject(pending!.path, "ordering conflict");
    await expect(spool.retryFailed(true, { rebaseEvents: true }))
      .resolves.toEqual({ matched: 1, retried: 1, rebased: 1 });
    const [retried] = await spool.list();
    expect(retried!.job.id).not.toBe(originalId);
    if (retried!.job.kind !== "event") throw new Error("expected an event job");
    expect(retried!.job.event.capture.identity?.reissuedFrom).toBe(originalId);
    expect(retried!.job.event.changes[0]?.subject.endsWith(`:${retried!.job.id}`)).toBe(true);
  });

  it("explicitly rebases quarantined trajectory stamps without changing the run identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "super-brain-capture-trajectory-rebase-"));
    const spool = new DurableSpool(join(root, "state"));
    const current = config(root);
    const engine = new CaptureEngine(current, new StateStore(current.stateRoot), new HookVault(current.vaultRoot), spool);
    await engine.initialize();
    const common = { session_id: "trajectory-rebase", cwd: process.cwd() };
    await engine.ingest("codex", { ...common, hook_event_name: "SessionStart" });
    await engine.ingest("codex", { ...common, hook_event_name: "UserPromptSubmit", prompt: "Rebase the run" });
    await engine.ingest("codex", { ...common, hook_event_name: "Stop" });
    const pending = (await spool.list()).find(({ job }) => job.kind === "trajectory");
    if (pending?.job.kind !== "trajectory") throw new Error("missing trajectory job");
    const originalJobId = pending.job.id;
    const originalRunId = pending.job.input.id;
    const originalTime = pending.job.runStamp.t;
    await spool.reject(pending.path, "equal-time order conflict");
    await expect(spool.retryFailed(true, { rebaseTrajectories: true }))
      .resolves.toMatchObject({ matched: 1, retried: 1, rebased: 1 });
    const retried = (await spool.list()).find(({ job }) => job.kind === "trajectory");
    if (retried?.job.kind !== "trajectory") throw new Error("missing retried trajectory job");
    expect(retried.job.id).not.toBe(originalJobId);
    expect(retried.job.input.id).toBe(originalRunId);
    expect(retried.job.runStamp.t).toBeGreaterThan(originalTime);
    expect(retried.job.captureIdentity.reissuedFrom).toBe(originalJobId);
    expect(retried.job.treeStamp.id < retried.job.runStamp.id).toBe(true);
  });

  it("delivers a prompt-boundary trajectory before later equal-time observations", async () => {
    const root = await mkdtemp(join(tmpdir(), "super-brain-capture-prompt-order-"));
    const spool = new DurableSpool(join(root, "state"));
    const current = config(root);
    const engine = new CaptureEngine(current, new StateStore(current.stateRoot), new HookVault(current.vaultRoot), spool);
    await engine.initialize();
    const common = { session_id: "prompt-order", cwd: process.cwd() };
    await engine.ingest("codex", { ...common, hook_event_name: "SessionStart" });
    await engine.ingest("codex", { ...common, hook_event_name: "UserPromptSubmit", prompt: "First task" });
    for (const pending of await spool.list()) await spool.complete(pending.path);

    await engine.ingest("codex", { ...common, hook_event_name: "UserPromptSubmit", prompt: "Second task" });
    const equalTime = (await spool.list()).filter(({ job }) =>
      job.kind === "event" || job.kind === "trajectory"
    );
    expect(equalTime.map(({ job }) => job.kind)).toEqual(["trajectory", "event"]);
    const [trajectory, observation] = equalTime.map(({ job }) => job);
    if (trajectory?.kind !== "trajectory" || observation?.kind !== "event") throw new Error("unexpected spool jobs");
    expect(trajectory.treeStamp.t).toBe(observation.event.at.t);
    expect(trajectory.treeStamp.id < observation.event.id).toBe(true);
    expect(trajectory.runStamp.id < observation.event.id).toBe(true);
  });

  it("uses a dedicated read credential for canonical exports", async () => {
    const root = await mkdtemp(join(tmpdir(), "super-brain-capture-export-"));
    const current = config(root);
    await Promise.all([
      mkdir(current.stateRoot, { recursive: true }),
      mkdir(current.vaultRoot, { recursive: true }),
    ]);
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ entries: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", request);
    await exportCaptureData(current, join(root, "export"), { apiToken: "read-token" });
    const headers = new Headers(request.mock.calls[0]?.[1]?.headers);
    expect(headers.get("authorization")).toBe("Bearer read-token");
  });
});
