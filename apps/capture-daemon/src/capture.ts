import { createHash } from "node:crypto";
import { basename, relative, resolve } from "node:path";

import {
  makeSensorLifecycleEvent,
  makeTerminalObservationEvent,
  type TerminalObservation,
  type TerminalSensorContext,
} from "@_89/fold-activity";
import type { JsonValue } from "@_89/fold";
import type { TrajectoryInput, TrajectoryTreeRecord } from "@_89/fold-trajectory";
import { RecordAnonymizer } from "@_89/super-brain-importer";

import { refreshProject, resolveProject } from "./project.js";
import { readExposedReasoningDelta } from "./reasoning.js";
import { DurableSpool, HookVault, StateStore } from "./storage.js";
import type {
  CaptureConfig,
  CapturedStep,
  CaptureSession,
  CaptureState,
  HookSource,
  SpoolJob,
  VaultArtifact,
} from "./types.js";

const TRANSCRIPT_DELTA_MAX_BYTES = 8 * 1024 * 1024;

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function bounded(value: string, length = 500): string {
  return value.length <= length ? value : `${value.slice(0, length - 3)}...`;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function privateDigest(privacy: RecordAnonymizer, kind: string, value: string): string {
  return privacy.policy === "none" ? hash(value) : privacy.digest(kind, value);
}

function sessionKey(source: HookSource, sessionId: string): string {
  return `${source}:${sessionId}`;
}

function agentName(source: HookSource): string {
  if (source === "claude-code") return "claude-code";
  if (source === "codex") return "codex";
  return source;
}

function hookName(payload: Record<string, unknown>): string {
  return text(payload.hook_event_name) ?? text(payload.event_name) ?? text(payload.event) ?? "Unknown";
}

function nativeSessionId(payload: Record<string, unknown>): string | undefined {
  return text(payload.session_id) ?? text(payload.sessionId) ?? text(payload.conversation_id);
}

function transcriptPath(payload: Record<string, unknown>): string | undefined {
  return text(payload.transcript_path) ?? text(payload.transcriptPath) ?? text(payload.rollout_path);
}

function toolName(payload: Record<string, unknown>): string {
  return bounded(text(payload.tool_name) ?? text(payload.toolName) ?? "unknown-tool", 200);
}

function toolUseId(payload: Record<string, unknown>): string | undefined {
  return text(payload.tool_use_id) ?? text(payload.toolUseId) ?? text(payload.call_id);
}

function toolInput(payload: Record<string, unknown>): Record<string, unknown> {
  return object(payload.tool_input) ?? object(payload.toolInput) ?? object(payload.input) ?? {};
}

function canonicalPath(path: string, root: string): string {
  const absolute = resolve(root, path);
  const local = relative(root, absolute);
  return local.length > 0 && !local.startsWith("..") ? local : basename(absolute);
}

function changedPaths(payload: Record<string, unknown>, root: string): string[] {
  const input = toolInput(payload);
  const values = [input.file_path, input.path, input.notebook_path, input.target_file]
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => canonicalPath(value, root));
  return [...new Set(values)].slice(0, 50);
}

function commandText(payload: Record<string, unknown>): string {
  const input = toolInput(payload);
  return text(input.command) ?? text(input.cmd) ?? "";
}

function verificationKind(payload: Record<string, unknown>): "test" | "build" | "lint" | "typecheck" | undefined {
  const candidate = `${toolName(payload)} ${commandText(payload)}`.toLowerCase();
  if (/\b(typecheck|tsc\b)/.test(candidate)) return "typecheck";
  if (/\b(lint|eslint|ruff|clippy)\b/.test(candidate)) return "lint";
  if (/\b(build|compile|cargo check)\b/.test(candidate)) return "build";
  if (/\b(test|vitest|jest|pytest|go test|cargo test|rspec)\b/.test(candidate)) return "test";
  return undefined;
}

function toolSucceeded(name: string, payload: Record<string, unknown>): boolean {
  if (name === "PostToolUseFailure") return false;
  if (payload.is_error === true || payload.success === false) return false;
  const response = object(payload.tool_response) ?? object(payload.toolResponse) ?? object(payload.result);
  if (response?.is_error === true || response?.success === false) return false;
  const exitCode = response?.exit_code ?? response?.exitCode;
  return typeof exitCode === "number" ? exitCode === 0 : true;
}

function stamp(artifact: VaultArtifact, index: number, label: string) {
  const id = `capture-${artifact.eventTime.toString().padStart(13, "0")}-${index.toString().padStart(3, "0")}-${label}-${artifact.id.slice(0, 12)}`;
  return { id, t: artifact.eventTime, observedAt: artifact.receivedAt };
}

function eventStamp(artifact: VaultArtifact, index: number, label: string) {
  const value = stamp(artifact, index, label);
  return { id: value.id, t: value.t, worldDate: value.observedAt.slice(0, 10) };
}

function stepFor(session: CaptureSession, input: Omit<CapturedStep, "id" | "stepNumber">): CaptureSession {
  if (session.steps.length >= 2_000) {
    return { ...session, truncatedStepCount: (session.truncatedStepCount ?? 0) + 1 };
  }
  const stepNumber = session.steps.length + 1;
  return {
    ...session,
    steps: [...session.steps, { ...input, id: `step-${stepNumber}`, stepNumber }],
  };
}

