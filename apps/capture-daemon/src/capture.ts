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

import { resolveProject } from "./project.js";
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
  if (session.steps.length >= 2_000) return session;
  const stepNumber = session.steps.length + 1;
  return {
    ...session,
    steps: [...session.steps, { ...input, id: `step-${stepNumber}`, stepNumber }],
  };
}

function traceStep(step: CapturedStep): TrajectoryInput["steps"][number] {
  return {
    id: step.id,
    stepNumber: step.stepNumber,
    role: step.role,
    content: step.content,
    ...(step.toolName === undefined ? {} : { toolName: step.toolName }),
  };
}

export class CaptureEngine {
  private state: CaptureState = { version: 1, lastEventTime: -1, seenArtifacts: [], sessions: {} };
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    readonly config: CaptureConfig,
    readonly stateStore: StateStore,
    readonly vault: HookVault,
    readonly spool: DurableSpool,
  ) {}

  async initialize(): Promise<void> {
    this.state = await this.stateStore.load();
    await this.spool.initialize();
  }

  snapshot(): { readonly activeSessions: number; readonly knownSessions: number } {
    const sessions = Object.values(this.state.sessions);
    return { activeSessions: sessions.filter((session) => session.active).length, knownSessions: sessions.length };
  }

  ingest(source: HookSource, payloadInput: unknown): Promise<{ readonly artifactId: string }> {
    const operation = this.chain.then(() => this.ingestInternal(source, payloadInput));
    this.chain = operation.catch(() => undefined);
    return operation;
  }

  heartbeat(): Promise<void> {
    const operation = this.chain.then(() => this.heartbeatInternal());
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
    return {
      sensor: this.config.sensorId,
      sessionId: session.sessionId,
      heartbeatWindowMs: this.config.heartbeatWindowMs,
      capture: {
        scope: { workspace: this.config.workspaceId },
        identity: {
          agent: session.agent,
          task: `capture-session:${session.source}:${session.sessionId}`,
          repo: session.project.id,
          branch: session.project.branch,
          session: session.sessionId,
          runtime: session.source,
          project: session.project.name,
          ...(session.comparisonKey === undefined ? {} : { comparison: session.comparisonKey }),
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
  ): Promise<void> {
    await this.enqueueEvent(makeTerminalObservationEvent(this.context(session), stamp(artifact, index, "observation"), observation));
  }

  private async ensureSession(
    source: HookSource,
    payload: Record<string, unknown>,
    artifact: VaultArtifact,
  ): Promise<{ readonly key: string; readonly session: CaptureSession; readonly resumed: boolean }> {
    const sessionId = nativeSessionId(payload);
    if (sessionId === undefined) throw new TypeError("hook payload requires session_id");
    const key = sessionKey(source, sessionId);
    const existing = this.state.sessions[key];
    const observedTranscriptPath = transcriptPath(payload);
    const observedModel = text(payload.model);
    if (existing !== undefined) {
      const resumed = !existing.active && !existing.finalized;
      return {
        key,
        resumed,
        session: {
          ...existing,
          active: !existing.finalized,
          lastSeenAt: artifact.receivedAt,
          ...(observedTranscriptPath === undefined ? {} : { transcriptPath: observedTranscriptPath }),
          ...(observedModel === undefined ? {} : { model: observedModel }),
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
    return { key, session, resumed: false };
  }

  private async ingestInternal(source: HookSource, payloadInput: unknown): Promise<{ readonly artifactId: string }> {
    const payload = object(payloadInput);
    if (payload === undefined) throw new TypeError("hook payload must be a JSON object");
    const artifact = await this.nextArtifact(source, payload);
    const ensured = await this.ensureSession(source, payload, artifact);
    let session = ensured.session;
    let index = 0;
    if (ensured.resumed || hookName(payload) === "SessionStart") {
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
      const comparisonKey = prompt.length === 0 ? undefined : `prompt-${hash(prompt.trim()).slice(0, 24)}`;
      session = {
        ...session,
        ...(session.comparisonKey !== undefined || comparisonKey === undefined ? {} : { comparisonKey }),
      };
      await this.observe(session, artifact, index++, {
        kind: "prompt_submitted",
        data: {
          artifactId: artifact.id,
          characters: prompt.length,
          ...(comparisonKey === undefined ? {} : { comparisonKey }),
        },
      });
      session = stepFor(session, {
        nodeKind: "observation",
        role: "decision",
        content: "User submitted a task prompt",
      });
    } else if (name === "PreToolUse") {
      const tool = toolName(payload);
      const verification = verificationKind(payload);
      await this.observe(session, artifact, index++, {
        kind: "tool_running",
        data: {
          toolName: tool,
          ...(toolUseId(payload) === undefined ? {} : { toolUseId: toolUseId(payload)! }),
          ...(verification === undefined ? {} : { category: verification }),
        },
      });
      session = stepFor(session, {
        nodeKind: "action",
        role: "tool_call",
        content: `Invoke ${tool}`,
        toolName: tool,
      });
    } else if (name === "PostToolUse" || name === "PostToolUseFailure") {
      const tool = toolName(payload);
      const success = toolSucceeded(name, payload);
      const verification = verificationKind(payload);
      await this.observe(session, artifact, index++, {
        kind: "tool_result",
        data: {
          toolName: tool,
          status: success ? "completed" : "failed",
          ...(toolUseId(payload) === undefined ? {} : { toolUseId: toolUseId(payload)! }),
        },
      });
      session = stepFor(session, {
        nodeKind: "observation",
        role: "tool_call_response",
        content: `${tool} ${success ? "completed" : "failed"}`,
        toolName: tool,
      });
      const paths = changedPaths(payload, session.project.root);
      if (paths.length > 0 && /edit|write|patch|notebook/i.test(tool)) {
        await this.observe(session, artifact, index++, {
          kind: "file_changed",
          data: { toolName: tool, paths },
        });
      }
      if (verification !== undefined) {
        await this.observe(session, artifact, index++, {
          kind: "verification_result",
          data: { category: verification, status: success ? "success" : "failure", toolName: tool },
        });
        session = {
          ...stepFor(session, {
            nodeKind: "observation",
            role: "tool_call_response",
            content: `${verification} verification ${success ? "passed" : "failed"}`,
            toolName: tool,
          }),
          lastVerification: success ? "success" : "failure",
        };
      }
    } else if (name === "PermissionRequest" || name === "Notification") {
      await this.observe(session, artifact, index++, {
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
      await this.observe(session, artifact, index++, { kind: "reasoning_checkpoint", data });
      session = stepFor(session, {
        nodeKind: "decision",
        role: "model_thought",
        content: bounded(summary, 2_000),
      });
    } else if (name === "HumanDecision") {
      const summary = text(payload.summary);
      const verdict = payload.verdict === "success" || payload.verdict === "failure" ? payload.verdict : undefined;
      if (summary === undefined) throw new TypeError("human decision requires summary");
      await this.observe(session, artifact, index++, {
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
        }),
        ...(verdict === undefined ? {} : {
          explicitOutcome: verdict,
          reviewText: `VERDICT: ${verdict === "success" ? "approve" : "reject"}${confidence === undefined ? "" : `\nCONFIDENCE: ${confidence}`}`,
        }),
      };
    } else if (name === "Stop") {
      await this.observe(session, artifact, index++, {
        kind: "task_complete",
        data: { artifactId: artifact.id },
      });
      session = stepFor(session, {
        nodeKind: "observation",
        role: "model_output",
        content: "Agent completed a response",
      });
    } else if (name === "SessionEnd") {
      await this.enqueueEvent(makeSensorLifecycleEvent(
        this.context(session),
        stamp(artifact, index++, "lifecycle"),
        "offline",
        text(payload.reason) === undefined ? undefined : bounded(text(payload.reason)!, 500),
      ));
      if (!session.finalized) {
        await this.enqueueTrajectory(session, artifact, index);
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
      session = { ...session, active: false, finalized: true };
    }

    this.state = {
      ...this.state,
      seenArtifacts: [...this.state.seenArtifacts, artifact.id].slice(-10_000),
      sessions: { ...this.state.sessions, [ensured.key]: session },
    };
    await this.stateStore.save(this.state);
    return { artifactId: artifact.id };
  }

  private async enqueueTrajectory(session: CaptureSession, artifact: VaultArtifact, index: number): Promise<void> {
    const taskId = `capture-session:${session.source}:${session.sessionId}`;
    const steps = session.steps.length > 0 ? session.steps : [{
      id: "step-1",
      stepNumber: 1,
      nodeKind: "observation" as const,
      role: "decision" as const,
      content: "Coding-agent session observed",
    }];
    const outcome = session.explicitOutcome ?? session.lastVerification ?? "unknown";
    const finalStepId = `step-${steps.length + 1}`;
    const finalNodeId = `node-${steps.length + 1}`;
    const allSteps: TrajectoryInput["steps"] = [
      ...steps.map(traceStep),
      {
        id: finalStepId,
        stepNumber: steps.length + 1,
        role: "model_output",
        content: outcome === "unknown" ? "Session ended without a verified outcome" : `Session outcome: ${outcome}`,
      },
    ];
    const nodes: TrajectoryTreeRecord["tree"]["nodes"] = [
      ...steps.map((step, stepIndex) => ({
        id: `node-${stepIndex + 1}`,
        kind: step.nodeKind,
        label: bounded(step.content),
      })),
      {
        id: finalNodeId,
        kind: "outcome",
        label: outcome === "unknown" ? "Outcome not verified" : `Outcome ${outcome}`,
      },
    ];
    const tree: TrajectoryTreeRecord["tree"] = {
      taskId,
      rootNodeId: "node-1",
      nodes,
      edges: nodes.slice(1).map((node, edgeIndex) => ({
        id: `edge-${edgeIndex + 1}`,
        sourceId: nodes[edgeIndex]!.id,
        targetId: node.id,
        label: "next observed step",
      })),
    };
    const assignments: TrajectoryInput["assignments"] = Object.fromEntries(
      allSteps.map((step, stepIndex) => [step.id, {
        kind: "mapped" as const,
        nodeId: `node-${stepIndex + 1}`,
        method: { kind: "rule" as const, id: "super-brain-capture/v1", confidence: 1 },
      }]),
    );
    const input: TrajectoryInput = {
      id: `trajectory:${session.source}:${session.sessionId}`,
      taskId,
      model: {
        id: session.model ?? session.agent,
      },
      outcome,
      steps: allSteps,
      assignments,
      ...(session.reviewText === undefined ? {} : { reviewText: session.reviewText }),
    };
    const captureIdentity = {
      agent: session.agent,
      session: session.sessionId,
      repo: session.project.id,
      branch: session.project.branch,
      runtime: session.source,
      project: session.project.name,
      ...(session.comparisonKey === undefined ? {} : { comparison: session.comparisonKey }),
    };
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

  private async heartbeatInternal(): Promise<void> {
    for (const [key, session] of Object.entries(this.state.sessions)) {
      if (!session.active || session.finalized) continue;
      const eventTime = Math.max(Date.now(), this.state.lastEventTime + 1);
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
}
