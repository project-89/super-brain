import { parseEvent, type FoldEvent, type JsonValue } from "@_89/fold";

import { validateAccessContext } from "./access.js";
import type { EpistemicEventContext, EpistemicEventStamp, PersonalMemory } from "./types.js";
import { assertUuidV7 } from "./uuidv7.js";

export const MEMORY_FEEDBACK_NODE_KIND = "x.fold.memory-feedback";

export type MemoryFeedbackSignal = "recalled" | "helpful" | "unhelpful" | "superseded";

export interface MemoryFeedbackInput {
  readonly signal: MemoryFeedbackSignal;
  readonly query?: string;
  readonly taskId?: string;
  readonly sessionId?: string;
  readonly detail?: string;
}

export interface MemoryFeedbackRecord extends MemoryFeedbackInput {
  readonly recordType: "feedback";
  readonly actorId: string;
  readonly workspaceId: string;
  readonly memoryId: string;
  readonly atMs: number;
}

export class MemoryFeedbackError extends Error {
  override readonly name = "MemoryFeedbackError";
}

function nonEmpty(value: string, label: string, maxLength: number): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength) {
    throw new MemoryFeedbackError(`${label} must contain 1 to ${maxLength} characters`);
  }
  return normalized;
}

function optionalText(value: JsonValue | undefined, label: string, maxLength: number): string | undefined {
  return value === undefined ? undefined : nonEmpty(typeof value === "string" ? value : "", label, maxLength);
}

function feedbackSignal(value: JsonValue | undefined): MemoryFeedbackSignal {
  if (value !== "recalled" && value !== "helpful" && value !== "unhelpful" && value !== "superseded") {
    throw new MemoryFeedbackError("memory feedback signal is invalid");
  }
  return value;
}

function feedbackJson(input: MemoryFeedbackRecord): Record<string, JsonValue> {
  return {
    recordType: input.recordType,
    actorId: input.actorId,
    workspaceId: input.workspaceId,
    memoryId: input.memoryId,
    signal: input.signal,
    atMs: input.atMs,
    ...(input.query === undefined ? {} : { query: input.query }),
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    ...(input.detail === undefined ? {} : { detail: input.detail }),
  };
}

export function makeMemoryFeedbackEvent(
  context: EpistemicEventContext,
  stamp: EpistemicEventStamp,
  memory: PersonalMemory,
  input: MemoryFeedbackInput,
  causedBy?: readonly string[],
): FoldEvent {
  validateAccessContext(context.access);
  assertUuidV7(memory.id, "memory id");
  if (memory.workspaceId !== context.access.workspaceId) {
    throw new MemoryFeedbackError("memory feedback workspace must match the memory");
  }
  if (
    context.capture.scope.workspace !== context.access.workspaceId ||
    context.capture.identity.principal !== context.access.principalId ||
    context.capture.identity.workspace !== context.access.workspaceId
  ) {
    throw new MemoryFeedbackError("memory feedback capture identity is invalid");
  }
  const record: MemoryFeedbackRecord = {
    recordType: "feedback",
    actorId: context.access.principalId,
    workspaceId: context.access.workspaceId,
    memoryId: memory.id,
    signal: feedbackSignal(input.signal),
    atMs: stamp.t,
    ...(input.query === undefined ? {} : { query: nonEmpty(input.query, "feedback query", 2_000) }),
    ...(input.taskId === undefined ? {} : { taskId: nonEmpty(input.taskId, "feedback taskId", 500) }),
    ...(input.sessionId === undefined ? {} : { sessionId: nonEmpty(input.sessionId, "feedback sessionId", 500) }),
    ...(input.detail === undefined ? {} : { detail: nonEmpty(input.detail, "feedback detail", 2_000) }),
  };
  return parseEvent({
    specVersion: "0.7",
    id: stamp.id,
    kind: "memory.feedback-recorded",
    title: `Memory ${memory.id} marked ${record.signal}`,
    at: { t: stamp.t, worldDate: stamp.worldDate, granularity: "beat" },
    participants: [context.access.principalId],
    author: context.author,
    ...(causedBy === undefined || causedBy.length === 0 ? {} : { causedBy: [...causedBy] }),
    capture: context.capture,
    changes: [{
      verb: "create",
      subject: `urn:fold-record:${stamp.id}`,
      nodeKind: MEMORY_FEEDBACK_NODE_KIND,
      after: feedbackJson(record),
      provenance: { basis: "authored" },
    }],
  });
}

export function memoryFeedbackRecordsFromEvent(event: FoldEvent): MemoryFeedbackRecord[] {
  const records: MemoryFeedbackRecord[] = [];
  for (const change of event.changes) {
    if (change.verb !== "create" || change.nodeKind !== MEMORY_FEEDBACK_NODE_KIND) continue;
    if (event.kind !== "memory.feedback-recorded" || change.subject !== `urn:fold-record:${event.id}`) {
      throw new MemoryFeedbackError("memory feedback event envelope is invalid");
    }
    const payload = change.after;
    if (payload.recordType !== "feedback") throw new MemoryFeedbackError("memory feedback record type is invalid");
    const actorId = nonEmpty(typeof payload.actorId === "string" ? payload.actorId : "", "feedback actorId", 500);
    const workspaceId = nonEmpty(typeof payload.workspaceId === "string" ? payload.workspaceId : "", "feedback workspaceId", 500);
    const memoryId = nonEmpty(typeof payload.memoryId === "string" ? payload.memoryId : "", "feedback memoryId", 500);
    assertUuidV7(memoryId, "memory id");
    if (typeof payload.atMs !== "number" || !Number.isFinite(payload.atMs) || payload.atMs < 0) {
      throw new MemoryFeedbackError("feedback atMs must be non-negative");
    }
    if (
      payload.atMs !== event.at.t ||
      event.capture.scope.workspace !== workspaceId ||
      event.capture.identity?.principal !== actorId ||
      event.capture.identity?.workspace !== workspaceId ||
      event.participants?.includes(actorId) !== true ||
      change.provenance?.basis !== "authored"
    ) {
      throw new MemoryFeedbackError("memory feedback event identity is invalid");
    }
    const query = optionalText(payload.query, "feedback query", 2_000);
    const taskId = optionalText(payload.taskId, "feedback taskId", 500);
    const sessionId = optionalText(payload.sessionId, "feedback sessionId", 500);
    const detail = optionalText(payload.detail, "feedback detail", 2_000);
    records.push({
      recordType: "feedback",
      actorId,
      workspaceId,
      memoryId,
      signal: feedbackSignal(payload.signal),
      atMs: payload.atMs,
      ...(query === undefined ? {} : { query }),
      ...(taskId === undefined ? {} : { taskId }),
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(detail === undefined ? {} : { detail }),
    });
  }
  return records;
}
