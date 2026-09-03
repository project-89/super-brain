import { parseEvent, type FoldEvent, type JsonValue, type Provenance } from "@_89/fold";

import { assertCanWritePersonalMemory, validateAccessContext } from "./access.js";
import type {
  EpistemicEventContext,
  EpistemicEventStamp,
  ForgottenMemory,
  MemoryEntityRef,
  MemoryCandidateEvidence,
  MemoryAudience,
  MemoryInput,
  MemoryRevisionPatch,
  PersonalMemory,
} from "./types.js";
import { assertUuidV7 } from "./uuidv7.js";

export const MEMORY_NODE_KIND = "x.fold.personal-memory";
export const MEMORY_REVISION_NODE_KIND = "x.fold.memory-revision";
export const MEMORY_FORGET_NODE_KIND = "x.fold.memory-forget";

const AUTHORED_PROVENANCE: Provenance = { basis: "authored" };

export type MemoryLogRecord =
  | {
      readonly recordType: "recorded";
      readonly actorId: string;
      readonly workspaceId: string;
      readonly spaceId?: string;
      readonly audience: MemoryAudience;
      readonly atMs: number;
      readonly memory: PersonalMemory;
    }
  | {
      readonly recordType: "revised";
      readonly actorId: string;
      readonly workspaceId: string;
      readonly spaceId?: string;
      readonly audience: MemoryAudience;
      readonly atMs: number;
      readonly memoryId: string;
      readonly patch: MemoryRevisionPatch;
    }
  | {
      readonly recordType: "forgotten";
      readonly actorId: string;
      readonly workspaceId: string;
      readonly spaceId?: string;
      readonly audience: MemoryAudience;
      readonly atMs: number;
      readonly memoryId: string;
      readonly reason: string;
    };

