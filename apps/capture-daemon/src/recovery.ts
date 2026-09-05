import { normalizeHookEvidence } from "./evidence.js";
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

function pendingToolKey(payload: Record<string, unknown>): string {
  const evidence = normalizeHookEvidence(payload);
  return evidence.toolUseId ?? `${evidence.tool}:unpaired`;
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
  let lastTurnId: string | undefined;
  for (const artifact of artifacts) {
    const payload = artifact.payload;
    const evidence = normalizeHookEvidence(payload);
    const name = evidence.name;
    lastTurnId = evidence.turnId ?? lastTurnId;
    const turnId = lastTurnId;
    if (name === "UserPromptSubmit") {
      append(artifact, {
        nodeKind: "observation",
        role: "decision",
        content: "User submitted a task prompt",
        ...(turnId === undefined ? {} : { turnId }),
      });
    } else if (name === "PreToolUse") {
      const tool = evidence.tool;
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
      const tool = evidence.tool;
      const started = pending.get(pendingToolKey(payload));
      pending.delete(pendingToolKey(payload));
      const timing = started === undefined ? {} : {
        startedAt: started.startedAt,
        durationMs: Math.max(0, artifact.eventTime - started.eventTime),
      };
      append(artifact, {
        nodeKind: "observation",
        role: "tool_call_response",
        content: `${tool} ${evidence.resultLabel}`,
        toolName: tool,
        ...timing,
        ...(turnId === undefined ? {} : { turnId }),
      });
      const verification = evidence.verification;
      if (verification !== undefined) {
        append(artifact, {
          nodeKind: "observation",
          role: "tool_call_response",
          content: `${verification} verification ${evidence.verificationLabel}`,
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
    } else if (name === "Stop" || name === "StopFailure") {
      append(artifact, {
        nodeKind: "observation",
        role: "model_output",
        content: name === "StopFailure" ? `Agent response failed${text(payload.error_type) === undefined ? "" : `: ${text(payload.error_type)!}`}` : "Agent completed a response",
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
    step.role === "tool_call_response" ? step.content.match(/^(test|build|lint|typecheck) verification /)?.[1] ?? "tool-result" : step.content,
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
    return { ...match, content: candidate.content };
  });
  for (const step of existing) {
    if (!used.has(step)) merged.push(step);
  }
  return {
    steps: merged.map((step, index) => ({ ...step, id: `step-${index + 1}`, stepNumber: index + 1 })),
    recoveredCount: Math.max(0, merged.length - existing.length),
  };
}
