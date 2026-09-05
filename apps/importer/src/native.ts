import type { TranscriptSource, TranscriptTurn } from "@_89/fold-transcript";
import { arrayValue, isoTimestamp, recordValue, stringValue } from "./json.js";

export type EvidenceResult = "success" | "failure" | "unknown";

/** Only source-provided flags/exit codes establish execution success. */
export function explicitToolResult(value: unknown): EvidenceResult {
  let record = recordValue(value);
  if (record === undefined && typeof value === "string") {
    try { record = recordValue(JSON.parse(value)); } catch { /* Native output may be plain text. */ }
    if (record === undefined) {
      const code = value.match(/(?:^|\n)(?:Process exited with code|Exit code:)\s*(-?\d+)\s*(?:\n|$)/i)?.[1];
      if (code !== undefined) return Number(code) === 0 ? "success" : "failure";
      return "unknown";
    }
  }
  if (record === undefined) return "unknown";
  const code = record.exit_code ?? record.exitCode;
  if (record.is_error === true || record.success === false || (typeof code === "number" && Number.isFinite(code) && code !== 0)) return "failure";
  if (record.is_error === false || record.success === true || code === 0) return "success";
  return "unknown";
}

export interface NativeMessage {
  readonly role: TranscriptTurn["roles"][number];
  readonly text: string;
  readonly nativeId?: string;
}
export interface NativeAction {
  readonly kind: "call" | "result";
  readonly nativeId?: string;
  readonly name?: string;
  readonly text?: string;
  readonly result?: EvidenceResult;
}
export interface NativeRecord {
  readonly at?: string;
  readonly cwd?: string;
  readonly branch?: string;
  readonly remote?: string;
  readonly clientVersion?: string;
  readonly model?: string;
  readonly startsTurn?: true;
  readonly nativeTurnId?: string;
  readonly messages: readonly NativeMessage[];
  readonly actions: readonly NativeAction[];
  readonly unknown: boolean;
}

export function nativeTextContent(value: unknown): string {
  if (typeof value === "string") return value;
  return arrayValue(value).flatMap((item) => {
    const block = recordValue(item);
    if (block?.type !== "text" && block?.type !== "input_text" && block?.type !== "output_text") return [];
    return stringValue(block.text) ?? [];
  }).join("\n");
}

function role(value: unknown): NativeMessage["role"] {
  return value === "user" || value === "assistant" || value === "developer" || value === "system" || value === "tool" ? value : "other";
}