export class MemoryEventError extends Error {
  override readonly name = "MemoryEventError";
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function nonEmpty(value: string, label: string, maxLength?: number): void {
  if (value.trim().length === 0) throw new MemoryEventError(`${label} must not be empty`);
  if (maxLength !== undefined && value.length > maxLength) {
    throw new MemoryEventError(`${label} must be at most ${maxLength} characters`);
  }
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

export function summarizeMemoryContent(content: JsonValue): string {
  const text = typeof content === "string" ? content : canonicalJson(content);
  if (text.length === 0 || text === "null") return "Memory";
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

export function normalizeMemoryTags(tags: readonly string[] = []): string[] {
  const normalized = new Set<string>();
  for (const tag of tags) {
    const value = tag.trim();
    nonEmpty(value, "memory tag");
    normalized.add(value);
  }
  return [...normalized].sort(compareCodeUnits);
}

export function normalizeMemoryProjectIds(projectIds: readonly string[] = []): string[] {
  const normalized = new Set<string>();
  for (const projectId of projectIds) {
    const value = projectId.trim();
    nonEmpty(value, "memory project id", 300);
    normalized.add(value);
  }
  return [...normalized].sort(compareCodeUnits);
}

function validateEntity(entity: MemoryEntityRef): void {
  nonEmpty(entity.id, "entity id", 200);
  nonEmpty(entity.type, "entity type", 200);
  nonEmpty(entity.name, "entity name", 500);
}

function validateContext(context: EpistemicEventContext): void {
  validateAccessContext(context.access);
  nonEmpty(context.author.id, "author id");
  if (context.capture.scope.workspace !== context.access.workspaceId) {
    throw new MemoryEventError("capture.scope.workspace must match access workspaceId");
  }
  if (
    context.capture.scope.creator !== undefined &&
    context.capture.scope.creator !== context.access.principalId
  ) {
    throw new MemoryEventError("capture.scope.creator must match access principalId");
  }
  if (context.capture.identity.principal !== context.access.principalId) {
    throw new MemoryEventError("capture.identity.principal must match access principalId");
  }
  if (context.capture.identity.workspace !== context.access.workspaceId) {
    throw new MemoryEventError("capture.identity.workspace must match access workspaceId");
  }
}

function validateMemoryScope(
  context: EpistemicEventContext,
  spaceId: string | undefined,
  audience: MemoryAudience,
): void {
  validateContext(context);
  const expectedCreator = audience === "personal" ? context.access.principalId : undefined;
  if (context.capture.scope.creator !== expectedCreator) {
    throw new MemoryEventError(
      audience === "personal"
        ? "capture.scope.creator must match personal memory creator"
        : "workspace memory capture must not be creator-scoped",
    );
  }
  if (context.capture.scope.space !== spaceId) {
    throw new MemoryEventError("capture.scope.space must match memory spaceId");
  }
}

function validateStamp(stamp: EpistemicEventStamp): void {
  nonEmpty(stamp.id, "event id");
  if (!Number.isFinite(stamp.t) || stamp.t < 0) {
    throw new MemoryEventError("event t must be finite and non-negative");
  }
}

function makeEvent(
  context: EpistemicEventContext,
  stamp: EpistemicEventStamp,
  input: {
    readonly kind: string;
    readonly title: string;
    readonly nodeKind: string;
    readonly subject: string;
    readonly after: Record<string, JsonValue>;
    readonly causedBy?: readonly string[];
  },
): FoldEvent {
  validateContext(context);
  validateStamp(stamp);
  for (const eventId of input.causedBy ?? []) nonEmpty(eventId, "causedBy event id");
  return parseEvent({
    specVersion: "0.7",
    id: stamp.id,
    kind: input.kind,
    title: input.title,
    at: { t: stamp.t, worldDate: stamp.worldDate, granularity: "beat" },
    participants: [context.access.principalId],
    author: context.author,
    ...(input.causedBy === undefined || input.causedBy.length === 0
      ? {}
      : { causedBy: [...input.causedBy] }),
    capture: context.capture,
    changes: [
      {
        verb: "create",
        subject: input.subject,
        nodeKind: input.nodeKind,
        after: input.after,
        provenance: AUTHORED_PROVENANCE,
      },
    ],
  });
}

function entityJson(entities: readonly MemoryEntityRef[]): JsonValue[] {
  return entities.map((entity) => ({ id: entity.id, type: entity.type, name: entity.name }));
}

function memoryJson(memory: PersonalMemory): Record<string, JsonValue> {
  return {
    id: memory.id,
    workspaceId: memory.workspaceId,
    ...(memory.spaceId === undefined ? {} : { spaceId: memory.spaceId }),
    creatorId: memory.creatorId,
    audience: memory.audience,
    projectIds: [...memory.projectIds],
    source: memory.source,
    summary: memory.summary,
    content: memory.content,
    tags: [...memory.tags],
    entities: entityJson(memory.entities),
    ...(memory.evidence === undefined ? {} : { evidence: evidenceJson(memory.evidence) }),
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
    revision: memory.revision,
  };
}

function evidenceJson(evidence: readonly MemoryCandidateEvidence[]): JsonValue[] {
  return evidence.map((item) => ({
    eventId: item.eventId,
    ...(item.projectId === undefined ? {} : { projectId: item.projectId }),
    ...(item.runId === undefined ? {} : { runId: item.runId }),
    ...(item.turnId === undefined ? {} : { turnId: item.turnId }),
  }));
}

function validateEvidence(evidence: readonly MemoryCandidateEvidence[]): void {
  for (const [index, item] of evidence.entries()) {
    nonEmpty(item.eventId, `memory evidence ${index} eventId`, 500);
    if (item.projectId !== undefined) nonEmpty(item.projectId, `memory evidence ${index} projectId`, 300);
    if (item.runId !== undefined) nonEmpty(item.runId, `memory evidence ${index} runId`, 500);
    if (item.turnId !== undefined) nonEmpty(item.turnId, `memory evidence ${index} turnId`, 500);
  }
}

function patchJson(patch: MemoryRevisionPatch): Record<string, JsonValue> {
  return {
    ...(patch.summary === undefined ? {} : { summary: patch.summary }),
    ...(patch.content === undefined ? {} : { content: patch.content }),
    ...(patch.tags === undefined ? {} : { tags: [...patch.tags] }),
    ...(patch.evidence === undefined ? {} : { evidence: evidenceJson(patch.evidence) }),
  };
}

export function makeMemoryRecordedEvent(
  context: EpistemicEventContext,
  stamp: EpistemicEventStamp,
  input: MemoryInput,
  causedBy?: readonly string[],
): FoldEvent {
  const audience = input.audience ?? "personal";
  validateMemoryScope(context, input.spaceId, audience);
  assertUuidV7(input.id, "memory id");
  nonEmpty(input.source, "memory source", 200);
  if (input.summary !== undefined && input.summary.length > 500) {
    throw new MemoryEventError("memory summary must be at most 500 characters");
  }
  for (const entity of input.entities ?? []) validateEntity(entity);
  validateEvidence(input.evidence ?? []);
  assertCanWritePersonalMemory(
    {
      workspaceId: context.access.workspaceId,
      ...(input.spaceId === undefined ? {} : { spaceId: input.spaceId }),
      creatorId: context.access.principalId,
      audience,
    },
    context.access,
  );
  const content = input.content ?? null;
  const memory: PersonalMemory = {
    id: input.id,
    workspaceId: context.access.workspaceId,
    ...(input.spaceId === undefined ? {} : { spaceId: input.spaceId }),
    creatorId: context.access.principalId,
    audience,
    projectIds: normalizeMemoryProjectIds(input.projectIds),
    source: input.source,
    summary: input.summary ?? summarizeMemoryContent(content),
    content,
    tags: normalizeMemoryTags(input.tags),
    entities: [...(input.entities ?? [])],
    ...(input.evidence === undefined ? {} : { evidence: [...input.evidence] }),
    createdAt: stamp.t,
    updatedAt: stamp.t,
    revision: 0,
  };
  return makeEvent(context, stamp, {
    kind: "memory.recorded",
    title: `${audience === "personal" ? "Personal" : "Workspace"} memory recorded from ${input.source}`,
    nodeKind: MEMORY_NODE_KIND,
    subject: input.id,
    after: {
      recordType: "recorded",
      actorId: context.access.principalId,
      workspaceId: context.access.workspaceId,
      ...(input.spaceId === undefined ? {} : { spaceId: input.spaceId }),
      audience,
      atMs: stamp.t,
      memory: memoryJson(memory),
    },
    ...(causedBy === undefined ? {} : { causedBy }),
  });
}

export function makeMemoryRevisedEvent(
  context: EpistemicEventContext,
  stamp: EpistemicEventStamp,
  memory: PersonalMemory,
  patch: MemoryRevisionPatch,
  causedBy?: readonly string[],
): FoldEvent {
  validateMemoryScope(context, memory.spaceId, memory.audience);
  assertUuidV7(memory.id, "memory id");
  assertCanWritePersonalMemory(memory, context.access);
  if (stamp.t < memory.updatedAt) {
    throw new MemoryEventError("memory revision must not predate the current memory");
  }
  const allowed = new Set(["summary", "content", "tags", "evidence"]);
  for (const key of Object.keys(patch)) {
    if (!allowed.has(key)) throw new MemoryEventError(`unknown memory revision field: ${key}`);
  }
  if (patch.summary !== undefined && patch.summary.length > 500) {
    throw new MemoryEventError("memory summary must be at most 500 characters");
  }
  validateEvidence(patch.evidence ?? []);
  const normalizedPatch: MemoryRevisionPatch = {
    ...(patch.summary === undefined ? {} : { summary: patch.summary }),
    ...(patch.content === undefined ? {} : { content: patch.content }),
    ...(patch.tags === undefined ? {} : { tags: normalizeMemoryTags(patch.tags) }),
    ...(patch.evidence === undefined ? {} : { evidence: [...patch.evidence] }),
  };
  if (Object.keys(normalizedPatch).length === 0) {
    throw new MemoryEventError("memory revision patch must not be empty");
  }
  return makeEvent(context, stamp, {
    kind: "memory.revised",
    title: `${memory.audience === "personal" ? "Personal" : "Workspace"} memory ${memory.id} revised`,
    nodeKind: MEMORY_REVISION_NODE_KIND,
    subject: `urn:fold-record:${stamp.id}`,
    after: {
      recordType: "revised",
      actorId: context.access.principalId,
      workspaceId: context.access.workspaceId,
      ...(memory.spaceId === undefined ? {} : { spaceId: memory.spaceId }),
      audience: memory.audience,
      atMs: stamp.t,
      memoryId: memory.id,
      patch: patchJson(normalizedPatch),
    },
    ...(causedBy === undefined ? {} : { causedBy }),
  });
}

export function makeMemoryForgottenEvent(
  context: EpistemicEventContext,
  stamp: EpistemicEventStamp,
  memory: PersonalMemory,
  reason: string,
  causedBy?: readonly string[],
): FoldEvent {
  validateMemoryScope(context, memory.spaceId, memory.audience);
  assertUuidV7(memory.id, "memory id");
  assertCanWritePersonalMemory(memory, context.access);
  if (stamp.t < memory.updatedAt) {
    throw new MemoryEventError("memory forget must not predate the current memory");
  }
  nonEmpty(reason, "forget reason");
  return makeEvent(context, stamp, {
    kind: "memory.forgotten",
    title: `${memory.audience === "personal" ? "Personal" : "Workspace"} memory ${memory.id} forgotten`,
    nodeKind: MEMORY_FORGET_NODE_KIND,
    subject: `urn:fold-record:${stamp.id}`,
    after: {
      recordType: "forgotten",
      actorId: context.access.principalId,
      workspaceId: context.access.workspaceId,
      ...(memory.spaceId === undefined ? {} : { spaceId: memory.spaceId }),
      audience: memory.audience,
      atMs: stamp.t,
      memoryId: memory.id,
      reason,
    },
    ...(causedBy === undefined ? {} : { causedBy }),
  });
}

function objectValue(value: JsonValue | undefined, label: string): Record<string, JsonValue> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new MemoryEventError(`${label} must be an object`);
  }
  return value;
}

function stringValue(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new MemoryEventError(`${label} must be a non-empty string`);
  }
  return value;
}

