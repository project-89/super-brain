import {
  fold,
  forkAt,
  parseEvent,
  sortLog,
  validateProducerOrder,
  type FoldEvent,
  type FoldLogEntry,
} from "@_89/fold";
import {
  makeMemoryForgottenEvent,
  makeMemoryRecordedEvent,
  makeMemoryRevisedEvent,
  memoryLogRecordsFromEvent,
  rebuildMemories,
  recallMemories as recallProjectedMemories,
  recallMemoryById as recallProjectedMemoryById,
  validateAccessContext,
  type EpistemicEventContext,
  type EpistemicEventStamp,
  type MemoryInput,
  type MemoryProjection,
  type MemoryRevisionPatch,
  type RecallRequest,
  type RecalledMemory,
  type PersonalMemory,
} from "@_89/fold-epistemic";

import { assertCanAppendEvent, authorizeEventAccess } from "./access.js";
import type {
  FoldSdkAccessContext,
  FoldSdkListOptions,
  FoldSdkProjectOptions,
  FoldSdkProjection,
  FoldSdkReadOptions,
  FoldSdkStore,
  MemoryForgetResult,
  MemoryMutationResult,
} from "./types.js";

const MEMORY_EVENT_KINDS = new Set([
  "memory.recorded",
  "memory.revised",
  "memory.forgotten",
]);

export class FoldSdkError extends Error {
  override readonly name = "FoldSdkError";
}

export class PersonalMemoryUnavailableError extends Error {
  override readonly name = "PersonalMemoryUnavailableError";

  constructor(readonly memoryId: string) {
    super(`personal memory is unavailable: ${memoryId}`);
  }
}

function validateStatus(status: FoldLogEntry["status"]): void {
  if (status !== "canon" && status !== "draft") {
    throw new FoldSdkError(`unsupported Fold entry status: ${status}`);
  }
}

function validateMemoryEnvelope(event: FoldEvent): void {
  const records = memoryLogRecordsFromEvent(event);
  const isMemoryEvent = MEMORY_EVENT_KINDS.has(event.kind);
  if (isMemoryEvent && (records.length !== 1 || event.changes.length !== 1)) {
    throw new FoldSdkError(`memory event ${event.id} must contain exactly one memory record`);
  }
}

function normalizeKinds(kinds: readonly string[] | undefined): ReadonlySet<string> | undefined {
  if (kinds === undefined) return undefined;
  const normalized = new Set<string>();
  for (const kind of kinds) {
    if (kind.trim().length === 0) throw new FoldSdkError("event kinds must not contain empty values");
    normalized.add(kind);
  }
  return normalized;
}

function validateReadOptions(options: FoldSdkReadOptions): "canon" | "canon+draft" {
  const include = options.include ?? "canon";
  if (include !== "canon" && include !== "canon+draft") {
    throw new FoldSdkError(`unsupported Fold read inclusion: ${include}`);
  }
  if (options.cursor !== undefined) {
    if (!Number.isFinite(options.cursor.t)) {
      throw new FoldSdkError("cursor t must be finite");
    }
    if (options.cursor.eventId.trim().length === 0) {
      throw new FoldSdkError("cursor eventId must not be empty");
    }
  }
  return include;
}

