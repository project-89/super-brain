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
import { mergeRecoveredSteps, recoverCapturedSteps } from "./recovery.js";
import {
  DurableSpool,
  HookVault,
  SessionStepStore,
  StateStore,
  TranscriptSnapshotStore,
} from "./storage.js";
import type {
  CaptureConfig,
  CapturedStep,
  CaptureSession,
  CaptureState,
  HookSource,
  SpoolJob,
  StoredHookArtifact,
  TrajectoryFinalizationReason,
  VaultArtifact,
} from "./types.js";

const TRANSCRIPT_DELTA_MAX_BYTES = 8 * 1024 * 1024;
const HOOK_RETRY_WINDOW_MS = 30_000;

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
  return [...new Set(values)];
}

function pagesOf<T>(values: readonly T[], size: number): readonly (readonly T[])[] {
  if (values.length === 0) return [[]];
  return Array.from({ length: Math.ceil(values.length / size) }, (_, index) => values.slice(index * size, (index + 1) * size));
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

function completedResponse(step: CapturedStep): boolean {
  return step.role === "model_output" && step.content === "Agent completed a response";
}

function promptStart(step: CapturedStep): boolean {
  return step.role === "decision" && step.content === "User submitted a task prompt";
}

function currentUnitSteps(session: CaptureSession): readonly CapturedStep[] {
  const start = session.currentUnitStartStepNumber ??
    ((session.completedUnitCount ?? 0) === 0 ? 1 : undefined);
  if (start === undefined) return [];
  return session.steps.slice(Math.max(0, start - 1), session.currentUnitEndStepNumber).map((step, index) => ({
    ...step,
    id: `step-${index + 1}`,
    stepNumber: index + 1,
  }));
}

function completeCurrentUnit(session: CaptureSession): CaptureSession {
  const {
    currentUnitStartStepNumber: _start,
    currentUnitEndStepNumber: _end,
    ...remaining
  } = session;
  return {
    ...remaining,
    evaluationUnitVersion: 2,
    completedUnitCount: (session.completedUnitCount ?? 0) + 1,
    finalizedThroughStepNumber: session.steps.length,
  };
}

function migrateEvaluationUnits(session: CaptureSession): CaptureSession {
  if (session.evaluationUnitVersion === 2) return session;
  const completed = session.steps.filter(completedResponse);
  const lastCompleted = completed.at(-1)?.stepNumber ?? 0;
  const openPrompt = [...session.steps].reverse().find((step) =>
    promptStart(step) && step.stepNumber > lastCompleted
  );
  const {
    evaluationUnitVersion: _version,
    currentUnitStartStepNumber: _start,
    currentUnitEndStepNumber: _end,
    completedUnitCount: _completed,
    finalizedThroughStepNumber: _finalizedThrough,
    ...base
  } = session;
  return {
    ...base,
    evaluationUnitVersion: 2,
    completedUnitCount: 0,
    ...(openPrompt === undefined ? {} : { currentUnitStartStepNumber: openPrompt.stepNumber }),
  };
}

interface ClosedEvaluationUnit {
  readonly startStepNumber: number;
  readonly endStepNumber: number;
  readonly reason: "stop" | "prompt-boundary";
  readonly boundaryStep: CapturedStep;
  readonly promptStep?: CapturedStep;
}

function closedEvaluationUnits(session: CaptureSession): readonly ClosedEvaluationUnit[] {
  const after = session.finalizedThroughStepNumber ?? 0;
  let start: number | undefined;
  let prompt: CapturedStep | undefined;
  let lastBoundary = after;
  const units: ClosedEvaluationUnit[] = [];
  for (const step of session.steps) {
    if (step.stepNumber <= after) continue;
    if (promptStart(step)) {
      if (start !== undefined && step.stepNumber > start) {
        units.push({
          startStepNumber: start,
          endStepNumber: step.stepNumber - 1,
          reason: "prompt-boundary",
          boundaryStep: step,
          ...(prompt === undefined ? {} : { promptStep: prompt }),
        });
        lastBoundary = step.stepNumber - 1;
      }
      start = step.stepNumber;
      prompt = step;
      continue;
    }
    if (!completedResponse(step)) continue;
    const unitStart = start ?? lastBoundary + 1;
    if (unitStart <= step.stepNumber) {
      units.push({
        startStepNumber: unitStart,
        endStepNumber: step.stepNumber,
        reason: "stop",
        boundaryStep: step,
        ...(prompt === undefined ? {} : { promptStep: prompt }),
      });
    }
    lastBoundary = step.stepNumber;
    start = undefined;
    prompt = undefined;
  }
  return units;
}

function eventTimeFromStep(step: CapturedStep): number | undefined {
  const match = /^capture-(\d{13})-/.exec(step.eventId ?? "");
  if (match === null) return undefined;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : undefined;
}

function unitOutcome(steps: readonly CapturedStep[]): "success" | "failure" | undefined {
  let outcome: "success" | "failure" | undefined;
  for (const step of steps) {
    if (step.role === "tool_call" && /edit|write|patch|notebook/i.test(step.toolName ?? "")) {
      outcome = undefined;
    }
    if (/\bverification passed$/.test(step.content)) outcome = "success";
    if (/\bverification failed$/.test(step.content)) outcome = "failure";
  }
  return outcome;
}

function trajectoryTaskId(session: CaptureSession, privacy: RecordAnonymizer): string {
  const projectId = privacy.alias("project", session.project.id);
  const sessionId = privacy.alias("session", session.sessionId);
  return session.comparisonKey === undefined
    ? `capture-session-v2:${session.source}:${sessionId}`
    : `capture-task-v2:${projectId}:${session.comparisonKey}`;
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
    readonly stepStore = new SessionStepStore(config.stateRoot),
    readonly transcriptSnapshots = new TranscriptSnapshotStore(config.stateRoot, {
      reasoningPolicy: config.reasoningPolicy,
      retainEncryptedReasoning: config.retainEncryptedReasoning,
    }),
  ) {}

  async initialize(): Promise<void> {
    this.state = await this.stateStore.load();
    await this.stepStore.initialize();
    await this.spool.initialize();
    const sessions = { ...this.state.sessions };
    let changed = false;
    for (const [key, session] of Object.entries(sessions)) {
      let hydrated = await this.stepStore.synchronize(session);
      if ((hydrated.truncatedStepCount ?? 0) > 0) {
        const artifacts = await this.vault.sessionArtifacts(hydrated.source, hydrated.sessionId);
        const recovered = mergeRecoveredSteps(hydrated.steps, recoverCapturedSteps(artifacts));
        if (recovered.recoveredCount > 0) {
          hydrated = await this.stepStore.replace(hydrated, recovered.steps);
          const remaining = Math.max(0, (session.truncatedStepCount ?? 0) - recovered.recoveredCount);
          const { truncatedStepCount: _truncated, ...withoutTruncation } = hydrated;
          hydrated = {
            ...withoutTruncation,
            ...(remaining === 0 ? {} : { truncatedStepCount: remaining }),
            recoveredStepCount: (session.recoveredStepCount ?? 0) + recovered.recoveredCount,
          };
        }
      }
      hydrated = migrateEvaluationUnits(hydrated);
      hydrated = await this.backfillCompletedUnits(hydrated);
      sessions[key] = hydrated;
      if (
        session.steps.length > 0 ||
        hydrated.stepCount !== session.stepCount ||
        hydrated.truncatedStepCount !== session.truncatedStepCount ||
        hydrated.currentUnitStartStepNumber !== session.currentUnitStartStepNumber ||
        hydrated.completedUnitCount !== session.completedUnitCount ||
        hydrated.finalizedThroughStepNumber !== session.finalizedThroughStepNumber ||
        hydrated.evaluationUnitVersion !== session.evaluationUnitVersion
      ) changed = true;
      if (session.source !== "unknown") continue;
      const concrete = Object.values(sessions).filter((candidate) =>
        candidate.source !== "unknown" && candidate.sessionId === session.sessionId
      );
      if (concrete.length === 1) {
        delete sessions[key];
        changed = true;
      }
    }
    this.state = { ...this.state, sessions };
    if (changed) {
      await this.stateStore.save(this.state);
    }
  }

  snapshot(): {
    readonly activeSessions: number;
    readonly knownSessions: number;
    readonly unfinishedSessions: number;
    readonly staleSessions: number;
    readonly receivedHooks: number;
    readonly duplicateHooks: number;
    readonly lastHookAt?: string;
    readonly truncatedSteps: number;
    readonly finalizedSessions: number;
    readonly finalizedUnits: number;
    readonly oldestUnfinishedAgeMs?: number;
  } {
    const sessions = Object.values(this.state.sessions);
    const now = Date.now();
    const unfinishedAges = sessions
      .filter((session) => !session.finalized)
      .map((session) => now - Date.parse(session.lastSeenAt))
      .filter((age) => Number.isFinite(age) && age >= 0);
    return {
      activeSessions: sessions.filter((session) => session.active).length,
      knownSessions: sessions.length,
      unfinishedSessions: sessions.filter((session) => !session.finalized).length,
      staleSessions: sessions.filter((session) =>
        !session.finalized && now - Date.parse(session.lastSeenAt) >= this.config.orphanAfterMs
      ).length,
      receivedHooks: this.state.receivedHooks ?? 0,
      duplicateHooks: this.state.duplicateHooks ?? 0,
      ...(this.state.lastHookAt === undefined ? {} : { lastHookAt: this.state.lastHookAt }),
      truncatedSteps: sessions.reduce((total, session) => total + (session.truncatedStepCount ?? 0), 0),
      finalizedSessions: sessions.filter((session) => session.finalized).length,
      finalizedUnits: sessions.reduce((total, session) => total + (session.completedUnitCount ?? 0), 0),
      ...(unfinishedAges.length === 0 ? {} : { oldestUnfinishedAgeMs: Math.max(...unfinishedAges) }),
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
      evaluationUnitVersion: 2,
      completedUnitCount: 0,
      finalized: false,
      active: true,
      lastSeenAt: artifact.receivedAt,
    };
    session = stepFor(session, {
      nodeKind: "observation",
      role: "decision",
      content: "Coding-agent session started",
      artifactId: artifact.id,
    });
    return { key, session, resumed: false, created: true };
  }

  private async ingestInternal(source: HookSource, payloadInput: unknown): Promise<{ readonly artifactId: string }> {
    const payload = object(payloadInput);
    if (payload === undefined) throw new TypeError("hook payload must be a JSON object");
    const artifact = await this.nextArtifact(source, payload);
    const previousArtifactTime = this.state.seenArtifactTimes?.[artifact.id];
    if (
      previousArtifactTime !== undefined &&
      artifact.eventTime - previousArtifactTime <= HOOK_RETRY_WINDOW_MS
    ) {
      this.state = {
        ...this.state,
        duplicateHooks: (this.state.duplicateHooks ?? 0) + 1,
        lastHookAt: artifact.receivedAt,
      };
      await this.stateStore.save(this.state);
      return { artifactId: artifact.id };
    }
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
      if (session.currentUnitStartStepNumber !== undefined && currentUnitSteps(session).length > 0) {
        const abandoned = withoutVerifiedOutcome(session);
        if (await this.enqueueTrajectory(abandoned, artifact, index, "prompt-boundary")) {
          index += 2;
          session = completeCurrentUnit(abandoned);
        }
      }
      const prompt = text(payload.prompt) ?? text(payload.user_prompt) ?? "";
      const explicitTaskKey = text(payload.task_key) ?? text(payload.taskId) ?? text(payload.comparison_key);
      const normalizedPrompt = prompt.trim().toLocaleLowerCase().replace(/\s+/g, " ");
      const comparisonKey = explicitTaskKey !== undefined
        ? `task-${privateDigest(this.privacy, "task-key", explicitTaskKey).slice(0, 24)}`
        : normalizedPrompt.length === 0
          ? undefined
          : `prompt-${privateDigest(this.privacy, "prompt", normalizedPrompt).slice(0, 24)}`;
      const {
        comparisonKey: _comparisonKey,
        taskKey: _taskKey,
        steeringIntentionIds: _steeringIntentionIds,
        currentUnitStartStepNumber: _currentUnitStart,
        ...resetSession
      } = withoutVerifiedOutcome(session);
      session = {
        ...resetSession,
        currentUnitStartStepNumber: resetSession.steps.length + 1,
        ...(comparisonKey === undefined ? {} : { comparisonKey }),
        ...(explicitTaskKey === undefined ? {} : { taskKey: bounded(explicitTaskKey, 500) }),
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
        ? payload.tool_names.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
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
      ])];
      const mutatingTool = /edit|write|patch|notebook/i.test(tool) || repositoryChanged;
      if (success && mutatingTool) session = withoutVerifiedOutcome(session);
      if (success && mutatingTool) {
        const pathPages = pagesOf(paths, 200);
        for (const [pathPage, pagePaths] of pathPages.entries()) {
          session = await this.observe(session, artifact, index++, {
            kind: repositoryChanged ? "repository_changed" : "file_changed",
            data: {
              toolName: tool,
              paths: [...pagePaths],
              pathPage: pathPage + 1,
              pathPageCount: pathPages.length,
              pathCount: paths.length,
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
    } else if (name === "FileChanged") {
      const rawPath = text(payload.file_path);
      session = await this.observe(session, artifact, index++, {
        kind: "file_changed",
        data: {
          artifactId: artifact.id,
          ...(rawPath === undefined ? {} : { paths: [canonicalPath(rawPath, session.project.root)] }),
          ...(text(payload.event) === undefined ? {} : { event: text(payload.event)! }),
        },
      });
      session = withoutVerifiedOutcome(session);
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
    } else if (name === "SteeringApplied") {
      const intentionIds = Array.isArray(payload.intention_ids)
        ? payload.intention_ids
            .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
            .map((value) => bounded(value.trim(), 500))
        : [];
      if (intentionIds.length === 0) throw new TypeError("steering application requires intention_ids");
      session = await this.observe(session, artifact, index++, {
        kind: "steering_applied",
        data: {
          intentionIds,
          artifactId: artifact.id,
          ...(session.currentTurnId === undefined ? {} : { turnId: session.currentTurnId }),
        },
      });
      session = {
        ...stepFor(session, {
          nodeKind: "decision",
          role: "decision",
          content: "Operator steering applied",
          artifactId: artifact.id,
          eventId: session.lastEventId!,
          ...(session.currentTurnId === undefined ? {} : { turnId: session.currentTurnId }),
        }),
        steeringIntentionIds: [...new Set([...(session.steeringIntentionIds ?? []), ...intentionIds])],
      };
    } else if (name === "Stop" || name === "StopFailure") {
      const reasoning = await this.captureExposedReasoning(session, artifact, index);
      session = reasoning.session;
      index = reasoning.nextIndex;
      const failed = name === "StopFailure";
      const assistantMessage = text(payload.last_assistant_message) ?? text(payload.lastAssistantMessage) ?? "";
      session = await this.observe(session, artifact, index++, {
        kind: "task_complete",
        data: {
          artifactId: artifact.id,
          status: failed ? "failure" : "completed",
          ...(text(payload.error_type) === undefined ? {} : { errorType: text(payload.error_type)! }),
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
        content: failed ? `Agent response failed${text(payload.error_type) === undefined ? "" : `: ${text(payload.error_type)!}`}` : "Agent completed a response",
        artifactId: artifact.id,
        eventId: session.lastEventId!,
        ...(session.currentTurnId === undefined ? {} : { turnId: session.currentTurnId }),
      });
      if (failed) {
        session = {
          ...session,
          explicitOutcome: "failure",
          reviewText: `VERDICT: reject\nDETAIL: ${text(payload.error_type) ?? "agent response failed"}`,
        };
      }
      if (await this.enqueueTrajectory(session, artifact, index, "stop")) {
        index += 2;
        session = completeCurrentUnit(session);
      }
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
        if (await this.enqueueTrajectory(session, artifact, index, "session-end")) {
          index += 2;
          session = completeCurrentUnit(session);
        }
        await this.enqueueTranscript(session, artifact);
      }
      session = { ...session, active: false, finalized: true, finalizationReason: "session-end" };
    } else if (name !== "SessionStart") {
      if (name === "PreCompact") {
        const reasoning = await this.captureExposedReasoning(session, artifact, index);
        session = reasoning.session;
        index = reasoning.nextIndex;
      }
      const data: Record<string, JsonValue> = { hookEvent: name, artifactId: artifact.id };
      for (const field of [
        "agent_id", "agent_type", "task_id", "task_subject", "trigger", "reason", "error_type",
        "source", "new_model", "old_model", "permission_mode", "notification_type", "mcp_server_name",
      ]) {
        const value = text(payload[field]);
        if (value !== undefined) data[field] = this.privacy.text(value);
      }
      session = await this.observe(session, artifact, index++, { kind: "harness_event", data });
      const switchedModel = text(payload.new_model);
      if (name === "PostModelSwitch" && switchedModel !== undefined) session = { ...session, model: switchedModel };
    }

    const eventsSinceSnapshot = (session.observedEventCount ?? 0) - (session.lastTreeSnapshotEventCount ?? 0);
    if (
      name !== "SessionEnd" &&
      name !== "Stop" &&
      session.currentUnitStartStepNumber !== undefined &&
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

    session = await this.stepStore.synchronize(session);
    const seenArtifacts = [...this.state.seenArtifacts, artifact.id].slice(-10_000);
    const retainedArtifacts = new Set(seenArtifacts);
    const seenArtifactTimes = Object.fromEntries([
      ...Object.entries(this.state.seenArtifactTimes ?? {}).filter(([id]) => retainedArtifacts.has(id)),
      [artifact.id, artifact.eventTime],
    ]);
    this.state = {
      ...this.state,
      seenArtifacts,
      seenArtifactTimes,
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
    const seen = new Set(session.seenReasoningIds ?? []);
    let next: CaptureSession = session;
    let nextIndex = index;
    while (true) {
      let delta: Awaited<ReturnType<typeof readExposedReasoningDelta>>;
      try {
        delta = await readExposedReasoningDelta(
          session.transcriptPath,
          session.source,
          next.reasoningCursor ?? 0,
          { maxBytes: TRANSCRIPT_DELTA_MAX_BYTES },
        );
      } catch {
        break;
      }
      const previousCursor = next.reasoningCursor ?? 0;
      const fresh = delta.items.filter(({ id }) => !seen.has(id));
      fresh.forEach(({ id }) => seen.add(id));
      next = {
        ...next,
        reasoningCursor: delta.cursor,
        seenReasoningIds: [...seen].slice(-5_000),
      };
      if (delta.records.length === 0) break;
      const summaries = fresh.map((item) => ({
        id: this.privacy.alias("reasoning-record", item.id),
        text: this.privacy.text(item.text),
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
      }, artifact.eventTime + nextIndex);
      if (this.config.reasoningTreePolicy === "summaries") {
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
      }
      if (delta.cursor <= previousCursor) break;
    }
    return { session: next, nextIndex };
  }

  private async backfillCompletedUnits(session: CaptureSession): Promise<CaptureSession> {
    const units = closedEvaluationUnits(session);
    if (units.length === 0) return session;
    const artifacts = await this.vault.sessionArtifacts(session.source, session.sessionId);
    const artifactsById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
    let completedUnitCount = session.completedUnitCount ?? 0;
    let finalizedThroughStepNumber = session.finalizedThroughStepNumber;
    for (const unit of units) {
      const promptArtifact = unit.promptStep?.artifactId === undefined
        ? undefined
        : artifactsById.get(unit.promptStep.artifactId);
      const promptPayload = promptArtifact?.payload;
      const promptText = promptPayload === undefined
        ? undefined
        : text(promptPayload.prompt) ?? text(promptPayload.user_prompt);
      const explicitTaskKey = promptPayload === undefined
        ? undefined
        : text(promptPayload.task_key) ?? text(promptPayload.taskId) ?? text(promptPayload.comparison_key);
      const normalizedPrompt = promptText?.trim().toLocaleLowerCase().replace(/\s+/g, " ");
      const comparisonKey = explicitTaskKey !== undefined
        ? `task-${privateDigest(this.privacy, "task-key", explicitTaskKey).slice(0, 24)}`
        : normalizedPrompt === undefined || normalizedPrompt.length === 0
          ? undefined
          : `prompt-${privateDigest(this.privacy, "prompt", normalizedPrompt).slice(0, 24)}`;
      const steps = session.steps.slice(unit.startStepNumber - 1, unit.endStepNumber);
      const humanDecision = [...steps].reverse()
        .map((step) => step.artifactId === undefined ? undefined : artifactsById.get(step.artifactId)?.payload)
        .find((payload) => payload !== undefined && hookName(payload) === "HumanDecision");
      const explicitOutcome = humanDecision?.verdict === "success" || humanDecision?.verdict === "failure"
        ? humanDecision.verdict
        : undefined;
      const inferredOutcome = unitOutcome(steps);
      const {
        comparisonKey: _comparisonKey,
        taskKey: _taskKey,
        currentUnitStartStepNumber: _currentUnitStart,
        currentUnitEndStepNumber: _currentUnitEnd,
        ...baseSession
      } = withoutVerifiedOutcome(session);
      const scoped: CaptureSession = {
        ...baseSession,
        currentUnitStartStepNumber: unit.startStepNumber,
        currentUnitEndStepNumber: unit.endStepNumber,
        completedUnitCount,
        ...(comparisonKey === undefined ? {} : { comparisonKey }),
        ...(explicitTaskKey === undefined ? {} : { taskKey: bounded(explicitTaskKey, 500) }),
        ...(inferredOutcome === undefined ? {} : { lastVerification: inferredOutcome }),
        ...(explicitOutcome === undefined ? {} : {
          explicitOutcome,
          reviewText: `VERDICT: ${explicitOutcome === "success" ? "approve" : "reject"}`,
        }),
      };
      const storedBoundary = unit.boundaryStep.artifactId === undefined
        ? undefined
        : artifactsById.get(unit.boundaryStep.artifactId);
      const eventTime = eventTimeFromStep(unit.boundaryStep) ?? storedBoundary?.eventTime ?? Date.parse(session.lastSeenAt);
      const safeEventTime = (Number.isFinite(eventTime) ? eventTime : Date.now()) +
        completedUnitCount + 1;
      const artifact: VaultArtifact = {
        id: unit.boundaryStep.artifactId ?? hash(`backfill:${session.source}:${session.sessionId}:${unit.endStepNumber}`),
        eventTime: safeEventTime,
        receivedAt: new Date(safeEventTime).toISOString(),
        path: "",
      };
      if (await this.enqueueTrajectory(scoped, artifact, 0, unit.reason)) {
        completedUnitCount += 1;
        finalizedThroughStepNumber = unit.endStepNumber;
      }
    }
    return {
      ...session,
      evaluationUnitVersion: 2,
      completedUnitCount,
      ...(finalizedThroughStepNumber === undefined ? {} : { finalizedThroughStepNumber }),
    };
  }

  private treeFor(
    session: CaptureSession,
    outcome?: "success" | "failure" | "unknown",
  ): TrajectoryTreeRecord["tree"] {
    const taskId = trajectoryTaskId(session, this.privacy);
    const unitSteps = currentUnitSteps(session);
    const steps = unitSteps.length > 0 ? unitSteps : [{
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
    finalizationReason?: TrajectoryFinalizationReason,
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
      ...((session.recoveredStepCount ?? 0) === 0 ? {} : { recoveredSteps: String(session.recoveredStepCount) }),
      ...((finalizationReason ?? session.finalizationReason) === undefined
        ? {}
        : { finalizationReason: (finalizationReason ?? session.finalizationReason)! }),
      ...(session.comparisonKey === undefined ? {} : { comparison: session.comparisonKey }),
      ...((session.steeringIntentionIds?.length ?? 0) === 0
        ? {}
        : {
            steeringIntentions: session.steeringIntentionIds!
              .map((id) => this.privacy.alias("intention", id))
              .join(","),
          }),
      ...(session.currentUnitStartStepNumber === undefined
        ? {}
        : { unitStartStep: String(session.currentUnitStartStepNumber) }),
      unit: String((session.completedUnitCount ?? 0) + 1),
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

  private async enqueueTranscript(session: CaptureSession, artifact: VaultArtifact): Promise<void> {
    if (
      session.transcriptPath === undefined ||
      (session.source !== "claude-code" && session.source !== "codex")
    ) return;
    let path = session.transcriptPath;
    let ownedSnapshot = false;
    try {
      path = await this.transcriptSnapshots.store(session.source, session.transcriptPath);
      ownedSnapshot = true;
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      const changing = error instanceof Error && error.message.includes("changed while");
      if (!missing && !changing) throw error;
    }
    await this.spool.enqueue({
      version: 1,
      kind: "transcript",
      id: `capture-${artifact.eventTime.toString().padStart(13, "0")}-950-transcript-${artifact.id.slice(0, 12)}`,
      createdAt: artifact.receivedAt,
      notBefore: new Date(artifact.eventTime + (ownedSnapshot ? 0 : 2_000)).toISOString(),
      deadlineAt: new Date(artifact.eventTime + (ownedSnapshot ? 7 * 24 * 60 * 60_000 : 30 * 60_000)).toISOString(),
      source: session.source,
      path,
      ...(ownedSnapshot ? { ownedSnapshot: true as const } : {}),
    });
  }

  private async enqueueTrajectory(
    session: CaptureSession,
    artifact: VaultArtifact,
    index: number,
    finalizationReason?: TrajectoryFinalizationReason,
  ): Promise<boolean> {
    const steps = currentUnitSteps(session);
    if (steps.length === 0) return false;
    const outcome = session.explicitOutcome ?? session.lastVerification ?? "unknown";
    const tree = this.treeFor(session, outcome);
    const taskId = tree.taskId;
    const finalStepId = `step-${steps.length + 1}`;
    const allSteps: TrajectoryInput["steps"] = [
      ...steps.map((step) => traceStep(step, this.privacy)),
      {
        id: finalStepId,
        stepNumber: steps.length + 1,
        role: "model_output",
        content: outcome === "unknown"
          ? `${finalizationReason === "stop" || finalizationReason === "prompt-boundary" ? "Turn" : "Session"} ended without a verified outcome`
          : `Evaluation outcome: ${outcome}`,
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
      id: `trajectory:${session.source}:${this.privacy.alias("session", session.sessionId)}:unit-${(session.completedUnitCount ?? 0) + 1}`,
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
    return true;
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
    let session: CaptureSession = {
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
    if (await this.enqueueTrajectory(session, artifact, index, "orphan-timeout")) {
      session = completeCurrentUnit(session);
    }
    await this.enqueueTranscript(session, artifact);
    this.state = { ...this.state, sessions: { ...this.state.sessions, [key]: session } };
  }
}
