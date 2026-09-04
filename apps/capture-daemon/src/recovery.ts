import type { CapturedStep, StoredHookArtifact } from "./types.js";

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

function hookName(payload: Record<string, unknown>): string {
  return text(payload.hook_event_name) ?? text(payload.event_name) ?? text(payload.event) ?? "Unknown";
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

function pendingToolKey(payload: Record<string, unknown>): string {
  return toolUseId(payload) ?? `${toolName(payload)}:unpaired`;
}

function currentTurnId(payload: Record<string, unknown>): string | undefined {
  return text(payload.turn_id) ?? text(payload.turnId);
}

type StepInput = Omit<CapturedStep, "id" | "stepNumber">;

export function recoverCapturedSteps(artifactsInput: readonly StoredHookArtifact[]): readonly CapturedStep[] {
  const artifacts = [...artifactsInput].sort((left, right) =>
    left.eventTime - right.eventTime || left.id.localeCompare(right.id)
  );
  const steps: StepInput[] = [];
  const pending = new Map<string, { readonly startedAt: string; readonly eventTime: number }>();
  const append = (artifact: StoredHookArtifact, input: Omit<StepInput, "artifactId">) => {
    steps.push({ ...input, artifactId: artifact.id });
  };
  const first = artifacts[0];
  if (first !== undefined) {
    append(first, { nodeKind: "observation", role: "decision", content: "Coding-agent session started" });
  }
  for (const artifact of artifacts) {
    const payload = artifact.payload;
    const name = hookName(payload);
    const turnId = currentTurnId(payload);
    if (name === "UserPromptSubmit") {
      append(artifact, {
        nodeKind: "observation",
        role: "decision",
        content: "User submitted a task prompt",
        ...(turnId === undefined ? {} : { turnId }),
      });
    } else if (name === "PreToolUse") {
      const tool = toolName(payload);
      pending.set(pendingToolKey(payload), { startedAt: artifact.receivedAt, eventTime: artifact.eventTime });
      append(artifact, {
        nodeKind: "action",
        role: "tool_call",
        content: `Invoke ${tool}`,
        toolName: tool,
        startedAt: artifact.receivedAt,
        ...(turnId === undefined ? {} : { turnId }),
      });
    } else if (name === "HermesStep") {
      const tools = Array.isArray(payload.tool_names)
        ? payload.tool_names.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        : [];
      for (const rawTool of tools) {
        const tool = bounded(rawTool.trim(), 200);
        append(artifact, {
          nodeKind: "action",
          role: "tool_call",
          content: `Hermes invoked ${tool}`,
          toolName: tool,
        });
      }
    } else if (name === "PostToolUse" || name === "PostToolUseFailure") {
      const tool = toolName(payload);
      const success = toolSucceeded(name, payload);
      const started = pending.get(pendingToolKey(payload));
      pending.delete(pendingToolKey(payload));
      const timing = started === undefined ? {} : {
        startedAt: started.startedAt,
        durationMs: Math.max(0, artifact.eventTime - started.eventTime),
      };
      append(artifact, {
        nodeKind: "observation",
        role: "tool_call_response",
        content: `${tool} ${success ? "completed" : "failed"}`,
        toolName: tool,
        ...timing,
        ...(turnId === undefined ? {} : { turnId }),
      });
      const verification = verificationKind(payload);
      if (verification !== undefined) {
        append(artifact, {
          nodeKind: "observation",
          role: "tool_call_response",
          content: `${verification} verification ${success ? "passed" : "failed"}`,
          toolName: tool,
          ...timing,
          ...(turnId === undefined ? {} : { turnId }),
        });
      }
    } else if (name === "PermissionRequest" || name === "Notification") {
      append(artifact, {
        nodeKind: "observation",
        role: "decision",
        content: "Agent requested operator attention",
        ...(turnId === undefined ? {} : { turnId }),
      });
    } else if (name === "ReasoningCheckpoint") {
      const summary = text(payload.summary);
      if (summary !== undefined) {
        append(artifact, {
          nodeKind: "decision",
          role: "model_thought",
          content: bounded(summary, 2_000),
          ...(turnId === undefined ? {} : { turnId }),
        });
      }
    } else if (name === "HumanDecision") {
      const summary = text(payload.summary);
      if (summary !== undefined) {
        append(artifact, {
          nodeKind: "decision",
          role: "decision",
          content: bounded(summary, 2_000),
          ...(turnId === undefined ? {} : { turnId }),
        });
      }
    } else if (name === "SteeringApplied") {
      append(artifact, {
        nodeKind: "decision",
        role: "decision",
        content: "Operator steering applied",
        ...(turnId === undefined ? {} : { turnId }),
      });
    } else if (name === "Stop") {
      append(artifact, {
        nodeKind: "observation",
        role: "model_output",
        content: "Agent completed a response",
        ...(turnId === undefined ? {} : { turnId }),
      });
    } else if (name === "TranscriptDelta" && Array.isArray(payload.summaries)) {
      for (const summaryInput of payload.summaries) {
        const summary = text(object(summaryInput)?.text);
        if (summary !== undefined) {
          append(artifact, {
            nodeKind: "decision",
            role: "model_thought",
            content: bounded(summary, 2_000),
            ...(turnId === undefined ? {} : { turnId }),
          });
        }
      }
    }
  }
  return steps.map((step, index) => ({ ...step, id: `step-${index + 1}`, stepNumber: index + 1 }));
}

function recoveryKey(step: CapturedStep): string {
  if (step.content === "Coding-agent session started" && step.role === "decision") return "session-start";
  return JSON.stringify([
    step.artifactId ?? "",
    step.nodeKind,
    step.role,
    step.toolName ?? "",
    step.content,
  ]);
}

export function mergeRecoveredSteps(
  existing: readonly CapturedStep[],
  recovered: readonly CapturedStep[],
): { readonly steps: readonly CapturedStep[]; readonly recoveredCount: number } {
  const available = new Map<string, CapturedStep[]>();
  for (const step of existing) {
    const key = recoveryKey(step);
    available.set(key, [...(available.get(key) ?? []), step]);
  }
  const used = new Set<CapturedStep>();
  const merged = recovered.map((candidate) => {
    const match = available.get(recoveryKey(candidate))?.find((step) => !used.has(step));
    if (match === undefined) return candidate;
    used.add(match);
    return match;
  });
  for (const step of existing) {
    if (!used.has(step)) merged.push(step);
  }
  return {
    steps: merged.map((step, index) => ({ ...step, id: `step-${index + 1}`, stepNumber: index + 1 })),
    recoveredCount: Math.max(0, merged.length - existing.length),
  };
}