/** Pure source adapter. Private text is only returned to local consumers, never embedded in metadata. */
export function normalizeNativeRecord(source: TranscriptSource, record: Record<string, unknown>): NativeRecord {
  const at = isoTimestamp(record.timestamp);
  const type = stringValue(record.type);
  const messages: NativeMessage[] = [];
  const actions: NativeAction[] = [];
  const common = { ...(at === undefined ? {} : { at }), messages, actions };
  const optional = (key: string, value: unknown) => stringValue(value) === undefined ? {} : { [key]: stringValue(value)! };
  if (source === "claude-code") {
    const message = recordValue(record.message);
    const blocks = arrayValue(message?.content).map(recordValue).filter((value) => value !== undefined);
    const hasResults = blocks.some((block) => block.type === "tool_result");
    if (type === "user") {
      if (record.isMeta !== true || hasResults) messages.push({
        role: hasResults ? "tool" : "user", text: nativeTextContent(message?.content), ...optional("nativeId", record.uuid),
      });
      for (const block of blocks) if (block.type === "tool_result") actions.push({
        kind: "result", ...optional("nativeId", block.tool_use_id), ...optional("name", block.tool_use_id),
        text: nativeTextContent(block.content), result: explicitToolResult(block),
      });
    } else if (type === "assistant") {
      if (typeof message?.content === "string" || blocks.some((block) => block.type !== "thinking")) messages.push({
        role: "assistant", text: nativeTextContent(message?.content), ...optional("nativeId", message?.id),
      });
      for (const block of blocks) if (block.type === "tool_use") actions.push({
        kind: "call", ...optional("name", block.name), ...optional("nativeId", block.id),
      });
    }
    return {
      ...common, ...optional("cwd", record.cwd), ...optional("branch", record.gitBranch),
      ...optional("clientVersion", record.version), ...optional("model", message?.model),
      ...(type === "user" && record.isMeta !== true && !hasResults ? { startsTurn: true as const,
        ...optional("nativeTurnId", record.promptId ?? record.uuid) } : {}),
      unknown: !new Set(["assistant", "attachment", "file-history-snapshot", "last-prompt", "progress", "queue-operation", "summary", "system", "tool-use-summary", "user"]).has(type ?? ""),
    };
  }
  const payload = recordValue(record.payload);
  const payloadType = stringValue(payload?.type);
  const git = recordValue(payload?.git);
  if (type === "response_item") {
    if (payloadType === "message") messages.push({ role: role(payload?.role), text: nativeTextContent(payload?.content), ...optional("nativeId", payload?.id) });
    else if (payloadType === "function_call" || payloadType === "custom_tool_call") actions.push({ kind: "call", ...optional("name", payload?.name), ...optional("nativeId", payload?.call_id) });
    else if (payloadType === "function_call_output" || payloadType === "custom_tool_call_output") actions.push({
      kind: "result", ...optional("nativeId", payload?.call_id), ...optional("name", payload?.call_id),
      text: typeof payload?.output === "string" ? payload.output : JSON.stringify(payload?.output ?? ""),
      result: explicitToolResult(payload?.output),
    });
  }
  return {
    ...common,
    ...(type === "session_meta" ? { ...optional("cwd", payload?.cwd), ...optional("branch", git?.branch), ...optional("remote", git?.repository_url), ...optional("clientVersion", payload?.cli_version) } : {}),
    ...(type === "turn_context" ? { ...optional("cwd", payload?.cwd), ...optional("branch", payload?.git_branch), ...optional("model", payload?.model) } : {}),
    ...(type === "turn_context" || (type === "event_msg" && payloadType === "task_started") ? { startsTurn: true as const, ...optional("nativeTurnId", payload?.turn_id) } : {}),
    unknown: type === "response_item" ? !["message", "function_call", "custom_tool_call", "function_call_output", "custom_tool_call_output", "reasoning"].includes(payloadType ?? "")
      : !["session_meta", "turn_context", "event_msg", "world_state", "compacted"].includes(type ?? ""),
  };
}

export interface NativeTurnIdentity {
  readonly id: string;
  readonly ordinal: number;
  readonly nativeId?: string;
}
export interface NormalizedNativeRecord extends NativeRecord {
  readonly turn?: NativeTurnIdentity;
}

/** Allocates identity before text filtering, including tool-only and boilerplate turns. */
export class NativeTranscriptNormalizer {
  private readonly turns = new Map<string, NativeTurnIdentity>();
  private current?: NativeTurnIdentity;
  private count = 0;
  constructor(readonly source: TranscriptSource, readonly nativeId: string, readonly options: { readonly parserVersion?: "1" | "2" } = {}) {}
  push(record: Record<string, unknown>): NormalizedNativeRecord {
    const normalized = normalizeNativeRecord(this.source, record);
    // v1 metadata ignored string-only Claude assistant messages; do not manufacture a new turn for historical citations.
    const value = this.options.parserVersion === "1" && this.source === "claude-code" && record.type === "assistant" &&
      typeof recordValue(record.message)?.content === "string" ? { ...normalized, messages: [] } : normalized;
    if (value.startsTurn === true || (this.current === undefined && (value.messages.length > 0 || value.actions.length > 0))) {
      const known = value.nativeTurnId === undefined ? undefined : this.turns.get(value.nativeTurnId);
      if (known !== undefined) this.current = known;
      else {
        const ordinal = this.count++;
        this.current = { id: `${this.source}:${this.nativeId}:turn:${ordinal}`, ordinal, ...(value.nativeTurnId === undefined ? {} : { nativeId: value.nativeTurnId }) };
        if (value.nativeTurnId !== undefined) this.turns.set(value.nativeTurnId, this.current);
      }
    }
    return { ...value, ...(this.current === undefined ? {} : { turn: this.current }) };
  }
}
