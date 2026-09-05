import { parseEvent, type FoldEvent, type JsonValue } from "@_89/fold";
import { canAccessSpace, validateAccessContext } from "./access.js";
import type { EpistemicEventContext, EpistemicEventStamp, PersonalMemory } from "./types.js";
import { assertUuidV7 } from "./uuidv7.js";

export const MEMORY_FEEDBACK_NODE_KIND = "x.fold.memory-feedback";
export type MemoryFeedbackSignal = "recalled" | "helpful" | "unhelpful" | "superseded";
/** Read compatibility only. New events require version 2 and an exact revision. */
export interface LegacyMemoryFeedbackInput { readonly signal: MemoryFeedbackSignal; readonly query?: string; readonly taskId?: string; readonly sessionId?: string; readonly detail?: string }
export interface FeedbackRanking { readonly id: string; readonly kind: "lexical" | "semantic" | "explicit"; readonly configRevision?: string }
export interface FeedbackProvider { readonly id: string; readonly configRevision?: string }
export interface MemoryFeedbackInputV2 {
  readonly version: 2; readonly memoryRevision: number; readonly recallId: string;
  readonly signal: "offered" | "injected" | "used" | "judged" | "outcome";
  readonly judgment?: "helpful" | "unhelpful" | "superseded";
  readonly rank?: number; readonly ranking?: FeedbackRanking; readonly provider?: FeedbackProvider;
  readonly taskId?: string; readonly attemptId?: string; readonly sessionId?: string;
  readonly outcomeEventId?: string; readonly detail?: string;
}
export type MemoryFeedbackInput = LegacyMemoryFeedbackInput | MemoryFeedbackInputV2;
export type MemoryFeedbackRecord = MemoryFeedbackInput & { readonly recordType: "feedback"; readonly actorId: string; readonly workspaceId: string; readonly memoryId: string; readonly atMs: number };
export interface MemoryFeedbackSummary {
  readonly memoryId: string; readonly memoryRevision: number;
  readonly offered: number; readonly injected: number; readonly used: number; readonly outcomes: number;
  readonly helpful: number; readonly unhelpful: number; readonly superseded: number;
  readonly distinctActors: number; readonly legacyUnversioned: number;
  readonly reviewSuggested: boolean; readonly basis: "actor-reported";
}
export class MemoryFeedbackError extends Error { override readonly name = "MemoryFeedbackError" }
function text(value: unknown, label: string, max = 500): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw new MemoryFeedbackError(`${label} must contain 1 to ${max} characters`);
  return value.trim();
}
function object(value: unknown): Record<string, unknown> { if (value === null || typeof value !== "object" || Array.isArray(value)) throw new MemoryFeedbackError("feedback must be an object"); return value as Record<string, unknown>; }
function keys(value: Record<string, unknown>, allowed: readonly string[]): void { if (Object.keys(value).some((key) => !allowed.includes(key))) throw new MemoryFeedbackError("unknown feedback field"); }
function provider(value: unknown): FeedbackProvider { const data = object(value); keys(data, ["id", "configRevision"]); return { id: text(data.id, "provider id"), ...(data.configRevision === undefined ? {} : { configRevision: text(data.configRevision, "provider configuration") }) }; }
export function normalizeMemoryFeedbackInputV2(value: unknown): MemoryFeedbackInputV2 {
  const data = object(value); keys(data, ["version", "memoryRevision", "recallId", "signal", "judgment", "rank", "ranking", "provider", "taskId", "attemptId", "sessionId", "outcomeEventId", "detail"]);
  if (data.version !== 2 || !Number.isSafeInteger(data.memoryRevision) || (data.memoryRevision as number) < 0) throw new MemoryFeedbackError("feedback requires version 2 and an exact non-negative memory revision");
  if (!["offered", "injected", "used", "judged", "outcome"].includes(String(data.signal))) throw new MemoryFeedbackError("invalid feedback signal");
  if (data.signal === "judged" ? !["helpful", "unhelpful", "superseded"].includes(String(data.judgment)) : data.judgment !== undefined) throw new MemoryFeedbackError("judgment is required only for judged feedback");
  if (data.signal === "outcome" ? data.outcomeEventId === undefined : data.outcomeEventId !== undefined) throw new MemoryFeedbackError("outcome feedback requires an outcome event reference");
  if (data.rank !== undefined && (!Number.isSafeInteger(data.rank) || (data.rank as number) < 1)) throw new MemoryFeedbackError("feedback rank must be a positive integer");
  if (data.attemptId !== undefined && data.taskId === undefined) throw new MemoryFeedbackError("feedback attempt requires taskId");
  let ranking: FeedbackRanking | undefined;
  if (data.ranking !== undefined) { const row = object(data.ranking); keys(row, ["id", "kind", "configRevision"]); if (!["lexical", "semantic", "explicit"].includes(String(row.kind))) throw new MemoryFeedbackError("invalid feedback ranking kind"); ranking = { ...provider({ id: row.id, ...(row.configRevision === undefined ? {} : { configRevision: row.configRevision }) }), kind: row.kind as FeedbackRanking["kind"] }; }
  return { version: 2, memoryRevision: data.memoryRevision as number, recallId: text(data.recallId, "recallId"), signal: data.signal as MemoryFeedbackInputV2["signal"],
    ...(data.judgment === undefined ? {} : { judgment: data.judgment as MemoryFeedbackInputV2["judgment"] & string }), ...(data.rank === undefined ? {} : { rank: data.rank as number }), ...(ranking === undefined ? {} : { ranking }), ...(data.provider === undefined ? {} : { provider: provider(data.provider) }),
    ...Object.fromEntries(["taskId", "attemptId", "sessionId", "outcomeEventId", "detail"].filter((key) => data[key] !== undefined).map((key) => [key, text(data[key], key, key === "detail" ? 2000 : 500)])),
  };
}
export function makeMemoryFeedbackEvent(context: EpistemicEventContext, stamp: EpistemicEventStamp, memory: PersonalMemory, input: MemoryFeedbackInput, causedBy?: readonly string[]): FoldEvent {
  validateAccessContext(context.access); assertUuidV7(memory.id, "memory id");
  const normalized = normalizeMemoryFeedbackInputV2(input);
  if (memory.updatedAt > stamp.t || memory.workspaceId !== context.access.workspaceId || memory.revision !== normalized.memoryRevision || (memory.audience === "personal" && memory.creatorId !== context.access.principalId) || (memory.spaceId !== undefined && !canAccessSpace(context.access, memory.spaceId)) || context.access.platformDataAccess === true) throw new MemoryFeedbackError("feedback memory revision is unavailable");
  if (context.capture.scope.workspace !== memory.workspaceId || context.capture.scope.space !== memory.spaceId || context.capture.scope.creator !== (memory.audience === "personal" ? memory.creatorId : undefined) || context.capture.identity.principal !== context.access.principalId || context.capture.identity.workspace !== memory.workspaceId) throw new MemoryFeedbackError("feedback capture scope must match the memory");
  const record: MemoryFeedbackRecord = { ...normalized, recordType: "feedback", actorId: context.access.principalId, workspaceId: memory.workspaceId, memoryId: memory.id, atMs: stamp.t };
  return parseEvent({ specVersion: "0.7", id: stamp.id, kind: "memory.feedback-recorded", title: `Memory ${memory.id} marked ${record.signal}`, at: { t: stamp.t, worldDate: stamp.worldDate, granularity: "beat" }, participants: [context.access.principalId], author: context.author, ...(causedBy?.length ? { causedBy: [...causedBy] } : {}), capture: context.capture, changes: [{ verb: "create", subject: `urn:fold-record:${stamp.id}`, nodeKind: MEMORY_FEEDBACK_NODE_KIND, after: JSON.parse(JSON.stringify(record)) as Record<string, JsonValue>, provenance: { basis: "authored" } }] });
}
export function memoryFeedbackRecordsFromEvent(event: FoldEvent): MemoryFeedbackRecord[] {
  const records: MemoryFeedbackRecord[] = [];
  for (const change of event.changes) {
    if (!("nodeKind" in change) || change.nodeKind !== MEMORY_FEEDBACK_NODE_KIND) continue;
    if (change.verb !== "create" || event.kind !== "memory.feedback-recorded" || change.subject !== `urn:fold-record:${event.id}`) throw new MemoryFeedbackError("invalid feedback event envelope");
    const { recordType, actorId: actor, workspaceId: workspace, memoryId: id, atMs, ...input } = change.after;
    const actorId = text(actor, "actorId"), workspaceId = text(workspace, "workspaceId"), memoryId = text(id, "memoryId"); assertUuidV7(memoryId, "memory id");
    if (recordType !== "feedback" || atMs !== event.at.t || event.capture.scope.workspace !== workspaceId || event.capture.identity?.principal !== actorId || event.capture.identity?.workspace !== workspaceId || !event.participants?.includes(actorId) || change.provenance?.basis !== "authored") throw new MemoryFeedbackError("invalid feedback event identity");
    let normalized: MemoryFeedbackInput;
    if (input.version !== undefined) normalized = normalizeMemoryFeedbackInputV2(input);
    else { keys(input, ["signal", "query", "taskId", "sessionId", "detail"]); if (!["recalled", "helpful", "unhelpful", "superseded"].includes(String(input.signal))) throw new MemoryFeedbackError("invalid legacy feedback signal"); normalized = { signal: input.signal as MemoryFeedbackSignal, ...Object.fromEntries(["query", "taskId", "sessionId", "detail"].filter((key) => input[key] !== undefined).map((key) => [key, text(input[key], key, ["query", "detail"].includes(key) ? 2000 : 500)])) }; }
    records.push({ ...normalized, recordType: "feedback", actorId, workspaceId, memoryId, atMs: atMs as number });
  }
  if (event.kind === "memory.feedback-recorded" && records.length !== 1) throw new MemoryFeedbackError("feedback event must contain exactly one record");
  return records;
}
/** Deduplicate delivery by actor/recall/revision/signal; reports never change claim validity or confidence. */
export function summarizeMemoryFeedback(records: readonly MemoryFeedbackRecord[], memoryId: string, memoryRevision: number): MemoryFeedbackSummary {
  const all = records.filter((record) => record.memoryId === memoryId);
  const rows = [...new Map(all.filter((record): record is MemoryFeedbackRecord & MemoryFeedbackInputV2 => "version" in record && record.memoryRevision === memoryRevision).map((record) => [JSON.stringify([record.actorId, record.recallId, record.signal, record.judgment, record.outcomeEventId]), record])).values()];
  const count = (signal: string) => rows.filter((row) => row.signal === signal).length;
  const latestJudgments = [...new Map(rows.filter((row) => row.signal === "judged").sort((a, b) => a.atMs - b.atMs).map((row) => [row.actorId, row])).values()];
  const judgments = (value: string) => latestJudgments.filter((row) => row.judgment === value).length;
  return { memoryId, memoryRevision, offered: count("offered"), injected: count("injected"), used: count("used"), outcomes: count("outcome"), helpful: judgments("helpful"), unhelpful: judgments("unhelpful"), superseded: judgments("superseded"), distinctActors: new Set(rows.map((row) => row.actorId)).size, legacyUnversioned: all.filter((row) => !("version" in row)).length, reviewSuggested: judgments("unhelpful") + judgments("superseded") > 0, basis: "actor-reported" };
}