function traceStep(step: CapturedStep, privacy: RecordAnonymizer): TrajectoryInput["steps"][number] {
  return {
    id: step.id,
    stepNumber: step.stepNumber,
    role: step.role,
    content: privacy.text(step.content),
    ...(step.toolName === undefined ? {} : { toolName: step.toolName }),
    ...(step.artifactId === undefined ? {} : { artifactId: step.artifactId }),
    ...(step.eventId === undefined ? {} : { eventId: step.eventId }),
    ...(step.turnId === undefined ? {} : { turnId: privacy.alias("turn", step.turnId) }),
    ...(step.startedAt === undefined ? {} : { startedAt: step.startedAt }),
    ...(step.durationMs === undefined ? {} : { durationMs: step.durationMs }),
  };
}

function pendingToolKey(payload: Record<string, unknown>): string {
  return toolUseId(payload) ?? `${toolName(payload)}:unpaired`;
}

function withoutVerifiedOutcome(session: CaptureSession): CaptureSession {
  const {
    lastVerification: _lastVerification,
    explicitOutcome: _explicitOutcome,
    reviewText: _reviewText,
    ...remaining
  } = session;
  return remaining;
}

function trajectoryTaskId(session: CaptureSession, privacy: RecordAnonymizer): string {
  const projectId = privacy.alias("project", session.project.id);
  const sessionId = privacy.alias("session", session.sessionId);
  return session.comparisonKey === undefined
    ? `capture-session:${session.source}:${sessionId}`
    : `capture-task:${projectId}:${session.comparisonKey}`;
}

function sharedNodeId(step: {
  readonly stepNumber: number;
  readonly nodeKind: CapturedStep["nodeKind"] | "outcome";
  readonly role: CapturedStep["role"];
  readonly content: string;
  readonly toolName?: string;
}): string {
  const semantic = hash(JSON.stringify([step.nodeKind, step.role, step.toolName ?? "", step.content])).slice(0, 16);
  return `node-${step.stepNumber.toString().padStart(4, "0")}-${semantic}`;
}