export class FoldSdk {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly store: FoldSdkStore) {}

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation, operation);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async readStoredEntries(): Promise<FoldLogEntry[]> {
    const read = await this.store.read({ missing: "empty" });
    const entries = read.entries.map((entry) => {
      validateStatus(entry.status);
      const event = parseEvent(entry.event);
      validateMemoryEnvelope(event);
      return { event, status: entry.status };
    });
    validateProducerOrder(entries.map((entry) => entry.event));
    return entries;
  }

  private async appendInternal(
    access: FoldSdkAccessContext,
    event: FoldEvent,
    status: FoldLogEntry["status"],
  ): Promise<FoldLogEntry> {
    validateStatus(status);
    const parsed = parseEvent(event);
    validateMemoryEnvelope(parsed);
    assertCanAppendEvent(parsed, access);
    const entries = await this.readStoredEntries();
    validateProducerOrder([...entries.map((entry) => entry.event), parsed]);
    const entry = { event: parsed, status } as const;
    await this.store.append(entry);
    return entry;
  }

  append(
    access: FoldSdkAccessContext,
    event: FoldEvent,
    status: FoldLogEntry["status"] = "canon",
  ): Promise<FoldLogEntry> {
    return this.enqueue(() => this.appendInternal(access, event, status));
  }

  private async entriesForAccess(
    access: FoldSdkAccessContext,
    options: FoldSdkReadOptions,
  ): Promise<FoldLogEntry[]> {
    validateAccessContext(access);
    const include = validateReadOptions(options);
    const entries = (await this.readStoredEntries()).filter(
      (entry) =>
        (include === "canon+draft" || entry.status === "canon") &&
        authorizeEventAccess(entry.event, access).allowed,
    );
    const ordered = sortLog(entries);
    return options.cursor === undefined ? ordered : forkAt(ordered, options.cursor);
  }

  listEntries(
    access: FoldSdkAccessContext,
    options: FoldSdkListOptions = {},
  ): Promise<readonly FoldLogEntry[]> {
    return this.enqueue(async () => {
      const kinds = normalizeKinds(options.kinds);
      const entries = await this.entriesForAccess(access, options);
      return kinds === undefined
        ? entries
        : entries.filter((entry) => kinds.has(entry.event.kind));
    });
  }

  project(
    access: FoldSdkAccessContext,
    options: FoldSdkProjectOptions = {},
  ): Promise<FoldSdkProjection> {
    return this.enqueue(async () => {
      const entries = await this.entriesForAccess(access, options);
      const state = fold(entries, {
        include: "canon+draft",
        ...(options.components === undefined ? {} : { components: options.components }),
      });
      return { entries, state };
    });
  }

  private async memoryProjection(
    access: FoldSdkAccessContext,
  ): Promise<{ readonly events: readonly FoldEvent[]; readonly projection: MemoryProjection }> {
    const entries = await this.entriesForAccess(access, { include: "canon" });
    const events = entries.map((entry) => entry.event);
    return { events, projection: rebuildMemories(events) };
  }

  recordMemory(
    context: EpistemicEventContext,
    stamp: EpistemicEventStamp,
    input: MemoryInput,
    causedBy?: readonly string[],
  ): Promise<MemoryMutationResult> {
    return this.enqueue(async () => {
      const event = makeMemoryRecordedEvent(context, stamp, input, causedBy);
      await this.appendInternal(context.access, event, "canon");
      const record = memoryLogRecordsFromEvent(event)[0];
      if (record?.recordType !== "recorded") {
        throw new FoldSdkError(`memory event ${event.id} did not contain a recorded memory`);
      }
      return { event, memory: record.memory };
    });
  }

  reviseMemory(
    context: EpistemicEventContext,
    stamp: EpistemicEventStamp,
    memoryId: string,
    patch: MemoryRevisionPatch,
    causedBy?: readonly string[],
  ): Promise<MemoryMutationResult> {
    return this.enqueue(async () => {
      const current = await this.memoryProjection(context.access);
      const memory = recallProjectedMemoryById(current.projection, context.access, memoryId);
      if (memory === undefined) throw new PersonalMemoryUnavailableError(memoryId);
      const event = makeMemoryRevisedEvent(context, stamp, memory, patch, causedBy);
      await this.appendInternal(context.access, event, "canon");
      const next = rebuildMemories([...current.events, event]);
      const revised = recallProjectedMemoryById(next, context.access, memoryId);
      if (revised === undefined) throw new FoldSdkError(`memory ${memoryId} disappeared after revision`);
      return { event, memory: revised };
    });
  }

  forgetMemory(
    context: EpistemicEventContext,
    stamp: EpistemicEventStamp,
    memoryId: string,
    reason: string,
    causedBy?: readonly string[],
  ): Promise<MemoryForgetResult> {
    return this.enqueue(async () => {
      const current = await this.memoryProjection(context.access);
      const memory = recallProjectedMemoryById(current.projection, context.access, memoryId);
      if (memory === undefined) throw new PersonalMemoryUnavailableError(memoryId);
      const event = makeMemoryForgottenEvent(context, stamp, memory, reason, causedBy);
      await this.appendInternal(context.access, event, "canon");
      const next = rebuildMemories([...current.events, event]);
      const forgotten = next.forgotten.get(memoryId);
      if (forgotten === undefined) throw new FoldSdkError(`memory ${memoryId} was not forgotten`);
      return { event, forgotten };
    });
  }

  recallMemories(
    access: FoldSdkAccessContext,
    request: RecallRequest = {},
  ): Promise<RecalledMemory[]> {
    return this.enqueue(async () => {
      const { projection } = await this.memoryProjection(access);
      return recallProjectedMemories(projection, access, request);
    });
  }

  memoryById(
    access: FoldSdkAccessContext,
    memoryId: string,
  ): Promise<PersonalMemory | undefined> {
    return this.enqueue(async () => {
      const { projection } = await this.memoryProjection(access);
      return recallProjectedMemoryById(projection, access, memoryId);
    });
  }
}
