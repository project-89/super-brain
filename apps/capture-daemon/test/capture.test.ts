import { mkdir, mkdtemp, readFile, readdir, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CaptureEngine,
  DurableSpool,
  HookVault,
  StateStore,
  hookSource,
  mergedHookSettings,
  parseCaptureConfig,
  exportCaptureData,
  pruneHookArtifacts,
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
    const stop = (merged.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>).Stop;
    expect(stop).toBeDefined();
    expect(stop!.map((group) => group.hooks[0]?.command)).toEqual([
      "notify-send done",
      expect.stringContaining("super-brain-capture"),
    ]);
    expect(Object.keys(merged.hooks as object)).toContain("PostToolUseFailure");
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