export class CaptureEngine {
  private state: CaptureState = { version: 1, lastEventTime: -1, seenArtifacts: [], sessions: {} };
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    readonly config: CaptureConfig,
    readonly stateStore: StateStore,
    readonly vault: HookVault,
    readonly spool: DurableSpool,
    readonly privacy = new RecordAnonymizer("none"),
  ) {}

  async initialize(): Promise<void> {
    this.state = await this.stateStore.load();
    const sessions = { ...this.state.sessions };
    let changed = false;
    for (const [key, session] of Object.entries(sessions)) {
      if (session.source !== "unknown") continue;
      const concrete = Object.values(sessions).filter((candidate) =>
        candidate.source !== "unknown" && candidate.sessionId === session.sessionId
      );
      if (concrete.length === 1) {
        delete sessions[key];
        changed = true;
      }
    }
    if (changed) {
      this.state = { ...this.state, sessions };
      await this.stateStore.save(this.state);
    }
    await this.spool.initialize();
  }

  snapshot(): {
    readonly activeSessions: number;
    readonly knownSessions: number;
    readonly unfinishedSessions: number;
    readonly staleSessions: number;
    readonly receivedHooks: number;
    readonly lastHookAt?: string;
    readonly truncatedSteps: number;
  } {
    const sessions = Object.values(this.state.sessions);
    const now = Date.now();
    return {
      activeSessions: sessions.filter((session) => session.active).length,
      knownSessions: sessions.length,
      unfinishedSessions: sessions.filter((session) => !session.finalized).length,
      staleSessions: sessions.filter((session) =>
        !session.finalized && now - Date.parse(session.lastSeenAt) >= this.config.orphanAfterMs
      ).length,
      receivedHooks: this.state.receivedHooks ?? 0,
      ...(this.state.lastHookAt === undefined ? {} : { lastHookAt: this.state.lastHookAt }),
      truncatedSteps: sessions.reduce((total, session) => total + (session.truncatedStepCount ?? 0), 0),
    };
  }

  ingest(source: HookSource, payloadInput: unknown): Promise<{ readonly artifactId: string }> {
    const operation = this.chain.then(() => this.ingestInternal(source, payloadInput));
    this.chain = operation.catch(() => undefined);
    return operation;
  }

  heartbeat(nowMs = Date.now()): Promise<void> {
    const operation = this.chain.then(() => this.heartbeatInternal(nowMs));
    this.chain = operation.catch(() => undefined);
    return operation;
  }

  private async nextArtifact(source: HookSource, payload: unknown): Promise<VaultArtifact> {
    const eventTime = Math.max(Date.now(), this.state.lastEventTime + 1);
    this.state = { ...this.state, lastEventTime: eventTime };
    await this.stateStore.save(this.state);
    return this.vault.store(source, payload, eventTime);
  }

  private context(session: CaptureSession): TerminalSensorContext {
    const sessionId = this.privacy.alias("session", session.sessionId);
    return {
      sensor: this.config.sensorId,
      sessionId,
      heartbeatWindowMs: this.config.heartbeatWindowMs,
      capture: {
        scope: { workspace: this.config.workspaceId },
        identity: {
          agent: session.agent,
          task: `capture-session:${session.source}:${sessionId}`,
          repo: this.privacy.alias("project", session.project.id),
          branch: this.privacy.alias("branch", session.project.branch),
          session: sessionId,
          runtime: session.source,
          project: this.privacy.alias("project-name", session.project.name),
          anonymization: this.config.anonymizationPolicy,
          reasoning: this.config.reasoningPolicy,
          ...(session.comparisonKey === undefined ? {} : { comparison: session.comparisonKey }),
          ...(session.model === undefined ? {} : { model: session.model }),
          ...(session.harnessVersion === undefined ? {} : { harnessVersion: session.harnessVersion }),
          ...(session.permissionMode === undefined ? {} : { permissionMode: session.permissionMode }),
          ...(session.currentTurnId === undefined ? {} : { turn: this.privacy.alias("turn", session.currentTurnId) }),
          ...(session.project.head === undefined
            ? {}
            : { gitHead: privateDigest(this.privacy, "git-head", session.project.head) }),
          ...(session.project.worktreeDigest === undefined
            ? {}
            : { worktree: privateDigest(this.privacy, "worktree", session.project.worktreeDigest) }),
        },
      },
    };
  }

  private async enqueueEvent(event: ReturnType<typeof makeSensorLifecycleEvent>): Promise<void> {
    const job: SpoolJob = {
      version: 1,
      kind: "event",
      id: event.id,
      createdAt: new Date().toISOString(),
      event,
    };
    await this.spool.enqueue(job);
  }

  private async observe(
    session: CaptureSession,
    artifact: VaultArtifact,
    index: number,
    observation: TerminalObservation,
    causedBy: readonly string[] | undefined = session.lastEventId === undefined ? undefined : [session.lastEventId],
  ): Promise<CaptureSession> {
    const privateObservation: TerminalObservation = {
      ...observation,
      ...(observation.data === undefined
        ? {}
        : { data: this.privacy.value(observation.data) as Readonly<Record<string, JsonValue>> }),
      ...(observation.output === undefined ? {} : { output: this.privacy.text(observation.output) }),
    };
    const event = makeTerminalObservationEvent(
      this.context(session),
      stamp(artifact, index, "observation"),
      privateObservation,
      causedBy,
    );
    await this.enqueueEvent(event);
    return { ...session, lastEventId: event.id };
  }

  private async ensureSession(
    source: HookSource,
    payload: Record<string, unknown>,
    artifact: VaultArtifact,
  ): Promise<{
    readonly key: string;
    readonly session: CaptureSession;
    readonly resumed: boolean;
    readonly created: boolean;
  }> {
    const sessionId = nativeSessionId(payload);
    if (sessionId === undefined) throw new TypeError("hook payload requires session_id");
    const key = sessionKey(source, sessionId);
    let existing = this.state.sessions[key];
    if (existing === undefined && source !== "unknown") {
      const provisionalKey = sessionKey("unknown", sessionId);
      const provisional = this.state.sessions[provisionalKey];
      if (provisional !== undefined && !provisional.finalized) {
        const sessions = { ...this.state.sessions };
        delete sessions[provisionalKey];
        existing = { ...provisional, source, agent: agentName(source) };
        this.state = { ...this.state, sessions };
      }
    }
    const observedTranscriptPath = transcriptPath(payload);
    const observedModel = text(payload.model);
    const observedHarnessVersion = text(payload.client_version) ?? text(payload.clientVersion) ?? text(payload.harness_version);
    const observedPermissionMode = text(payload.permission_mode) ?? text(payload.permissionMode);
    const observedTurnId = text(payload.turn_id) ?? text(payload.turnId);
    if (existing !== undefined) {
      const resumed = !existing.active && !existing.finalized;
      return {
        key,
        resumed,
        created: false,
        session: {
          ...existing,
          active: !existing.finalized,
          lastSeenAt: artifact.receivedAt,
          ...(observedTranscriptPath === undefined ? {} : { transcriptPath: observedTranscriptPath }),
          ...(observedModel === undefined ? {} : { model: observedModel }),
          ...(observedHarnessVersion === undefined ? {} : { harnessVersion: observedHarnessVersion }),
          ...(observedPermissionMode === undefined ? {} : { permissionMode: observedPermissionMode }),
          ...(observedTurnId === undefined ? {} : { currentTurnId: observedTurnId }),
        },
      };
    }
    const project = await resolveProject(text(payload.cwd), text(payload.git_branch) ?? text(payload.branch));
    let session: CaptureSession = {
      sessionId,
      source,
      agent: agentName(source),
      startedAt: artifact.receivedAt,
      project,
      ...(observedTranscriptPath === undefined ? {} : { transcriptPath: observedTranscriptPath }),
      ...(observedModel === undefined ? {} : { model: observedModel }),
      ...(observedHarnessVersion === undefined ? {} : { harnessVersion: observedHarnessVersion }),
      ...(observedPermissionMode === undefined ? {} : { permissionMode: observedPermissionMode }),
      ...(observedTurnId === undefined ? {} : { currentTurnId: observedTurnId }),
      steps: [],
      finalized: false,
      active: true,
      lastSeenAt: artifact.receivedAt,
    };
    session = stepFor(session, {
      nodeKind: "observation",
      role: "decision",
      content: "Coding-agent session started",
    });
    return { key, session, resumed: false, created: true };
  }

  private async ingestInternal(source: HookSource, payloadInput: unknown): Promise<{ readonly artifactId: string }> {
    const payload = object(payloadInput);
    if (payload === undefined) throw new TypeError("hook payload must be a JSON object");
    const artifact = await this.nextArtifact(source, payload);
    this.state = {
      ...this.state,
      receivedHooks: (this.state.receivedHooks ?? 0) + 1,
      lastHookAt: artifact.receivedAt,
    };
    await this.stateStore.save(this.state);
    const ensured = await this.ensureSession(source, payload, artifact);
    let session: CaptureSession = {
      ...ensured.session,
      observedEventCount: (ensured.session.observedEventCount ?? 0) + 1,
    };
    let index = 0;
    if (ensured.created || ensured.resumed || hookName(payload) === "SessionStart") {
      await this.enqueueEvent(makeSensorLifecycleEvent(
        this.context(session),
        stamp(artifact, index++, "lifecycle"),
        "online",
        ensured.resumed ? "Session observed after capture daemon restart" : undefined,
      ));
    }

    const name = hookName(payload);
    if (name === "UserPromptSubmit") {
      const prompt = text(payload.prompt) ?? text(payload.user_prompt) ?? "";
      const explicitTaskKey = text(payload.task_key) ?? text(payload.taskId) ?? text(payload.comparison_key);
      const normalizedPrompt = prompt.trim().toLocaleLowerCase().replace(/\s+/g, " ");
      const comparisonKey = explicitTaskKey !== undefined
        ? `task-${privateDigest(this.privacy, "task-key", explicitTaskKey).slice(0, 24)}`
        : normalizedPrompt.length === 0
          ? undefined
          : `prompt-${privateDigest(this.privacy, "prompt", normalizedPrompt).slice(0, 24)}`;
      session = {
        ...session,
        ...(session.comparisonKey !== undefined || comparisonKey === undefined ? {} : { comparisonKey }),
        ...(session.taskKey !== undefined || explicitTaskKey === undefined ? {} : { taskKey: bounded(explicitTaskKey, 500) }),
      };
      session = await this.observe(session, artifact, index++, {
        kind: "prompt_submitted",
        data: {
          artifactId: artifact.id,
          characters: prompt.length,
          ...(session.currentTurnId === undefined ? {} : { turnId: session.currentTurnId }),
          ...(comparisonKey === undefined ? {} : { comparisonKey }),
        },
      });
      session = stepFor(session, {
        nodeKind: "observation",
        role: "decision",
        content: "User submitted a task prompt",
        artifactId: artifact.id,
        eventId: session.lastEventId!,
        ...(session.currentTurnId === undefined ? {} : { turnId: session.currentTurnId }),
      });
    } else if (name === "PreToolUse") {
      const tool = toolName(payload);
      const verification = verificationKind(payload);
      session = await this.observe(session, artifact, index++, {
        kind: "tool_running",
        data: {
          toolName: tool,
          artifactId: artifact.id,
          startedAt: artifact.receivedAt,
          ...(session.currentTurnId === undefined ? {} : { turnId: session.currentTurnId }),
          ...(toolUseId(payload) === undefined ? {} : { toolUseId: toolUseId(payload)! }),
          ...(verification === undefined ? {} : { category: verification }),
        },
      });
      session = {
        ...session,
        pendingTools: {
          ...(session.pendingTools ?? {}),
          [pendingToolKey(payload)]: {
            artifactId: artifact.id,
            startedAt: artifact.receivedAt,
            eventTime: artifact.eventTime,
            toolName: tool,
            eventId: session.lastEventId!,
          },
        },
      };
      session = stepFor(session, {
        nodeKind: "action",
        role: "tool_call",
        content: `Invoke ${tool}`,
        toolName: tool,
        artifactId: artifact.id,
        eventId: session.lastEventId!,
        startedAt: artifact.receivedAt,
        ...(session.currentTurnId === undefined ? {} : { turnId: session.currentTurnId }),
      });
    } else if (name === "HermesStep") {
      const tools = Array.isArray(payload.tool_names)
        ? payload.tool_names.filter((value): value is string => typeof value === "string" && value.trim().length > 0).slice(0, 50)
        : [];
      const iteration = typeof payload.iteration === "number" && Number.isFinite(payload.iteration)
        ? payload.iteration
        : undefined;
      for (const rawTool of tools) {
        const tool = bounded(rawTool.trim(), 200);
        session = await this.observe(session, artifact, index++, {
          kind: "tool_running",
          data: {
            toolName: tool,
            source: "hermes-agent-step",
            artifactId: artifact.id,
            ...(iteration === undefined ? {} : { iteration }),
          },
        });
        session = stepFor(session, {
          nodeKind: "action",
          role: "tool_call",
          content: `Hermes invoked ${tool}`,
          toolName: tool,
          artifactId: artifact.id,
          eventId: session.lastEventId!,
        });
      }
    } else if (name === "PostToolUse" || name === "PostToolUseFailure") {
      const tool = toolName(payload);
      const success = toolSucceeded(name, payload);
      const verification = verificationKind(payload);
      const key = pendingToolKey(payload);
      const pending = session.pendingTools?.[key];
      const durationMs = pending === undefined ? undefined : Math.max(0, artifact.eventTime - pending.eventTime);
      session = await this.observe(session, artifact, index++, {
        kind: "tool_result",
        data: {
          toolName: tool,
          status: success ? "completed" : "failed",
          artifactId: artifact.id,
          ...(durationMs === undefined ? {} : { durationMs }),
          ...(session.currentTurnId === undefined ? {} : { turnId: session.currentTurnId }),
          ...(toolUseId(payload) === undefined ? {} : { toolUseId: toolUseId(payload)! }),
        },
      }, pending === undefined ? undefined : [pending.eventId]);
      if (session.pendingTools !== undefined) {
        const { [key]: _completed, ...remaining } = session.pendingTools;
        session = { ...session, pendingTools: remaining };
      }
      session = stepFor(session, {
        nodeKind: "observation",
        role: "tool_call_response",
        content: `${tool} ${success ? "completed" : "failed"}`,
        toolName: tool,
        artifactId: artifact.id,
        eventId: session.lastEventId!,
        ...(pending === undefined ? {} : { startedAt: pending.startedAt }),
        ...(durationMs === undefined ? {} : { durationMs }),
        ...(session.currentTurnId === undefined ? {} : { turnId: session.currentTurnId }),
      });
      const beforeProject = session.project;
      const refreshedProject = await refreshProject(beforeProject);
      const repositoryChanged = refreshedProject.head !== beforeProject.head ||
        refreshedProject.worktreeDigest !== beforeProject.worktreeDigest;
      session = { ...session, project: refreshedProject };
      const paths = [...new Set([
        ...changedPaths(payload, session.project.root),
        ...(repositoryChanged ? refreshedProject.changedPaths ?? [] : []),
      ])].slice(0, 200);
      const mutatingTool = /edit|write|patch|notebook/i.test(tool) || repositoryChanged;
      if (success && mutatingTool) session = withoutVerifiedOutcome(session);
      if (success && mutatingTool) {
        session = await this.observe(session, artifact, index++, {
          kind: repositoryChanged ? "repository_changed" : "file_changed",
          data: {
            toolName: tool,
            paths,
            artifactId: artifact.id,
            ...(beforeProject.head === undefined ? {} : { headBefore: beforeProject.head }),
            ...(refreshedProject.head === undefined ? {} : { headAfter: refreshedProject.head }),
            ...(beforeProject.worktreeDigest === undefined ? {} : { worktreeBefore: beforeProject.worktreeDigest }),
            ...(refreshedProject.worktreeDigest === undefined ? {} : { worktreeAfter: refreshedProject.worktreeDigest }),
            ...(refreshedProject.dirty === undefined ? {} : { dirty: refreshedProject.dirty }),
            ...(session.currentTurnId === undefined ? {} : { turnId: session.currentTurnId }),
          },
        });
      }
      if (verification !== undefined) {
        session = await this.observe(session, artifact, index++, {
          kind: "verification_result",
          data: {
            category: verification,
            status: success ? "success" : "failure",
            toolName: tool,
            artifactId: artifact.id,
            ...(durationMs === undefined ? {} : { durationMs }),
            ...(session.currentTurnId === undefined ? {} : { turnId: session.currentTurnId }),
          },
        });
        session = {
          ...stepFor(session, {
            nodeKind: "observation",
            role: "tool_call_response",
            content: `${verification} verification ${success ? "passed" : "failed"}`,
            toolName: tool,
            artifactId: artifact.id,
            eventId: session.lastEventId!,
            ...(pending === undefined ? {} : { startedAt: pending.startedAt }),
            ...(durationMs === undefined ? {} : { durationMs }),
            ...(session.currentTurnId === undefined ? {} : { turnId: session.currentTurnId }),
          }),
          lastVerification: success ? "success" : "failure",
        };
      }
    } else if (name === "PermissionRequest" || name === "Notification") {
      session = await this.observe(session, artifact, index++, {
        kind: "blocking_prompt",
        data: {
          requestType: name,
          ...(text(payload.tool_name) === undefined ? {} : { toolName: bounded(text(payload.tool_name)!, 200) }),
          artifactId: artifact.id,
        },
      });
      session = stepFor(session, {
        nodeKind: "observation",
        role: "decision",
        content: "Agent requested operator attention",
        artifactId: artifact.id,
        eventId: session.lastEventId!,
        ...(session.currentTurnId === undefined ? {} : { turnId: session.currentTurnId }),
      });
    } else if (name === "ReasoningCheckpoint") {
      const summary = text(payload.summary);
      if (summary === undefined) throw new TypeError("reasoning checkpoint requires summary");
      const confidence = typeof payload.confidence === "number" && Number.isFinite(payload.confidence)
        ? Math.max(0, Math.min(1, payload.confidence))
        : undefined;
      const data: Record<string, JsonValue> = {
        summary: bounded(summary, 2_000),
        artifactId: artifact.id,
        ...(confidence === undefined ? {} : { confidence }),
      };
      for (const field of ["hypothesis", "evidence", "decision"] as const) {
        const value = text(payload[field]);
        if (value !== undefined) data[field] = bounded(value, 2_000);
      }
      session = await this.observe(session, artifact, index++, { kind: "reasoning_checkpoint", data });
      session = stepFor(session, {
        nodeKind: "decision",
        role: "model_thought",
        content: bounded(summary, 2_000),
        artifactId: artifact.id,
        eventId: session.lastEventId!,
        ...(session.currentTurnId === undefined ? {} : { turnId: session.currentTurnId }),
      });
    } else if (name === "HumanDecision") {
      const summary = text(payload.summary);
      const verdict = payload.verdict === "success" || payload.verdict === "failure" ? payload.verdict : undefined;
      if (summary === undefined) throw new TypeError("human decision requires summary");
      session = await this.observe(session, artifact, index++, {
        kind: "human_decision",
        data: {
          summary: bounded(summary, 2_000),
          artifactId: artifact.id,
          ...(verdict === undefined ? {} : { verdict }),
          ...(typeof payload.confidence === "number" && Number.isFinite(payload.confidence)
            ? { confidence: Math.max(0, Math.min(1, payload.confidence)) }
            : {}),
        },
      });
      const confidence = typeof payload.confidence === "number"
        ? Math.max(0, Math.min(1, payload.confidence))
        : undefined;
      session = {
        ...stepFor(session, {
          nodeKind: "decision",
          role: "decision",
          content: bounded(summary, 2_000),
          artifactId: artifact.id,
          eventId: session.lastEventId!,
          ...(session.currentTurnId === undefined ? {} : { turnId: session.currentTurnId }),
        }),
        ...(verdict === undefined ? {} : {
          explicitOutcome: verdict,
          reviewText: `VERDICT: ${verdict === "success" ? "approve" : "reject"}${confidence === undefined ? "" : `\nCONFIDENCE: ${confidence}`}`,
        }),
      };
    } else if (name === "Stop") {
      const assistantMessage = text(payload.last_assistant_message) ?? text(payload.lastAssistantMessage) ?? "";
      session = await this.observe(session, artifact, index++, {
        kind: "task_complete",
        data: {
          artifactId: artifact.id,
          outputCharacters: assistantMessage.length,
          ...(assistantMessage.length === 0
            ? {}
            : { outputHash: privateDigest(this.privacy, "output", assistantMessage) }),
          ...(session.currentTurnId === undefined ? {} : { turnId: session.currentTurnId }),
        },
      });
      session = stepFor(session, {
        nodeKind: "observation",
        role: "model_output",
        content: "Agent completed a response",
        artifactId: artifact.id,
        eventId: session.lastEventId!,
        ...(session.currentTurnId === undefined ? {} : { turnId: session.currentTurnId }),
      });
    } else if (name === "SessionEnd") {
      const reasoning = await this.captureExposedReasoning(session, artifact, index);
      session = reasoning.session;
      index = reasoning.nextIndex;
      await this.enqueueEvent(makeSensorLifecycleEvent(
        this.context(session),
        stamp(artifact, index++, "lifecycle"),
        "offline",
        text(payload.reason) === undefined ? undefined : bounded(text(payload.reason)!, 500),
      ));
      if (!session.finalized) {
        await this.enqueueTrajectory(session, artifact, index, "session-end");
        index += 2;
        if (session.transcriptPath !== undefined && (source === "claude-code" || source === "codex")) {
          const transcriptJob: SpoolJob = {
            version: 1,
            kind: "transcript",
            id: `capture-${artifact.eventTime.toString().padStart(13, "0")}-950-transcript-${artifact.id.slice(0, 12)}`,
            createdAt: artifact.receivedAt,
            notBefore: new Date(artifact.eventTime + 2_000).toISOString(),
            deadlineAt: new Date(artifact.eventTime + 30 * 60_000).toISOString(),
            source,
            path: session.transcriptPath,
          };
          await this.spool.enqueue(transcriptJob);
        }
      }
      session = { ...session, active: false, finalized: true, finalizationReason: "session-end" };
    }

    const eventsSinceSnapshot = (session.observedEventCount ?? 0) - (session.lastTreeSnapshotEventCount ?? 0);
    if (
      name !== "SessionEnd" &&
      this.config.treeSnapshotEveryEvents > 0 &&
      session.comparisonKey !== undefined &&
      eventsSinceSnapshot >= this.config.treeSnapshotEveryEvents
    ) {
      const reasoning = await this.captureExposedReasoning(session, artifact, index);
      session = reasoning.session;
      index = reasoning.nextIndex;
      await this.enqueueTreeSnapshot(session, artifact, index);
      session = { ...session, lastTreeSnapshotEventCount: session.observedEventCount ?? 0 };
    }

    this.state = {
      ...this.state,
      seenArtifacts: [...this.state.seenArtifacts, artifact.id].slice(-10_000),
      sessions: { ...this.state.sessions, [ensured.key]: session },
    };
    await this.stateStore.save(this.state);
    return { artifactId: artifact.id };
  }

  private async captureExposedReasoning(
    session: CaptureSession,
    artifact: VaultArtifact,
    index: number,
  ): Promise<{ readonly session: CaptureSession; readonly nextIndex: number }> {
    if (
      this.config.reasoningPolicy !== "include" ||
      session.transcriptPath === undefined ||
      (session.source !== "claude-code" && session.source !== "codex")
    ) {
      return { session, nextIndex: index };
    }
    let delta: Awaited<ReturnType<typeof readExposedReasoningDelta>>;
    try {
      delta = await readExposedReasoningDelta(
        session.transcriptPath,
        session.source,
        session.reasoningCursor ?? 0,
        { maxBytes: TRANSCRIPT_DELTA_MAX_BYTES },
      );
    } catch {
      return { session, nextIndex: index };
    }
    const seen = new Set(session.seenReasoningIds ?? []);
    const fresh = delta.items.filter(({ id }) => !seen.has(id));
    let next: CaptureSession = {
      ...session,
      reasoningCursor: delta.cursor,
      seenReasoningIds: [...(session.seenReasoningIds ?? []), ...fresh.map(({ id }) => id)].slice(-5_000),
    };
    if (delta.records.length === 0) return { session: next, nextIndex: index };
    const summaries = fresh.map((item) => ({
      id: this.privacy.alias("reasoning-record", item.id),
      text: bounded(this.privacy.text(item.text), 2_000),
    }));
    const reasoningArtifact = await this.vault.store(session.source, {
      hook_event_name: "TranscriptDelta",
      session_id: session.sessionId,
      transcript_path: session.transcriptPath,
      start_cursor: delta.startCursor,
      end_cursor: delta.cursor,
      record_count: delta.records.length,
      records: delta.records,
      summaries,
    }, artifact.eventTime);
    let nextIndex = index;
    if (this.config.reasoningTreePolicy !== "summaries" || summaries.length === 0) {
      return { session: next, nextIndex };
    }
    for (const summary of summaries) {
      next = await this.observe(next, artifact, nextIndex++, {
        kind: "reasoning_observed",
        data: {
          summary: summary.text,
          artifactId: reasoningArtifact.id,
          sourceRecordId: summary.id,
          ...(next.currentTurnId === undefined ? {} : { turnId: next.currentTurnId }),
        },
      });
      next = stepFor(next, {
        nodeKind: "decision",
        role: "model_thought",
        content: summary.text,
        artifactId: reasoningArtifact.id,
        eventId: next.lastEventId!,
        ...(next.currentTurnId === undefined ? {} : { turnId: next.currentTurnId }),
      });
    }
    return { session: next, nextIndex };
  }

  private treeFor(
    session: CaptureSession,
    outcome?: "success" | "failure" | "unknown",
  ): TrajectoryTreeRecord["tree"] {
    const taskId = trajectoryTaskId(session, this.privacy);
    const steps = session.steps.length > 0 ? session.steps : [{
      id: "step-1",
      stepNumber: 1,
      nodeKind: "observation" as const,
      role: "decision" as const,
      content: "Coding-agent session observed",
    }];
    const finalStepId = `step-${steps.length + 1}`;
    const projectedSteps = [
      ...steps.map((step) => ({ ...step, content: this.privacy.text(step.content) })),
      ...(outcome === undefined ? [] : [{
        id: finalStepId,
        stepNumber: steps.length + 1,
        nodeKind: "outcome" as const,
        role: "model_output" as const,
        content: outcome === "unknown" ? "Outcome not verified" : `Outcome ${outcome}`,
      }]),
    ];
    const nodes: TrajectoryTreeRecord["tree"]["nodes"] = [
      ...projectedSteps.map((step) => ({
        id: sharedNodeId(step),
        kind: step.nodeKind,
        label: bounded(step.content),
      })),
    ];
    return {
      taskId,
      rootNodeId: nodes[0]!.id,
      nodes,
      edges: nodes.slice(1).map((node, edgeIndex) => ({
        id: `edge-${hash(`${nodes[edgeIndex]!.id}\0${node.id}`).slice(0, 20)}`,
        sourceId: nodes[edgeIndex]!.id,
        targetId: node.id,
        label: "next observed step",
      })),
    };
  }

  private captureIdentity(
    session: CaptureSession,
    finalizationReason?: "session-end" | "orphan-timeout",
  ): Readonly<Record<string, string>> {
    return {
      agent: session.agent,
      session: this.privacy.alias("session", session.sessionId),
      repo: this.privacy.alias("project", session.project.id),
      branch: this.privacy.alias("branch", session.project.branch),
      runtime: session.source,
      project: this.privacy.alias("project-name", session.project.name),
      anonymization: this.config.anonymizationPolicy,
      reasoning: this.config.reasoningPolicy,
      ...(session.project.head === undefined
        ? {}
        : { gitHead: privateDigest(this.privacy, "git-head", session.project.head) }),
      ...(session.project.worktreeDigest === undefined
        ? {}
        : { worktree: privateDigest(this.privacy, "worktree", session.project.worktreeDigest) }),
      ...(session.harnessVersion === undefined ? {} : { harnessVersion: session.harnessVersion }),
      ...((session.truncatedStepCount ?? 0) === 0 ? {} : { truncatedSteps: String(session.truncatedStepCount) }),
      ...((finalizationReason ?? session.finalizationReason) === undefined
        ? {}
        : { finalizationReason: (finalizationReason ?? session.finalizationReason)! }),
      ...(session.comparisonKey === undefined ? {} : { comparison: session.comparisonKey }),
    };
  }

  private async enqueueTreeSnapshot(
    session: CaptureSession,
    artifact: VaultArtifact,
    index: number,
  ): Promise<void> {
    const tree = this.treeFor(session);
    const job: SpoolJob = {
      version: 1,
      kind: "trajectory-tree",
      id: `capture-${artifact.eventTime.toString().padStart(13, "0")}-${index.toString().padStart(3, "0")}-tree-snapshot-${artifact.id.slice(0, 12)}`,
      createdAt: artifact.receivedAt,
      treeStamp: eventStamp(artifact, index, "trajectory-tree-snapshot"),
      tree,
      captureIdentity: {
        ...this.captureIdentity(session),
        snapshot: "true",
        observedEvents: String(session.observedEventCount ?? 0),
      },
    };
    await this.spool.enqueue(job);
  }

  private async enqueueTrajectory(
    session: CaptureSession,
    artifact: VaultArtifact,
    index: number,
    finalizationReason?: "session-end" | "orphan-timeout",
  ): Promise<void> {
    const outcome = session.explicitOutcome ?? session.lastVerification ?? "unknown";
    const tree = this.treeFor(session, outcome);
    const taskId = tree.taskId;
    const steps = session.steps.length > 0 ? session.steps : [{
      id: "step-1",
      stepNumber: 1,
      nodeKind: "observation" as const,
      role: "decision" as const,
      content: "Coding-agent session observed",
    }];
    const finalStepId = `step-${steps.length + 1}`;
    const allSteps: TrajectoryInput["steps"] = [
      ...steps.map((step) => traceStep(step, this.privacy)),
      {
        id: finalStepId,
        stepNumber: steps.length + 1,
        role: "model_output",
        content: outcome === "unknown" ? "Session ended without a verified outcome" : `Session outcome: ${outcome}`,
        artifactId: artifact.id,
        ...(session.currentTurnId === undefined ? {} : { turnId: this.privacy.alias("turn", session.currentTurnId) }),
      },
    ];
    const assignments: TrajectoryInput["assignments"] = Object.fromEntries(
      allSteps.map((step, stepIndex) => [step.id, {
        kind: "mapped" as const,
        nodeId: tree.nodes[stepIndex]!.id,
        method: { kind: "rule" as const, id: "super-brain-capture/v1", confidence: 1 },
      }]),
    );
    const input: TrajectoryInput = {
      id: `trajectory:${session.source}:${this.privacy.alias("session", session.sessionId)}`,
      taskId,
      model: {
        id: session.model ?? session.agent,
      },
      outcome,
      steps: allSteps,
      assignments,
      ...(session.reviewText === undefined ? {} : { reviewText: session.reviewText }),
    };
    const captureIdentity = this.captureIdentity(session, finalizationReason);
    const job: SpoolJob = {
      version: 1,
      kind: "trajectory",
      id: `capture-${artifact.eventTime.toString().padStart(13, "0")}-900-trajectory-${artifact.id.slice(0, 12)}`,
      createdAt: artifact.receivedAt,
      treeStamp: eventStamp(artifact, index, "trajectory-tree"),
      runStamp: eventStamp(artifact, index + 1, "trajectory-run"),
      tree,
      input,
      captureIdentity,
    };
    await this.spool.enqueue(job);
  }

  private async heartbeatInternal(nowMs: number): Promise<void> {
    for (const [key, session] of Object.entries(this.state.sessions)) {
      if (session.finalized) continue;
      const lastSeen = Date.parse(session.lastSeenAt);
      if (Number.isFinite(lastSeen) && nowMs - lastSeen >= this.config.orphanAfterMs) {
        await this.finalizeOrphan(key, session, nowMs);
        continue;
      }
      if (!session.active) continue;
      const eventTime = Math.max(nowMs, this.state.lastEventTime + 1);
      const receivedAt = new Date(eventTime).toISOString();
      const artifact: VaultArtifact = {
        id: hash(`heartbeat:${key}:${eventTime}`),
        receivedAt,
        eventTime,
        path: "",
      };
      this.state = { ...this.state, lastEventTime: eventTime };
      await this.enqueueEvent(makeSensorLifecycleEvent(
        this.context(session),
        stamp(artifact, 0, "heartbeat"),
        "heartbeat",
      ));
    }
    await this.stateStore.save(this.state);
  }

  private async finalizeOrphan(key: string, sessionInput: CaptureSession, nowMs: number): Promise<void> {
    const eventTime = Math.max(nowMs, this.state.lastEventTime + 1);
    const receivedAt = new Date(eventTime).toISOString();
    const artifact: VaultArtifact = {
      id: hash(`orphan:${key}:${sessionInput.lastSeenAt}`),
      receivedAt,
      eventTime,
      path: "",
    };
    let session = {
      ...withoutVerifiedOutcome(sessionInput),
      active: false,
      finalized: true,
      finalizationReason: "orphan-timeout" as const,
    };
    this.state = { ...this.state, lastEventTime: eventTime };
    const reasoning = await this.captureExposedReasoning(session, artifact, 0);
    session = { ...reasoning.session, active: false, finalized: true, finalizationReason: "orphan-timeout" };
    let index = reasoning.nextIndex;
    await this.enqueueEvent(makeSensorLifecycleEvent(
      this.context(session),
      stamp(artifact, index++, "orphan"),
      "offline",
      `Capture finalized after ${this.config.orphanAfterMs}ms without a hook`,
    ));
    await this.enqueueTrajectory(session, artifact, index, "orphan-timeout");
    if (session.transcriptPath !== undefined && (session.source === "claude-code" || session.source === "codex")) {
      await this.spool.enqueue({
        version: 1,
        kind: "transcript",
        id: `capture-${artifact.eventTime.toString().padStart(13, "0")}-950-transcript-${artifact.id.slice(0, 12)}`,
        createdAt: receivedAt,
        notBefore: new Date(eventTime + 2_000).toISOString(),
        deadlineAt: new Date(eventTime + 30 * 60_000).toISOString(),
        source: session.source,
        path: session.transcriptPath,
      });
    }
    this.state = { ...this.state, sessions: { ...this.state.sessions, [key]: session } };
  }
}