function textValue(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string") throw new MemoryEventError(`${label} must be a string`);
  return value;
}

function numberValue(value: JsonValue | undefined, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new MemoryEventError(`${label} must be a finite number`);
  }
  return value;
}

function stringArray(value: JsonValue | undefined, label: string): string[] {
  if (!Array.isArray(value)) throw new MemoryEventError(`${label} must be an array`);
  return value.map((item, index) => stringValue(item, `${label}[${index}]`));
}

function parseEntities(value: JsonValue | undefined): MemoryEntityRef[] {
  if (!Array.isArray(value)) throw new MemoryEventError("memory entities must be an array");
  return value.map((item, index) => {
    const entity = objectValue(item, `memory entity ${index}`);
    return {
      id: stringValue(entity.id, `memory entity ${index} id`),
      type: stringValue(entity.type, `memory entity ${index} type`),
      name: stringValue(entity.name, `memory entity ${index} name`),
    };
  });
}

function parseEvidence(value: JsonValue | undefined): MemoryCandidateEvidence[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new MemoryEventError("memory evidence must be an array");
  const evidence = value.map((item, index) => {
    const record = objectValue(item, `memory evidence ${index}`);
    return {
      eventId: stringValue(record.eventId, `memory evidence ${index} eventId`),
      ...(record.projectId === undefined ? {} : { projectId: stringValue(record.projectId, `memory evidence ${index} projectId`) }),
      ...(record.runId === undefined ? {} : { runId: stringValue(record.runId, `memory evidence ${index} runId`) }),
      ...(record.turnId === undefined ? {} : { turnId: stringValue(record.turnId, `memory evidence ${index} turnId`) }),
    };
  });
  validateEvidence(evidence);
  return evidence;
}

