import type { AttemptContext, TraceRuntimeObservation } from "@_89/fold-trajectory";
import { redactJsonValue } from "@_89/super-brain-importer";
import type { HookSource } from "./types.js";

const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const text = (value: unknown): string | undefined => typeof value === "string" && value.trim().length > 0 && value.length <= 500 ? value.trim() : undefined;
const count = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const amount = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

/** Allowlisted, explicitly reported values. Harness identity never supplies a missing model name. */
export function captureRuntimeObservation(source: HookSource, raw: Record<string, unknown>): TraceRuntimeObservation {
  const payload = redactJsonValue(raw).value as Record<string, unknown>;
  const reported = object(payload.runtime) ?? {};
  const model = object(payload.model);
  const settingsInput = object(reported.settings) ?? object(payload.settings) ?? {};
  const usageInput = object(reported.usage) ?? object(payload.usage) ?? object(object(payload.message)?.usage) ?? {};
  const providerId = text(reported.providerId) ?? text(payload.provider_id) ?? text(payload.provider);
  const modelId = text(reported.modelId) ?? text(payload.model) ?? text(model?.id);
  const modelVersion = text(reported.modelVersion) ?? text(payload.model_version) ?? text(model?.version);
  const harnessVersion = text(payload.client_version) ?? text(payload.clientVersion) ?? text(payload.harness_version);
  const configurationId = text(reported.configurationId) ?? text(payload.configuration_id);
  const permissionMode = text(reported.permissionMode) ?? text(payload.permission_mode) ?? text(payload.permissionMode);
  const settings = {
    ...(amount(settingsInput.temperature) === undefined || amount(settingsInput.temperature)! > 2 ? {} : { temperature: amount(settingsInput.temperature)! }),
    ...(amount(settingsInput.topP ?? settingsInput.top_p) === undefined || amount(settingsInput.topP ?? settingsInput.top_p)! > 1 ? {} : { topP: amount(settingsInput.topP ?? settingsInput.top_p)! }),
    ...(count(settingsInput.maxOutputTokens ?? settingsInput.max_output_tokens) === undefined ? {} : { maxOutputTokens: count(settingsInput.maxOutputTokens ?? settingsInput.max_output_tokens)! }),
    ...(text(settingsInput.reasoningEffort ?? settingsInput.reasoning_effort) === undefined ? {} : { reasoningEffort: text(settingsInput.reasoningEffort ?? settingsInput.reasoning_effort)! }),
  };
  const usage: Record<string, number | { amount: number; currency: string }> = {};
  for (const [field, aliases] of Object.entries({ inputTokens: ["inputTokens", "input_tokens"], outputTokens: ["outputTokens", "output_tokens"], cachedInputTokens: ["cachedInputTokens", "cache_read_input_tokens", "cached_input_tokens"], reasoningTokens: ["reasoningTokens", "reasoning_tokens"] })) {
    const value = aliases.map((key) => count(usageInput[key])).find((item) => item !== undefined);
    if (value !== undefined) usage[field] = value;
  }
  const durationMs = amount(usageInput.durationMs ?? usageInput.duration_ms ?? payload.duration_ms);
  if (durationMs !== undefined) usage.durationMs = durationMs;
  const cost = object(usageInput.cost);
  if (amount(cost?.amount) !== undefined && typeof cost?.currency === "string" && /^[A-Z]{3}$/.test(cost.currency)) usage.cost = { amount: amount(cost.amount)!, currency: cost.currency };
  const toolsInput = reported.tools ?? payload.tools;
  const tools = Array.isArray(toolsInput) ? toolsInput.slice(0, 100).flatMap((item) => {
    const tool = object(item); const name = text(tool?.name) ?? text(item); const version = text(tool?.version);
    return name === undefined ? [] : [{ name, ...(version === undefined ? {} : { version }) }];
  }) : undefined;
  return { provenance: "hook-reported", ...(source === "unknown" ? {} : { harness: { id: source, ...(harnessVersion === undefined ? {} : { version: harnessVersion }) } }),
    ...(providerId === undefined ? {} : { providerId }), ...(modelId === undefined ? {} : { modelId }), ...(modelVersion === undefined ? {} : { modelVersion }),
    ...(configurationId === undefined ? {} : { configurationId }), ...(permissionMode === undefined ? {} : { permissionMode }),
    ...(Object.keys(settings).length === 0 ? {} : { settings }), ...(Object.keys(usage).length === 0 ? {} : { usage, usageInterpretation: "unknown" as const, usageScope: "unknown" as const }), ...(tools === undefined ? {} : { tools }) };
}

/** References mean offered/injected context, not proof that a model used it. Exact IDs are not re-aliased. */
export function captureAttemptContext(payload: Record<string, unknown>): AttemptContext | undefined {
  const input = object(payload.context);
  if (input === undefined) return undefined;
  const memoryRefs = Array.isArray(input.memoryRefs) ? input.memoryRefs.slice(0, 100).flatMap((value) => {
    const ref = object(value); const memoryId = text(ref?.memoryId); const revision = count(ref?.revision);
    return memoryId === undefined || revision === undefined ? [] : [{ memoryId, revision }];
  }) : undefined;
  const lineage = Array.isArray(input.lineage) ? input.lineage.slice(0, 100).flatMap((value) => {
    const ref = object(value); const eventId = text(ref?.eventId);
    if (eventId === undefined || (ref?.kind !== "compaction" && ref?.kind !== "handoff")) return [];
    const previousAttemptId = text(ref.previousAttemptId); const previousTurnId = text(ref.previousTurnId);
    return [{ kind: ref.kind as "compaction" | "handoff", eventId, ...(previousAttemptId === undefined ? {} : { previousAttemptId }), ...(previousTurnId === undefined ? {} : { previousTurnId }) }];
  }) : undefined;
  const artifacts = Array.isArray(input.artifacts) ? input.artifacts.slice(0, 100).flatMap((value) => {
    const ref = object(value); const artifactId = text(ref?.artifactId);
    return artifactId === undefined ? [] : [{ artifactId, kind: "context" as const }];
  }) : undefined;
  return { ...(memoryRefs === undefined ? {} : { memoryRefs }), ...(lineage === undefined ? {} : { lineage }), ...(artifacts === undefined ? {} : { artifacts }) };
}

/** Only source records with a documented native role contribute native provenance. */
export function nativeRuntimeObservation(source: HookSource, value: unknown): { readonly runtime: TraceRuntimeObservation; readonly turnId?: string } | undefined {
  const record = object(value); if (record === undefined) return undefined;
  let payload: Record<string, unknown> | undefined;
  if (source === "claude-code" && record.type === "assistant") {
    const message = object(record.message);
    if (message?.model === undefined && message?.usage === undefined) return undefined;
    payload = { model: message.model, usage: message.usage };
  } else if (source === "codex" && record.type === "turn_context") {
    const native = object(record.payload); if (native === undefined) return undefined;
    payload = { ...native, settings: { reasoning_effort: native.effort ?? native.reasoning_effort, ...object(native.settings) } };
  } else if (source === "codex" && record.type === "event_msg" && object(record.payload)?.type === "token_count") {
    const usage = object(object(object(record.payload)?.info)?.last_token_usage);
    if (usage === undefined) return undefined; // Cumulative totals are not per-turn counts.
    payload = { usage };
  } else return undefined;
  const runtime = { ...captureRuntimeObservation(source, payload), provenance: "native" as const };
  const turnId = text(object(record.payload)?.turn_id) ?? text(record.turn_id) ?? text(record.uuid);
  return { runtime, ...(turnId === undefined ? {} : { turnId }) };
}
