import { explicitToolResult, type EvidenceResult } from "@_89/super-brain-importer";
import type { HookAuthority, ProjectIdentity, TaskAcceptanceEvidence } from "./types.js";

const object = (value: unknown): Record<string, unknown> | undefined => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const text = (value: unknown): string | undefined => typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

export interface NormalizedHookEvidence {
  readonly name: string;
  readonly tool: string;
  readonly toolUseId?: string;
  readonly turnId?: string;
  readonly toolInput: Record<string, unknown>;
  readonly command: string;
  readonly result: EvidenceResult;
  readonly verification?: "test" | "build" | "lint" | "typecheck";
  readonly resultLabel: "completed" | "failed" | "result unknown";
  readonly verificationLabel: "passed" | "failed" | "unknown";
}

/** Shared live/recovery interpretation. Missing output is never evidence of success. */
export function normalizeHookEvidence(payload: Record<string, unknown>): NormalizedHookEvidence {
  const name = text(payload.hook_event_name) ?? text(payload.event_name) ?? text(payload.event) ?? "Unknown";
  const tool = (text(payload.tool_name) ?? text(payload.toolName) ?? "unknown-tool").slice(0, 200);
  const toolUseId = text(payload.tool_use_id) ?? text(payload.toolUseId) ?? text(payload.call_id);
  const turnId = text(payload.turn_id) ?? text(payload.turnId);
  const toolInput = object(payload.tool_input) ?? object(payload.toolInput) ?? object(payload.input) ?? {};
  const command = text(toolInput.command) ?? text(toolInput.cmd) ?? "";
  const candidate = `${tool} ${command}`.toLowerCase();
  const verification = /\b(typecheck|tsc\b)/.test(candidate) ? "typecheck"
    : /\b(lint|eslint|ruff|clippy)\b/.test(candidate) ? "lint"
    : /\b(build|compile|cargo check)\b/.test(candidate) ? "build"
    : /\b(test|vitest|jest|pytest|go test|cargo test|rspec)\b/.test(candidate) ? "test" : undefined;
  const results = [explicitToolResult(payload), explicitToolResult(payload.tool_response ?? payload.toolResponse ?? payload.result)];
  const result = name === "PostToolUseFailure" || results.includes("failure") ? "failure"
    : results.includes("success") ? "success" : "unknown";
  return {
    name, tool, toolInput, command, result,
    ...(toolUseId === undefined ? {} : { toolUseId }), ...(turnId === undefined ? {} : { turnId }),
    ...(verification === undefined ? {} : { verification }),
    resultLabel: result === "success" ? "completed" : result === "failure" ? "failed" : "result unknown",
    verificationLabel: result === "success" ? "passed" : result === "failure" ? "failed" : "unknown",
  };
}

export function repositoryRevisionId(project: ProjectIdentity): string | undefined {
  return project.fingerprintStatus === "unavailable" || project.head === undefined || project.worktreeDigest === undefined ? undefined
    : `git:${project.head}:worktree:${project.worktreeDigest}`;
}

/** Authority is supplied by the trusted ingress, never read from a caller-selected payload field. */
export function normalizeTaskAcceptance(
  input: unknown,
  authority: HookAuthority | undefined,
  expected: { readonly taskId: string; readonly attemptId: string; readonly revisionId?: string; readonly artifactId: string },
): TaskAcceptanceEvidence | undefined {
  const value = object(input);
  if (value === undefined || authority === undefined) return undefined;
  if (value.version !== 1 || (value.verdict !== "success" && value.verdict !== "failure")) throw new TypeError("acceptance requires version 1 and an explicit verdict");
  if (value.taskId !== expected.taskId || value.attemptId !== expected.attemptId || expected.revisionId === undefined || value.revisionId !== expected.revisionId) {
    throw new TypeError("acceptance must reference the active task, attempt and current repository revision");
  }
  return { version: 1, taskId: expected.taskId, attemptId: expected.attemptId, revisionId: expected.revisionId,
    verdict: value.verdict, artifactId: expected.artifactId, authority };
}