function optionalString(value: JsonValue | undefined, label: string): string | undefined {
  return value === undefined ? undefined : stringValue(value, label);
}

function memoryAudience(value: JsonValue | undefined): MemoryAudience {
  if (value === undefined) return "personal";
  if (value !== "personal" && value !== "workspace") {
    throw new MemoryEventError("memory audience must be personal or workspace");
  }
  return value;
}

function validateEnvelope(
  event: FoldEvent,
  actorId: string,
  workspaceId: string,
  spaceId: string | undefined,
  audience: MemoryAudience,
  atMs: number,
): void {
  if (event.participants?.includes(actorId) !== true) {
    throw new MemoryEventError(`event ${event.id} principal is not a participant`);
  }
  if (event.capture.scope.workspace !== workspaceId) {
    throw new MemoryEventError(`event ${event.id} workspace does not match capture scope`);
  }
  if (event.capture.scope.space !== spaceId) {
    throw new MemoryEventError(`event ${event.id} space does not match capture scope`);
  }
  const expectedCreator = audience === "personal" ? actorId : undefined;
  if (event.capture.scope.creator !== expectedCreator) {
    throw new MemoryEventError(`event ${event.id} audience does not match capture scope`);
  }
  if (event.capture.identity?.principal !== actorId) {
    throw new MemoryEventError(`event ${event.id} principal does not match capture identity`);
  }
  if (event.capture.identity?.workspace !== workspaceId) {
    throw new MemoryEventError(`event ${event.id} workspace does not match capture identity`);
  }
  if (event.at.t !== atMs) throw new MemoryEventError(`event ${event.id} atMs does not match event t`);
  if (atMs < 0) throw new MemoryEventError(`event ${event.id} atMs must not be negative`);
}

