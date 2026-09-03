import type { CaptureEnvelope, JsonValue } from "@_89/fold";

export type TerminalState =
  | "unknown"
  | "busy_streaming"
  | "awaiting_input"
  | "awaiting_auth"
  | "awaiting_approval"
  | "ready_for_input"
  | "completed";

export interface TerminalStateRule {
  readonly id: string;
  readonly state: TerminalState;
  readonly pattern: RegExp;
  readonly priority?: number;
  readonly source?: string;
}

export interface TerminalClassification {
  readonly state: TerminalState;
  readonly confidence: number;
  readonly ruleId?: string;
}

export interface TerminalStateTransition {
  readonly from: TerminalState;
  readonly to: TerminalState;
  readonly ruleId?: string;
}

export interface TerminalFeedResult {
  readonly normalizedChunk: string;
  readonly normalizedTail: string;
  readonly classification: TerminalClassification;
  readonly changed: boolean;
  readonly transition?: TerminalStateTransition;
}

export interface TerminalOutputRun {
  readonly text: string;
  readonly count: number;
}

export interface TerminalOutputDigest {
  readonly normalizedText: string;
  readonly runs: readonly TerminalOutputRun[];
  readonly sampleCount: number;
  readonly sourceCharacters: number;
}

export interface TerminalCaptureIdentity extends Readonly<Record<string, string>> {
  readonly agent: string;
  readonly task: string;
  readonly repo: string;
  readonly branch: string;
  readonly session: string;
}

export type TerminalCaptureEnvelope = Omit<CaptureEnvelope, "identity"> & {
  readonly identity: TerminalCaptureIdentity;
};

export interface TerminalSensorContext {
  readonly sensor: string;
  readonly sessionId: string;
  readonly capture: TerminalCaptureEnvelope;
  readonly heartbeatWindowMs: number;
}

export interface ActivityEventStamp {
  readonly id: string;
  readonly t: number;
  readonly observedAt: string;
}

export type TerminalObservationKind =
  | "status_changed"
  | "prompt_submitted"
  | "login_required"
  | "auth_required"
  | "blocking_prompt"
  | "stall_detected"
  | "tool_running"
  | "tool_result"
  | "file_changed"
  | "repository_changed"
  | "verification_result"
  | "reasoning_checkpoint"
  | "human_decision"
  | "task_complete"
  | "output";

export interface TerminalObservation {
  readonly kind: TerminalObservationKind;
  readonly data?: Readonly<Record<string, JsonValue>>;
  readonly output?: string;
}

export type TerminalManagerSignal =
  | { readonly type: "session_started" }
  | { readonly type: "session_ready" }
  | { readonly type: "session_stopped"; readonly reason?: string }
  | { readonly type: "session_error"; readonly error: string }
  | { readonly type: "session_status_changed"; readonly status: string }
  | { readonly type: "login_required"; readonly instructions?: string; readonly url?: string }
  | {
      readonly type: "auth_required";
      readonly method: string;
      readonly instructions?: string;
      readonly url?: string;
    }
  | {
      readonly type: "blocking_prompt";
      readonly promptType: string;
      readonly prompt?: string;
      readonly autoResponded: boolean;
    }
  | {
      readonly type: "stall_detected";
      readonly recentOutput: string;
      readonly stallDurationMs: number;
    }
  | { readonly type: "task_complete"; readonly output?: string }
  | { readonly type: "tool_running"; readonly toolName: string }
  | { readonly type: "output"; readonly output: string }
  | { readonly type: "heartbeat" }
  | { readonly type: "sensor_degraded"; readonly detail?: string };