function parseMemory(value: JsonValue | undefined): PersonalMemory {
  const memory = objectValue(value, "memory");
  const id = stringValue(memory.id, "memory id");
  assertUuidV7(id, "memory id");
  const createdAt = numberValue(memory.createdAt, "memory createdAt");
  const updatedAt = numberValue(memory.updatedAt, "memory updatedAt");
  const revision = numberValue(memory.revision, "memory revision");
  if (!Number.isInteger(revision) || revision !== 0) {
    throw new MemoryEventError("recorded memory revision must be zero");
  }
  const source = stringValue(memory.source, "memory source");
  const summary = textValue(memory.summary, "memory summary");
  if (memory.content === undefined) throw new MemoryEventError("memory content is required");
  nonEmpty(source, "memory source", 200);
  if (summary.length > 500) {
    throw new MemoryEventError("memory summary must be at most 500 characters");
  }
  const entities = parseEntities(memory.entities);
  const evidence = parseEvidence(memory.evidence);
  for (const entity of entities) validateEntity(entity);
  return {
    id,
    workspaceId: stringValue(memory.workspaceId, "memory workspaceId"),
    ...(memory.spaceId === undefined ? {} : { spaceId: stringValue(memory.spaceId, "memory spaceId") }),
    creatorId: stringValue(memory.creatorId, "memory creatorId"),
    audience: memoryAudience(memory.audience),
    projectIds: normalizeMemoryProjectIds(
      memory.projectIds === undefined ? [] : stringArray(memory.projectIds, "memory projectIds"),
    ),
    source,
    summary,
    content: memory.content,
    tags: normalizeMemoryTags(stringArray(memory.tags, "memory tags")),
    entities,
    ...(evidence === undefined ? {} : { evidence }),
    createdAt,
    updatedAt,
    revision,
  };
}

function parsePatch(value: JsonValue | undefined): MemoryRevisionPatch {
  const patch = objectValue(value, "memory revision patch");
  const allowed = new Set(["summary", "content", "tags", "evidence"]);
  for (const key of Object.keys(patch)) {
    if (!allowed.has(key)) throw new MemoryEventError(`unknown memory revision field: ${key}`);
  }
  if (Object.keys(patch).length === 0) throw new MemoryEventError("memory revision patch must not be empty");
  const parsed: MemoryRevisionPatch = {
    ...(patch.summary === undefined
      ? {}
      : { summary: textValue(patch.summary, "summary") }),
    ...(patch.content === undefined ? {} : { content: patch.content }),
    ...(patch.tags === undefined ? {} : { tags: normalizeMemoryTags(stringArray(patch.tags, "tags")) }),
    ...(patch.evidence === undefined ? {} : { evidence: parseEvidence(patch.evidence)! }),
  };
  if (parsed.summary !== undefined && parsed.summary.length > 500) {
    throw new MemoryEventError("memory summary must be at most 500 characters");
  }
  return parsed;
}

export function memoryLogRecordsFromEvent(event: FoldEvent): MemoryLogRecord[] {
  const records: MemoryLogRecord[] = [];
  for (const change of event.changes) {
    if (change.verb !== "create") continue;
    if (
      change.nodeKind !== MEMORY_NODE_KIND &&
      change.nodeKind !== MEMORY_REVISION_NODE_KIND &&
      change.nodeKind !== MEMORY_FORGET_NODE_KIND
    ) {
      continue;
    }
    const payload = change.after;
    const recordType = stringValue(payload.recordType, "memory recordType");
    const actorId = stringValue(payload.actorId, "memory actorId");
    const workspaceId = stringValue(payload.workspaceId, "memory workspaceId");
    const spaceId = optionalString(payload.spaceId, "memory spaceId");
    const audience = memoryAudience(payload.audience);
    const atMs = numberValue(payload.atMs, "memory atMs");
    validateEnvelope(event, actorId, workspaceId, spaceId, audience, atMs);
    if (change.provenance?.basis !== "authored") {
      throw new MemoryEventError(`event ${event.id} memory record must have authored provenance`);
    }
    if (recordType === "recorded" && change.nodeKind === MEMORY_NODE_KIND) {
      if (event.kind !== "memory.recorded") {
        throw new MemoryEventError(`memory record type ${recordType} does not match event kind`);
      }
      const memory = parseMemory(payload.memory);
      if (change.subject !== memory.id) {
        throw new MemoryEventError("recorded memory subject must match memory id");
      }
      if (memory.spaceId !== spaceId) {
        throw new MemoryEventError("recorded memory space does not match event");
      }
      if (memory.audience !== audience) {
        throw new MemoryEventError("recorded memory audience does not match event");
      }
      if (memory.createdAt !== atMs || memory.updatedAt !== atMs) {
        throw new MemoryEventError("recorded memory timestamps must match event t");
      }
      records.push({ recordType, actorId, workspaceId, ...(spaceId === undefined ? {} : { spaceId }), audience, atMs, memory });
    } else if (recordType === "revised" && change.nodeKind === MEMORY_REVISION_NODE_KIND) {
      if (event.kind !== "memory.revised" || change.subject !== `urn:fold-record:${event.id}`) {
        throw new MemoryEventError(`memory record type ${recordType} does not match event envelope`);
      }
      const memoryId = stringValue(payload.memoryId, "memory id");
      assertUuidV7(memoryId, "memory id");
      records.push({
        recordType,
        actorId,
        workspaceId,
        ...(spaceId === undefined ? {} : { spaceId }),
        audience,
        atMs,
        memoryId,
        patch: parsePatch(payload.patch),
      });
    } else if (recordType === "forgotten" && change.nodeKind === MEMORY_FORGET_NODE_KIND) {
      if (event.kind !== "memory.forgotten" || change.subject !== `urn:fold-record:${event.id}`) {
        throw new MemoryEventError(`memory record type ${recordType} does not match event envelope`);
      }
      const memoryId = stringValue(payload.memoryId, "memory id");
      assertUuidV7(memoryId, "memory id");
      records.push({
        recordType,
        actorId,
        workspaceId,
        ...(spaceId === undefined ? {} : { spaceId }),
        audience,
        atMs,
        memoryId,
        reason: stringValue(payload.reason, "forget reason"),
      });
    } else {
      throw new MemoryEventError(`memory record type ${recordType} does not match node kind`);
    }
  }
  return records;
}

export function forgottenMemoryFromRecord(
  record: Extract<MemoryLogRecord, { recordType: "forgotten" }>,
): ForgottenMemory {
  return {
    memoryId: record.memoryId,
    workspaceId: record.workspaceId,
    ...(record.spaceId === undefined ? {} : { spaceId: record.spaceId }),
    creatorId: record.actorId,
    audience: record.audience,
    forgottenAt: record.atMs,
    reason: record.reason,
  };
}
