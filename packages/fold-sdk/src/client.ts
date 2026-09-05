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
  makeMemoryFeedbackEvent,
  makeMemoryCandidateAcceptedEvent,
  makeMemoryCandidateProposedEvent,
  makeMemoryCandidateRejectedEvent,
  makeMemoryRecordedEvent,
  makeMemoryRevisedEvent,
  memoryLogRecordsFromEvent,
  memoryFeedbackRecordsFromEvent,
  memoryCandidateLogRecordsFromEvent,
  DEFAULT_RECALL_LIMIT,
  MAX_RECALL_LIMIT,
  rebuildMemories,
  rebuildMemoryCandidates,
  listMemoryCandidateViews,
  recallMemories as recallProjectedMemories,
  recallMemoryCorpus,
  recallMemoryById as recallProjectedMemoryById,
  validateAccessContext,
  validateMemoryCandidateEnvelope,
  type EpistemicEventContext,
  type EpistemicEventStamp,
  type MemoryInput,
  type MemoryFeedbackInput,
  type MemoryCandidateInput,
  type MemoryCandidateProjection,
  type MemoryProjection,
  type MemoryRevisionPatch,
  type RecallRequest,
  type RecalledMemory,
  type PersonalMemory,
} from "@_89/fold-epistemic";
import {
  analyzeTrajectoryTask,
  makeTrajectoryRecordedEvent,
  makeTrajectoryTreeRecordedEvent,
  rebuildTrajectories,
  trajectoryLogRecordsFromEvent,
  type TrajectoryEventContext,
  type TrajectoryEventStamp,
  type TrajectoryInput,
  type TrajectoryState,
  type TrajectoryTreeRecord,
} from "@_89/fold-trajectory";
import { isAdditiveTreeRevision } from "@_89/fold-trace";
import {
  eventFromTerminalManagerSignal,
  validateActivityEventEnvelope,
  type ActivityEventStamp,
  type TerminalManagerSignal,
} from "@_89/fold-activity";
import {
  listFleetSessions,
  planOrphanRecovery,
  rebuildFleet,
  type FleetProjectionOptions,
} from "@_89/fold-fleet";
import {
  intentionRecordsFromEvent,
  latestDriveSample,
  makeIntentionActedEvent,
  makeIntentionCommittedEvent,
  makeIntentionDeclinedEvent,
  makeIntentionEndedEvent,
  makeIntentionSurfacedEvent,
  rebuildIntentions,
  recentDeclines,
  validateIntentionEventEnvelope,
  type DriveEventStamp,
  type IntentionEnd,
  type SurfacedCandidate,
} from "@_89/fold-drives";
import {
  makeTranscriptArtifactEvent,
  makeTranscriptChunkEvent,
  makeTranscriptProjectEvent,
  makeTranscriptRunEvent,
  extendTranscriptCatalog,
  rebuildTranscriptCatalog,
  transcriptImportBundleSchema,
  validateTranscriptEventEnvelope,
  type TranscriptCatalog,
  type TranscriptChunk,
  type TranscriptProject,
  type TranscriptRun,
} from "@_89/fold-transcript";

import { assertCanAppendEvent, authorizeEventAccess } from "./access.js";
import type {
  FoldSdkAccessContext,
  FoldSdkActivityContext,
  FoldSdkSteeringContext,
  FoldSdkListOptions,
  FoldSdkProjectOptions,
  FoldSdkProjection,
  FoldSdkReadOptions,
  FoldSdkStore,
  FoldCommandReceipt,
  ActivityMutationResult,
  FleetReadModel,
  MemoryForgetResult,
  MemoryFeedbackResult,
  MemoryCandidateAcceptanceResult,
  MemoryCandidateAcceptanceInput,
  MemoryCandidateListOptions,
  MemoryCandidateMutationResult,
  MemoryCandidateRejectionResult,
  MemoryMutationResult,
  MemoryPage,
  MemoryPageCursor,
  MemoryRanker,
  RankedMemoryRecallRequest,
  RankedMemoryRecallResult,
  SteeringMutationResult,
  SteeringSnapshot,
  FoldSdkTranscriptContext,
  TranscriptImportOptions,
  TranscriptImportResult,
  TranscriptProjectSummary,
  TranscriptRunDetail,
  TranscriptRunFilters,
  TrajectoryMutationResult,
  TrajectoryTaskReport,
  TrajectoryTaskSummary,
  TrajectoryTreeMutationResult,
} from "./types.js";

const MEMORY_EVENT_KINDS = new Set([
  "memory.recorded",
  "memory.revised",
  "memory.forgotten",
]);
const TRAJECTORY_EVENT_KINDS = new Set([
  "trajectory.tree-recorded",
  "trajectory.recorded",
]);
const MEMORY_RECORD_TYPE_BY_KIND = {
  "memory.recorded": "recorded",
  "memory.revised": "revised",
  "memory.forgotten": "forgotten",
} as const;
const TRAJECTORY_RECORD_TYPE_BY_KIND = {
  "trajectory.tree-recorded": "tree",
  "trajectory.recorded": "trajectory",
} as const;

export class FoldSdkError extends Error {
  override readonly name: string = "FoldSdkError";
}

export class FoldSdkConflictError extends FoldSdkError {
  override readonly name = "FoldSdkConflictError";
}

export class PersonalMemoryUnavailableError extends Error {
  override readonly name = "PersonalMemoryUnavailableError";

  constructor(readonly memoryId: string) {
    super(`personal memory is unavailable: ${memoryId}`);
  }
}

export class TrajectoryTaskUnavailableError extends Error {
  override readonly name = "TrajectoryTaskUnavailableError";

  constructor(readonly taskId: string) {
    super(`trajectory task is unavailable: ${taskId}`);
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
  if (!isMemoryEvent && records.length > 0) {
    throw new FoldSdkError(`memory record ${event.id} requires a memory event kind`);
  }
  if (isMemoryEvent) {
    const expected = MEMORY_RECORD_TYPE_BY_KIND[event.kind as keyof typeof MEMORY_RECORD_TYPE_BY_KIND];
    if (records[0]?.recordType !== expected) {
      throw new FoldSdkError(`memory event ${event.id} contains the wrong record type`);
    }
  }
}

function validateTrajectoryEnvelope(event: FoldEvent): void {
  const records = trajectoryLogRecordsFromEvent(event);
  const isTrajectoryEvent = TRAJECTORY_EVENT_KINDS.has(event.kind);
  if (isTrajectoryEvent && (records.length !== 1 || event.changes.length !== 1)) {
    throw new FoldSdkError(`trajectory event ${event.id} must contain exactly one trajectory record`);
  }
  if (!isTrajectoryEvent && records.length > 0) {
    throw new FoldSdkError(`trajectory record ${event.id} requires a trajectory event kind`);
  }
  if (isTrajectoryEvent) {
    const expected = TRAJECTORY_RECORD_TYPE_BY_KIND[
      event.kind as keyof typeof TRAJECTORY_RECORD_TYPE_BY_KIND
    ];
    if (records[0]?.recordType !== expected) {
      throw new FoldSdkError(`trajectory event ${event.id} contains the wrong record type`);
    }
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

function transcriptCatalogCacheKey(access: FoldSdkAccessContext): string {
  return JSON.stringify([
    access.principalId,
    access.workspaceId,
    access.workspaceRole,
    access.platformDataAccess === true,
    Object.entries(access.spaceRoles).sort(([left], [right]) => left.localeCompare(right)),
  ]);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item !== null && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
    }
    return item;
  });
}

export class FoldSdk {
  private queue: Promise<void> = Promise.resolve();
  private storedEntries: FoldLogEntry[] | undefined;
  private storedRevision: string | undefined;
  private readonly transcriptCatalogs = new Map<string, { readonly revision?: string; readonly catalog: TranscriptCatalog }>();
  private readonly memoryProjections = new Map<string, { readonly revision?: string; readonly events: readonly FoldEvent[]; readonly projection: MemoryProjection }>();
  private readonly candidateProjections = new Map<string, { readonly revision?: string; readonly events: readonly FoldEvent[]; readonly projection: MemoryCandidateProjection }>();

  private commandState: { entries?: FoldLogEntry[]; revision?: string; staged: FoldLogEntry[] } | undefined;
  private readonly localReceipts = new Map<string, FoldCommandReceipt>();

  constructor(private readonly store: FoldSdkStore) {}

  private command<T>(access: FoldSdkAccessContext, method: string, identity: unknown,
    request: unknown, operation: () => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      validateAccessContext(access);
      if (this.store.requireDurableCommands === true && this.store.commit === undefined &&
          !["append", "recordMemory", "recordActivitySignal"].includes(method)) {
        throw new FoldSdkError("This command requires durable atomic retry receipts; configure the PostgreSQL store");
      }
      const commandId = JSON.stringify([access.principalId, method, identity]);
      // Authorization is checked now; transient role snapshots are not command input.
      const envelope = request as { readonly context?: { readonly access?: FoldSdkAccessContext } };
      const scope = envelope?.context?.access;
      const normalized = JSON.parse(JSON.stringify(scope === undefined ? request : {
        ...envelope,
        context: { ...envelope.context, access: {
          principalId: scope.principalId, organizationId: scope.organizationId, workspaceId: scope.workspaceId,
        } },
      })) as unknown;
      for (let attempt = 0; ; attempt += 1) {
        const existing = this.store.commandReceipt === undefined
          ? this.localReceipts.get(commandId) : await this.store.commandReceipt(commandId);
        if (existing !== undefined) {
          if (canonicalJson(existing.request) !== canonicalJson(normalized)) {
            throw new FoldSdkConflictError(`${method === "append" ? "event id" : "command identity"} is already used: ${commandId}`);
          }
          for (const entry of existing.entries) assertCanAppendEvent(entry.event, access);
          return existing.result as T;
        }
        const state: NonNullable<FoldSdk["commandState"]> = { staged: [] };
        this.commandState = state;
        let committed = false;
        try {
          // Pin exactly the snapshot used for every domain precondition in this command.
          await this.readStoredEntries();
          const result = await operation();
          const command = { commandId, request: normalized, result };
          if (this.store.commit !== undefined) {
            if (state.revision === undefined) throw new FoldSdkError("atomic store must return snapshot revisions");
            const receipt = await this.store.commit(state.staged, { expectedRevision: state.revision, command });
            return receipt.result as T;
          }
          // Compatibility stores are single-writer; distributed CAS requires commit().
          if (state.staged.length > 1 && this.store.appendMany !== undefined) await this.store.appendMany(state.staged);
          else for (const entry of state.staged) await this.store.append(entry);
          committed = true;
          this.localReceipts.set(commandId, { ...command, entries: state.staged, revision: "local" });
          return result;
        } catch (error) {
          if (attempt < 3 && error instanceof Error && "code" in error && error.code === "revision_conflict") continue;
          throw error;
        } finally {
          this.commandState = undefined;
          this.storedEntries = committed && this.store.stableReads === true ? state.entries : undefined;
          this.storedRevision = undefined;
          this.transcriptCatalogs.clear();
          this.memoryProjections.clear();
          this.candidateProjections.clear();
        }
      }
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation, operation);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private projectionCacheIsCurrent(revision: string | undefined): boolean {
    return this.store.stableReads === true ||
      (revision !== undefined && revision === this.storedRevision);
  }

  private clearProjectionCachesFor(event: FoldEvent): void {
    if (event.kind.startsWith("transcript.")) this.transcriptCatalogs.clear();
    if (event.kind.startsWith("memory.")) this.memoryProjections.clear();
    if (event.kind.startsWith("memory.candidate-")) this.candidateProjections.clear();
  }

  private async readStoredEntries(): Promise<FoldLogEntry[]> {
    if (this.commandState?.entries !== undefined) return this.commandState.entries;
    if (this.store.stableReads === true && this.storedEntries !== undefined) {
      if (this.commandState !== undefined) {
        this.commandState.entries = [...this.storedEntries];
        if (this.storedRevision !== undefined) this.commandState.revision = this.storedRevision;
        return this.commandState.entries;
      }
      return this.storedEntries;
    }
    const read = await this.store.read({ missing: "empty" });
    if (
      read.revision !== undefined &&
      this.storedEntries !== undefined &&
      read.revision === this.storedRevision
    ) {
      if (this.commandState !== undefined) {
        this.commandState.entries = [...this.storedEntries];
        if (this.storedRevision !== undefined) this.commandState.revision = this.storedRevision;
        return this.commandState.entries;
      }
      return this.storedEntries;
    }
    const entries = read.entries.map((entry) => {
      validateStatus(entry.status);
      const event = parseEvent(entry.event);
      validateMemoryEnvelope(event);
      validateMemoryCandidateEnvelope(event);
      validateTrajectoryEnvelope(event);
      validateActivityEventEnvelope(event);
      validateIntentionEventEnvelope(event);
      validateTranscriptEventEnvelope(event);
      return { event, status: entry.status };
    });
    validateProducerOrder(entries.map((entry) => entry.event));
    if (this.store.stableReads === true || read.revision !== undefined) this.storedEntries = entries;
    this.storedRevision = read.revision;
    if (this.commandState !== undefined) {
      this.commandState.entries = [...entries];
      if (read.revision !== undefined) this.commandState.revision = read.revision;
      return this.commandState.entries;
    }
    return entries;
  }

  private async commitEntryBatch(
    access: FoldSdkAccessContext,
    input: readonly FoldLogEntry[],
  ): Promise<readonly FoldLogEntry[]> {
    const parsed = input.map(({ event, status }) => {
      validateStatus(status);
      const candidate = parseEvent(event);
      validateMemoryEnvelope(candidate);
      validateMemoryCandidateEnvelope(candidate);
      validateTrajectoryEnvelope(candidate);
      validateActivityEventEnvelope(candidate);
      validateIntentionEventEnvelope(candidate);
      validateTranscriptEventEnvelope(candidate);
      assertCanAppendEvent(candidate, access);
      return { event: candidate, status };
    });
    const entries = await this.readStoredEntries();
    const added: FoldLogEntry[] = [];
    for (const entry of parsed) {
      const existing = [...entries, ...added].find(({ event }) => event.id === entry.event.id);
      if (existing !== undefined) {
        if (canonicalJson(existing) !== canonicalJson(entry)) {
          throw new FoldSdkConflictError(`event id is already used: ${entry.event.id}`);
        }
      } else added.push(entry);
    }
    validateProducerOrder([...entries, ...added].map(({ event }) => event));
    const canonicalEvents = sortLog([...entries, ...added]).filter(({ status }) => status === "canon").map(({ event }) => event);
    // Raw append and domain commands share the same invariant checks before any durable write.
    if (added.some(({ event, status }) => status === "canon" && MEMORY_EVENT_KINDS.has(event.kind))) rebuildMemories(canonicalEvents);
    if (added.some(({ event, status }) => status === "canon" && event.kind.startsWith("memory.candidate-"))) rebuildMemoryCandidates(canonicalEvents);
    if (added.some(({ event, status }) => status === "canon" && TRAJECTORY_EVENT_KINDS.has(event.kind))) rebuildTrajectories(canonicalEvents);
    if (added.some(({ event, status }) => status === "canon" && event.kind.startsWith("transcript."))) rebuildTranscriptCatalog(canonicalEvents);
    if (this.commandState === undefined) throw new FoldSdkError("append requires a command boundary");
    this.commandState.staged.push(...added);
    entries.push(...added);
    for (const entry of added) this.clearProjectionCachesFor(entry.event);
    return parsed;
  }

  private async appendInternal(access: FoldSdkAccessContext, event: FoldEvent, status: FoldLogEntry["status"]): Promise<FoldLogEntry> {
    return (await this.commitEntryBatch(access, [{ event, status }]))[0]!;
  }

  private async appendSequenceInternal(access: FoldSdkAccessContext, events: readonly FoldEvent[]): Promise<readonly FoldEvent[]> {
    return (await this.commitEntryBatch(access, events.map((event) => ({ event, status: "canon" })))).map(({ event }) => event);
  }

  append(
    access: FoldSdkAccessContext,
    event: FoldEvent,
    status: FoldLogEntry["status"] = "canon",
  ): Promise<FoldLogEntry> {
    return this.command(access, "append", event.id, { event, status }, () => this.appendInternal(access, event, status));
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
    const cacheKey = transcriptCatalogCacheKey(access);
    const cached = this.memoryProjections.get(cacheKey);
    if (cached !== undefined && this.store.stableReads === true) return cached;
    await this.readStoredEntries();
    if (cached !== undefined && this.projectionCacheIsCurrent(cached.revision)) return cached;
    const entries = await this.entriesForAccess(access, { include: "canon" });
    const events = entries.map((entry) => entry.event);
    const result = { events, projection: rebuildMemories(events), ...(this.storedRevision === undefined ? {} : { revision: this.storedRevision }) };
    this.memoryProjections.set(cacheKey, result);
    return result;
  }

  private async memoryCandidateProjection(
    access: FoldSdkAccessContext,
  ): Promise<{ readonly events: readonly FoldEvent[]; readonly projection: MemoryCandidateProjection }> {
    const cacheKey = transcriptCatalogCacheKey(access);
    const cached = this.candidateProjections.get(cacheKey);
    if (cached !== undefined && this.store.stableReads === true) return cached;
    await this.readStoredEntries();
    if (cached !== undefined && this.projectionCacheIsCurrent(cached.revision)) return cached;
    const entries = await this.entriesForAccess(access, { include: "canon" });
    const events = entries.map((entry) => entry.event);
    const result = { events, projection: rebuildMemoryCandidates(events), ...(this.storedRevision === undefined ? {} : { revision: this.storedRevision }) };
    this.candidateProjections.set(cacheKey, result);
    return result;
  }

  private async trajectoryProjection(
    access: FoldSdkAccessContext,
  ): Promise<{ readonly events: readonly FoldEvent[]; readonly state: TrajectoryState }> {
    const entries = await this.entriesForAccess(access, { include: "canon" });
    const events = entries.map((entry) => entry.event);
    return { events, state: rebuildTrajectories(events) };
  }

  private async transcriptProjection(access: FoldSdkAccessContext): Promise<TranscriptCatalog> {
    const cacheKey = transcriptCatalogCacheKey(access);
    const cached = this.transcriptCatalogs.get(cacheKey);
    if (this.store.stableReads === true && cached !== undefined) return cached.catalog;
    await this.readStoredEntries();
    if (cached !== undefined && this.projectionCacheIsCurrent(cached.revision)) return cached.catalog;
    const entries = await this.entriesForAccess(access, { include: "canon" });
    const catalog = rebuildTranscriptCatalog(entries.map((entry) => entry.event));
    this.transcriptCatalogs.set(cacheKey, {
      catalog,
      ...(this.storedRevision === undefined ? {} : { revision: this.storedRevision }),
    });
    return catalog;
  }

  transcriptProjects(
    access: FoldSdkAccessContext,
  ): Promise<readonly TranscriptProjectSummary[]> {
    return this.enqueue(async () => {
      const catalog = await this.transcriptProjection(access);
      return [...catalog.projects.values()]
        .map((project): TranscriptProjectSummary => {
          const runs = [...catalog.runs.values()].filter((run) =>
            run.projectId === project.id || run.segments.some((segment) => segment.projectId === project.id),
          );
          const lastRunAt = runs
            .flatMap((run) => run.endedAt ?? run.startedAt ?? [])
            .sort((left, right) => right.localeCompare(left))[0];
          return {
            project,
            runCount: runs.length,
            ...(lastRunAt === undefined ? {} : { lastRunAt }),
          };
        })
        .sort((left, right) =>
          (right.lastRunAt ?? "").localeCompare(left.lastRunAt ?? "") ||
          left.project.name.localeCompare(right.project.name),
        );
    });
  }

  transcriptRuns(
    access: FoldSdkAccessContext,
    filters: TranscriptRunFilters = {},
  ): Promise<readonly TranscriptRun[]> {
    return this.enqueue(async () => {
      const catalog = await this.transcriptProjection(access);
      return [...catalog.runs.values()]
        .filter((run) => filters.source === undefined || run.source === filters.source)
        .filter((run) => filters.projectId === undefined ||
          run.projectId === filters.projectId ||
          run.segments.some((segment) => segment.projectId === filters.projectId))
        .sort((left, right) =>
          (right.endedAt ?? right.startedAt ?? "").localeCompare(left.endedAt ?? left.startedAt ?? "") ||
          left.id.localeCompare(right.id),
        );
    });
  }

  transcriptRun(
    access: FoldSdkAccessContext,
    runId: string,
  ): Promise<TranscriptRunDetail | undefined> {
    return this.enqueue(async () => {
      const catalog = await this.transcriptProjection(access);
      const run = catalog.runs.get(runId);
      if (run === undefined) return undefined;
      const artifact = catalog.artifacts.get(run.artifactId);
      if (artifact === undefined) throw new FoldSdkError(`transcript run ${runId} has no artifact`);
      const projectIds = new Set([
        ...(run.projectId === undefined ? [] : [run.projectId]),
        ...run.segments.flatMap((segment) => segment.projectId ?? []),
      ]);
      return {
        run,
        artifact,
        projects: [...projectIds].flatMap((projectId) => {
          const project = catalog.projects.get(projectId);
          return project === undefined ? [] : [project];
        }),
        chunks: catalog.chunksByRun.get(run.id) ?? [],
      };
    });
  }

  importTranscript(
    context: FoldSdkTranscriptContext,
    input: unknown,
    options: TranscriptImportOptions,
  ): Promise<TranscriptImportResult> {
    return this.command(context.access, "importTranscript", options.importId, { context, input, options }, async () => {
      const bundle = transcriptImportBundleSchema.parse(input);
      if (options.importId.trim().length === 0) {
        throw new FoldSdkError("transcript import id must not be empty");
      }
      if (!Number.isSafeInteger(options.importedAt) || options.importedAt < 0) {
        throw new FoldSdkError("transcript importedAt must be a nonnegative safe integer");
      }

      const entries = await this.entriesForAccess(context.access, { include: "canon" });
      const events = entries.map((entry) => entry.event);
      const cacheKey = transcriptCatalogCacheKey(context.access);
      const cachedCatalog = this.transcriptCatalogs.get(cacheKey);
      const catalog = this.store.stableReads === true && cachedCatalog !== undefined
        ? cachedCatalog.catalog
        : rebuildTranscriptCatalog(events);
      if (this.store.stableReads === true) this.transcriptCatalogs.set(cacheKey, { catalog });
      const same = (left: unknown, right: unknown): boolean =>
        JSON.stringify(left) === JSON.stringify(right);
      const assertSame = <T>(existing: T | undefined, candidate: T, label: string): boolean => {
        if (existing === undefined) return false;
        if (!same(existing, candidate)) {
          throw new FoldSdkConflictError(`${label} changed after import`);
        }
        return true;
      };

      const records: Array<
        | { readonly type: "project"; readonly value: TranscriptProject }
        | { readonly type: "artifact"; readonly value: typeof bundle.artifact }
        | { readonly type: "run"; readonly value: TranscriptRun }
        | { readonly type: "chunk"; readonly value: TranscriptChunk }
      > = [];
      for (const project of bundle.projects) {
        if (!assertSame(catalog.projects.get(project.id), project, `transcript project ${project.id}`)) {
          records.push({ type: "project", value: project });
        }
      }
      if (!assertSame(catalog.artifacts.get(bundle.artifact.id), bundle.artifact, `transcript artifact ${bundle.artifact.id}`)) {
        records.push({ type: "artifact", value: bundle.artifact });
      }
      if (!assertSame(catalog.runs.get(bundle.run.id), bundle.run, `transcript run ${bundle.run.id}`)) {
        records.push({ type: "run", value: bundle.run });
      }
      const existingChunks = new Map(
        (catalog.chunksByRun.get(bundle.run.id) ?? []).map((chunk) => [chunk.sequence, chunk]),
      );
      for (const chunk of bundle.chunks) {
        if (!assertSame(existingChunks.get(chunk.sequence), chunk, `transcript run ${bundle.run.id} chunk ${chunk.sequence}`)) {
          records.push({ type: "chunk", value: chunk });
        }
      }
      if (records.length === 0) return { events: [], run: bundle.run };

      const maxT = events.reduce((maximum, event) => Math.max(maximum, event.at.t), -1);
      const firstT = Math.max(options.importedAt, maxT + 1);
      const worldDate = new Date(options.importedAt).toISOString().slice(0, 10);
      const newEvents = records.map((record, index) => {
        const stamp = {
          id: `${options.importId}:${String(index).padStart(6, "0")}`,
          t: firstT + index,
          worldDate,
        };
        if (record.type === "project") return makeTranscriptProjectEvent(context, stamp, record.value);
        if (record.type === "artifact") return makeTranscriptArtifactEvent(context, stamp, record.value);
        if (record.type === "run") return makeTranscriptRunEvent(context, stamp, record.value);
        return makeTranscriptChunkEvent(context, stamp, record.value);
      });

      const nextCatalog = extendTranscriptCatalog(catalog, newEvents);
      await this.appendSequenceInternal(context.access, newEvents);
      if (this.store.stableReads === true) this.transcriptCatalogs.set(cacheKey, { catalog: nextCatalog });
      return { events: newEvents, run: bundle.run };
    });
  }

  recordTrajectoryTree(
    context: TrajectoryEventContext,
    stamp: TrajectoryEventStamp,
    tree: TrajectoryTreeRecord["tree"],
  ): Promise<TrajectoryTreeMutationResult> {
    return this.command(context.access, "recordTrajectoryTree", stamp.id, { context, stamp, tree }, async () => {
      const event = makeTrajectoryTreeRecordedEvent(context, stamp, tree);
      const current = await this.trajectoryProjection(context.access);
      const currentTree = current.state.trees.get(tree.taskId);
      if (currentTree !== undefined) {
        const entries = await this.readStoredEntries();
        const existing = entries.find((entry) => entry.event.id === event.id);
        if (existing !== undefined && JSON.stringify(existing.event) === JSON.stringify(event)) {
          const record = trajectoryLogRecordsFromEvent(existing.event)[0];
          if (record?.recordType === "tree") return { event: existing.event, record };
        }
        if (JSON.stringify(currentTree.tree) === JSON.stringify(tree)) {
          const prior = [...entries].reverse().find((entry) =>
            trajectoryLogRecordsFromEvent(entry.event).some((record) =>
              record.recordType === "tree" && record.tree.taskId === tree.taskId
            )
          );
          const record = prior === undefined ? undefined : trajectoryLogRecordsFromEvent(prior.event)
            .find((candidate) => candidate.recordType === "tree" && candidate.tree.taskId === tree.taskId);
          if (prior !== undefined && record?.recordType === "tree") return { event: prior.event, record };
        }
        let additive = false;
        try {
          additive = isAdditiveTreeRevision(currentTree.tree, tree);
        } catch {
          additive = false;
        }
        if (!additive) {
          throw new FoldSdkConflictError(`trajectory tree revision is not additive for task ${tree.taskId}`);
        }
      }
      await this.appendInternal(context.access, event, "canon");
      const record = trajectoryLogRecordsFromEvent(event)[0];
      if (record?.recordType !== "tree") {
        throw new FoldSdkError(`trajectory tree event ${event.id} did not contain a tree record`);
      }
      return { event, record };
    });
  }

  recordTrajectory(
    context: TrajectoryEventContext,
    stamp: TrajectoryEventStamp,
    input: TrajectoryInput,
  ): Promise<TrajectoryMutationResult> {
    return this.command(context.access, "recordTrajectory", stamp.id, { context, stamp, input }, async () => {
      const current = await this.trajectoryProjection(context.access);
      const tree = current.state.trees.get(input.taskId)?.tree;
      if (tree === undefined) throw new TrajectoryTaskUnavailableError(input.taskId);
      const event = makeTrajectoryRecordedEvent(context, stamp, tree, input);
      if (current.state.trajectories.has(input.id)) {
        const entries = await this.readStoredEntries();
        const existing = entries.find((entry) => entry.event.id === event.id);
        if (existing !== undefined && JSON.stringify(existing.event) === JSON.stringify(event)) {
          const record = trajectoryLogRecordsFromEvent(existing.event)[0];
          if (record?.recordType === "trajectory") return { event: existing.event, record };
        }
        throw new FoldSdkConflictError(`trajectory already exists: ${input.id}`);
      }
      await this.appendInternal(context.access, event, "canon");
      const record = trajectoryLogRecordsFromEvent(event)[0];
      if (record?.recordType !== "trajectory") {
        throw new FoldSdkError(`trajectory event ${event.id} did not contain a trajectory record`);
      }
      return { event, record };
    });
  }

  trajectoryTasks(access: FoldSdkAccessContext): Promise<readonly TrajectoryTaskSummary[]> {
    return this.enqueue(async () => {
      const { state } = await this.trajectoryProjection(access);
      return [...state.trees.values()]
        .map((treeRecord): TrajectoryTaskSummary => {
          const records = [...state.trajectories.values()].filter(
            (record) => record.trajectory.taskId === treeRecord.tree.taskId,
          );
          return {
            taskId: treeRecord.tree.taskId,
            tree: treeRecord.tree,
            trajectoryCount: records.length,
            successCount: records.filter((record) => record.trajectory.outcome === "success").length,
            failureCount: records.filter((record) => record.trajectory.outcome === "failure").length,
            unknownCount: records.filter((record) => record.trajectory.outcome === "unknown").length,
            lastRecordedAt: records.reduce(
              (latest, record) => Math.max(latest, record.recordedAt),
              treeRecord.recordedAt,
            ),
          };
        })
        .sort((left, right) => right.lastRecordedAt - left.lastRecordedAt || left.taskId.localeCompare(right.taskId));
    });
  }

  trajectoryReport(
    access: FoldSdkAccessContext,
    taskId: string,
  ): Promise<TrajectoryTaskReport | undefined> {
    return this.enqueue(async () => {
      const { state } = await this.trajectoryProjection(access);
      return analyzeTrajectoryTask(state, taskId);
    });
  }

  recordActivitySignal(
    context: FoldSdkActivityContext,
    stamp: ActivityEventStamp,
    signal: TerminalManagerSignal,
  ): Promise<ActivityMutationResult> {
    return this.command(context.access, "recordActivitySignal", stamp.id, { context, stamp, signal }, async () => {
      const event = eventFromTerminalManagerSignal(context, stamp, signal);
      await this.appendInternal(context.access, event, "canon");
      return { event };
    });
  }

  fleetSnapshot(
    access: FoldSdkAccessContext,
    nowMs: number,
    options: FleetProjectionOptions = {},
  ): Promise<FleetReadModel> {
    return this.enqueue(async () => {
      const entries = await this.entriesForAccess(access, { include: "canon" });
      const snapshot = rebuildFleet(entries.map((entry) => entry.event), nowMs, options);
      return {
        rebuiltAt: snapshot.rebuiltAt,
        sessions: listFleetSessions(snapshot),
        recoveryActions: planOrphanRecovery(snapshot),
      };
    });
  }

  private async steeringEvents(access: FoldSdkAccessContext): Promise<readonly FoldEvent[]> {
    const entries = await this.entriesForAccess(access, { include: "canon" });
    return entries.map((entry) => entry.event);
  }

  private steeringSnapshotFromEvents(
    events: readonly FoldEvent[],
    actorId: string,
  ): SteeringSnapshot {
    const projection = rebuildIntentions(events, actorId);
    const driveSample = latestDriveSample(events, actorId);
    return {
      actorId,
      pendingCandidates: [...projection.pendingCandidates].sort(
        (left, right) => right.surfacedAtMs - left.surfacedAtMs || left.id.localeCompare(right.id),
      ),
      intentions: [...projection.intentions.values()].sort(
        (left, right) => right.formedAtMs - left.formedAtMs || left.id.localeCompare(right.id),
      ),
      recentDeclines: recentDeclines(projection),
      ...(driveSample === undefined ? {} : { driveSample }),
    };
  }

  steeringSnapshots(access: FoldSdkAccessContext): Promise<readonly SteeringSnapshot[]> {
    return this.enqueue(async () => {
      const events = await this.steeringEvents(access);
      const actors = new Set<string>();
      for (const event of events) {
        for (const record of intentionRecordsFromEvent(event)) actors.add(record.actorId);
      }
      return [...actors]
        .sort((left, right) => left.localeCompare(right))
        .map((actorId) => this.steeringSnapshotFromEvents(events, actorId));
    });
  }

  steeringSnapshot(
    access: FoldSdkAccessContext,
    actorId: string,
  ): Promise<SteeringSnapshot> {
    return this.enqueue(async () => {
      const events = await this.steeringEvents(access);
      return this.steeringSnapshotFromEvents(events, actorId);
    });
  }

  private async appendSteeringEvent(
    context: FoldSdkSteeringContext,
    event: FoldEvent,
  ): Promise<SteeringMutationResult> {
    const events = await this.steeringEvents(context.access);
    const steering = this.steeringSnapshotFromEvents([...events, event], context.actorId);
    await this.appendInternal(context.access, event, "canon");
    return { event, steering };
  }

  surfaceIntentionCandidate(
    context: FoldSdkSteeringContext,
    stamp: DriveEventStamp,
    input: Omit<SurfacedCandidate, "surfacedAtMs">,
    causedBy?: readonly string[],
  ): Promise<SteeringMutationResult> {
    return this.command(context.access, "surfaceIntentionCandidate", stamp.id, { context, stamp, input, causedBy }, () => this.appendSteeringEvent(
      context,
      makeIntentionSurfacedEvent(context, stamp, input, causedBy),
    ));
  }

  commitIntentionCandidate(
    context: FoldSdkSteeringContext,
    stamp: DriveEventStamp,
    candidateId: string,
    intentionId: string,
    causedBy?: readonly string[],
  ): Promise<SteeringMutationResult> {
    return this.command(context.access, "commitIntentionCandidate", stamp.id, { context, stamp, candidateId, intentionId, causedBy }, () => this.appendSteeringEvent(
      context,
      makeIntentionCommittedEvent(context, stamp, candidateId, intentionId, causedBy),
    ));
  }

  declineIntentionCandidate(
    context: FoldSdkSteeringContext,
    stamp: DriveEventStamp,
    candidateId: string,
    reason: string,
    causedBy?: readonly string[],
  ): Promise<SteeringMutationResult> {
    return this.command(context.access, "declineIntentionCandidate", stamp.id, { context, stamp, candidateId, reason, causedBy }, () => this.appendSteeringEvent(
      context,
      makeIntentionDeclinedEvent(context, stamp, candidateId, reason, causedBy),
    ));
  }

  recordIntentionAction(
    context: FoldSdkSteeringContext,
    stamp: DriveEventStamp,
    intentionId: string,
    causedBy?: readonly string[],
  ): Promise<SteeringMutationResult> {
    return this.command(context.access, "recordIntentionAction", stamp.id, { context, stamp, intentionId, causedBy }, () => this.appendSteeringEvent(
      context,
      makeIntentionActedEvent(context, stamp, intentionId, causedBy),
    ));
  }

  endIntention(
    context: FoldSdkSteeringContext,
    stamp: DriveEventStamp,
    intentionId: string,
    end: IntentionEnd,
    causedBy?: readonly string[],
  ): Promise<SteeringMutationResult> {
    return this.command(context.access, "endIntention", stamp.id, { context, stamp, intentionId, end, causedBy }, () => this.appendSteeringEvent(
      context,
      makeIntentionEndedEvent(context, stamp, intentionId, end, causedBy),
    ));
  }

  recordMemory(
    context: EpistemicEventContext,
    stamp: EpistemicEventStamp,
    input: MemoryInput,
    causedBy?: readonly string[],
  ): Promise<MemoryMutationResult> {
    return this.command(context.access, "recordMemory", stamp.id, { context, stamp, input, causedBy }, async () => {
      const current = await this.memoryProjection(context.access);
      if (current.projection.memories.has(input.id) || current.projection.forgotten.has(input.id)) {
        throw new FoldSdkConflictError(`memory already exists: ${input.id}`);
      }
      const event = makeMemoryRecordedEvent(context, stamp, input, causedBy);
      await this.appendInternal(context.access, event, "canon");
      const record = memoryLogRecordsFromEvent(event)[0];
      if (record?.recordType !== "recorded") {
        throw new FoldSdkError(`memory event ${event.id} did not contain a recorded memory`);
      }
      return { event, memory: record.memory };
    });
  }

  proposeMemoryCandidate(
    context: EpistemicEventContext,
    stamp: EpistemicEventStamp,
    input: MemoryCandidateInput,
    causedBy?: readonly string[],
  ): Promise<MemoryCandidateMutationResult> {
    return this.command(context.access, "proposeMemoryCandidate", stamp.id, { context, stamp, input, causedBy }, async () => {
      const current = await this.memoryCandidateProjection(context.access);
      if (current.projection.candidates.has(input.id)) {
        throw new FoldSdkConflictError(`memory candidate already exists: ${input.id}`);
      }
      const event = makeMemoryCandidateProposedEvent(context, stamp, input, causedBy);
      await this.appendInternal(context.access, event, "canon");
      const record = memoryCandidateLogRecordsFromEvent(event)[0];
      if (record?.recordType !== "proposed") {
        throw new FoldSdkError(`candidate event ${event.id} did not contain a proposal`);
      }
      return { event, candidate: record.candidate };
    });
  }

  proposeMemoryCandidates(
    context: EpistemicEventContext,
    proposals: readonly {
      readonly stamp: EpistemicEventStamp;
      readonly input: MemoryCandidateInput;
      readonly causedBy?: readonly string[];
    }[],
  ): Promise<readonly MemoryCandidateMutationResult[]> {
    return this.command(context.access, "proposeMemoryCandidates", proposals.map(({ stamp }) => stamp.id), { context, proposals }, async () => {
      if (proposals.length === 0 || proposals.length > 100) {
        throw new FoldSdkError("memory candidate batch must contain 1 to 100 proposals");
      }
      const current = await this.memoryCandidateProjection(context.access);
      const ids = new Set(current.projection.candidates.keys());
      const events = proposals.map((proposal) => {
        if (ids.has(proposal.input.id)) {
          throw new FoldSdkConflictError(`memory candidate already exists: ${proposal.input.id}`);
        }
        ids.add(proposal.input.id);
        return makeMemoryCandidateProposedEvent(context, proposal.stamp, proposal.input, proposal.causedBy);
      });
      rebuildMemoryCandidates([...current.events, ...events]);
      await this.appendSequenceInternal(context.access, events);
      return events.map((event) => {
        const record = memoryCandidateLogRecordsFromEvent(event)[0];
        if (record?.recordType !== "proposed") {
          throw new FoldSdkError(`candidate event ${event.id} did not contain a proposal`);
        }
        return { event, candidate: record.candidate };
      });
    });
  }

  memoryCandidates(
    access: FoldSdkAccessContext,
    options: MemoryCandidateListOptions = {},
  ) {
    return this.enqueue(async () => {
      const { projection } = await this.memoryCandidateProjection(access);
      const requestedProjects = new Set(options.projectIds ?? []);
      const filtered = listMemoryCandidateViews(projection)
        .filter((view) => options.status === undefined || view.status === options.status)
        .filter((view) => requestedProjects.size === 0 || view.candidate.projectIds.length === 0 || view.candidate.projectIds.some((id) => requestedProjects.has(id)));
      const offset = options.offset ?? 0;
      return options.limit === undefined
        ? filtered.slice(offset)
        : filtered.slice(offset, offset + options.limit);
    });
  }

  acceptMemoryCandidate(
    context: EpistemicEventContext,
    decisionStamp: EpistemicEventStamp,
    memoryStamp: EpistemicEventStamp,
    candidateId: string,
    memoryId: string,
  ): Promise<MemoryCandidateAcceptanceResult> {
    return this.command(context.access, "acceptMemoryCandidate", [decisionStamp.id, memoryStamp.id], { context, decisionStamp, memoryStamp, candidateId, memoryId }, async () => {
      const current = await this.memoryCandidateProjection(context.access);
      const candidate = current.projection.candidates.get(candidateId);
      if (candidate === undefined || current.projection.decisions.has(candidateId)) {
        throw new FoldSdkConflictError(`memory candidate is unavailable: ${candidateId}`);
      }
      const decisionEvent = makeMemoryCandidateAcceptedEvent(context, decisionStamp, candidate, memoryId);
      const memoryEvent = makeMemoryRecordedEvent(context, memoryStamp, {
        id: memoryId,
        ...(candidate.spaceId === undefined ? {} : { spaceId: candidate.spaceId }),
        audience: candidate.audience,
        projectIds: candidate.projectIds,
        source: candidate.source,
        summary: candidate.summary,
        content: candidate.content,
        tags: candidate.tags,
        entities: candidate.entities,
        evidence: candidate.evidence,
      }, [candidate.proposalEventId, decisionEvent.id]);
      rebuildMemoryCandidates([...current.events, decisionEvent]);
      const memoryProjection = rebuildMemories([...current.events, decisionEvent, memoryEvent]);
      await this.appendSequenceInternal(context.access, [decisionEvent, memoryEvent]);
      const decisionRecord = memoryCandidateLogRecordsFromEvent(decisionEvent)[0];
      const memory = memoryProjection.memories.get(memoryId);
      if (decisionRecord?.recordType !== "accepted" || memory === undefined) {
        throw new FoldSdkError(`candidate ${candidateId} acceptance did not produce a memory`);
      }
      return { decisionEvent, memoryEvent, decision: decisionRecord.decision as Extract<typeof decisionRecord.decision, { kind: "accepted" }>, memory };
    });
  }

  acceptMemoryCandidates(
    context: EpistemicEventContext,
    acceptances: readonly MemoryCandidateAcceptanceInput[],
  ): Promise<readonly MemoryCandidateAcceptanceResult[]> {
    return this.command(context.access, "acceptMemoryCandidates", acceptances.map(({ decisionStamp, memoryStamp }) => [decisionStamp.id, memoryStamp.id]), { context, acceptances }, async () => {
      if (acceptances.length === 0 || acceptances.length > 100) {
        throw new FoldSdkError("memory candidate acceptance batch must contain 1 to 100 items");
      }
      const current = await this.memoryCandidateProjection(context.access);
      const acceptedIds = new Set<string>();
      const memoryIds = new Set<string>();
      const generated = acceptances.map((acceptance) => {
        const candidate = current.projection.candidates.get(acceptance.candidateId);
        if (
          candidate === undefined ||
          current.projection.decisions.has(acceptance.candidateId) ||
          acceptedIds.has(acceptance.candidateId)
        ) {
          throw new FoldSdkConflictError(`memory candidate is unavailable: ${acceptance.candidateId}`);
        }
        if (memoryIds.has(acceptance.memoryId)) {
          throw new FoldSdkConflictError(`accepted memory ID is duplicated: ${acceptance.memoryId}`);
        }
        acceptedIds.add(acceptance.candidateId);
        memoryIds.add(acceptance.memoryId);
        const decisionEvent = makeMemoryCandidateAcceptedEvent(
          context,
          acceptance.decisionStamp,
          candidate,
          acceptance.memoryId,
        );
        const memoryEvent = makeMemoryRecordedEvent(context, acceptance.memoryStamp, {
          id: acceptance.memoryId,
          ...(candidate.spaceId === undefined ? {} : { spaceId: candidate.spaceId }),
          audience: candidate.audience,
          projectIds: candidate.projectIds,
          source: candidate.source,
          summary: candidate.summary,
          content: candidate.content,
          tags: candidate.tags,
          entities: candidate.entities,
          evidence: candidate.evidence,
        }, [candidate.proposalEventId, decisionEvent.id]);
        return { candidate, memoryId: acceptance.memoryId, decisionEvent, memoryEvent };
      });
      const events = generated.flatMap(({ decisionEvent, memoryEvent }) => [decisionEvent, memoryEvent]);
      rebuildMemoryCandidates([...current.events, ...generated.map(({ decisionEvent }) => decisionEvent)]);
      const memoryProjection = rebuildMemories([...current.events, ...events]);
      await this.appendSequenceInternal(context.access, events);
      return generated.map(({ candidate, memoryId, decisionEvent, memoryEvent }) => {
        const decisionRecord = memoryCandidateLogRecordsFromEvent(decisionEvent)[0];
        const memory = memoryProjection.memories.get(memoryId);
        if (decisionRecord?.recordType !== "accepted" || memory === undefined) {
          throw new FoldSdkError(`candidate ${candidate.id} acceptance did not produce a memory`);
        }
        return {
          decisionEvent,
          memoryEvent,
          decision: decisionRecord.decision as Extract<typeof decisionRecord.decision, { kind: "accepted" }>,
          memory,
        };
      });
    });
  }

  rejectMemoryCandidate(
    context: EpistemicEventContext,
    stamp: EpistemicEventStamp,
    candidateId: string,
    reason: string,
  ): Promise<MemoryCandidateRejectionResult> {
    return this.command(context.access, "rejectMemoryCandidate", stamp.id, { context, stamp, candidateId, reason }, async () => {
      const current = await this.memoryCandidateProjection(context.access);
      const candidate = current.projection.candidates.get(candidateId);
      if (candidate === undefined || current.projection.decisions.has(candidateId)) {
        throw new FoldSdkConflictError(`memory candidate is unavailable: ${candidateId}`);
      }
      const event = makeMemoryCandidateRejectedEvent(context, stamp, candidate, reason);
      rebuildMemoryCandidates([...current.events, event]);
      await this.appendInternal(context.access, event, "canon");
      const record = memoryCandidateLogRecordsFromEvent(event)[0];
      if (record?.recordType !== "rejected") {
        throw new FoldSdkError(`candidate event ${event.id} did not contain a rejection`);
      }
      return { event, decision: record.decision as Extract<typeof record.decision, { kind: "rejected" }> };
    });
  }

  reviseMemory(
    context: EpistemicEventContext,
    stamp: EpistemicEventStamp,
    memoryId: string,
    patch: MemoryRevisionPatch,
    causedBy?: readonly string[],
  ): Promise<MemoryMutationResult> {
    return this.command(context.access, "reviseMemory", stamp.id, { context, stamp, memoryId, patch, causedBy }, async () => {
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

  recordMemoryFeedback(
    context: EpistemicEventContext,
    stamp: EpistemicEventStamp,
    memoryId: string,
    input: MemoryFeedbackInput,
    causedBy?: readonly string[],
  ): Promise<MemoryFeedbackResult> {
    return this.command(context.access, "recordMemoryFeedback", stamp.id, { context, stamp, memoryId, input, causedBy }, async () => {
      const current = await this.memoryProjection(context.access);
      const memory = recallProjectedMemoryById(current.projection, context.access, memoryId);
      if (memory === undefined) throw new PersonalMemoryUnavailableError(memoryId);
      const event = makeMemoryFeedbackEvent(context, stamp, memory, input, causedBy);
      await this.appendInternal(context.access, event, "canon");
      const feedback = memoryFeedbackRecordsFromEvent(event)[0];
      if (feedback === undefined) throw new FoldSdkError(`memory feedback event ${event.id} was empty`);
      return { event, feedback };
    });
  }

  forgetMemory(
    context: EpistemicEventContext,
    stamp: EpistemicEventStamp,
    memoryId: string,
    reason: string,
    causedBy?: readonly string[],
  ): Promise<MemoryForgetResult> {
    return this.command(context.access, "forgetMemory", stamp.id, { context, stamp, memoryId, reason, causedBy }, async () => {
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

  recallMemoryPage(
    access: FoldSdkAccessContext,
    request: Omit<RecallRequest, "limit" | "candidates"> & {
      readonly limit?: number;
      readonly cursor?: MemoryPageCursor;
    } = {},
  ): Promise<MemoryPage> {
    return this.enqueue(async () => {
      const { limit = MAX_RECALL_LIMIT, cursor, ...filters } = request;
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RECALL_LIMIT) {
        throw new FoldSdkError(`memory page limit must be an integer within [1, ${MAX_RECALL_LIMIT}]`);
      }
      if (cursor !== undefined && (!Number.isFinite(cursor.createdAt) || cursor.memoryId.trim().length === 0)) {
        throw new FoldSdkError("memory page cursor is invalid");
      }
      const { projection } = await this.memoryProjection(access);
      const corpus = recallMemoryCorpus(projection, access, filters);
      const remaining = cursor === undefined
        ? corpus
        : corpus.filter((memory) =>
          memory.createdAt < cursor.createdAt ||
          (memory.createdAt === cursor.createdAt && memory.id > cursor.memoryId)
        );
      const page = remaining.slice(0, limit);
      const last = page.at(-1);
      return {
        memories: page.map((memory) => ({ memory })),
        total: corpus.length,
        ...(last !== undefined && remaining.length > page.length
          ? { nextCursor: { createdAt: last.createdAt, memoryId: last.id } }
          : {}),
      };
    });
  }

  rankMemories(
    access: FoldSdkAccessContext,
    request: RankedMemoryRecallRequest,
    ranker: MemoryRanker,
  ): Promise<RankedMemoryRecallResult> {
    return this.enqueue(async () => {
      const query = request.query.trim();
      if (query.length === 0 || query.length > 500) {
        throw new FoldSdkError("memory ranking query must contain 1 to 500 characters");
      }
      if (ranker.descriptor.id.trim().length === 0) {
        throw new FoldSdkError("memory ranker id must not be empty");
      }

      const { query: _query, limit, ...filters } = request;
      const requestedLimit = limit ?? DEFAULT_RECALL_LIMIT;
      if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > MAX_RECALL_LIMIT) {
        throw new FoldSdkError(`memory ranking limit must be an integer within [1, ${MAX_RECALL_LIMIT}]`);
      }
      const { projection } = await this.memoryProjection(access);
      const corpus = recallMemoryCorpus(projection, access, filters);
      const candidates = await ranker.rank({
        ...(access.organizationId === undefined ? {} : { organizationId: access.organizationId }),
        workspaceId: access.workspaceId,
        query,
        limit: requestedLimit,
        documents: corpus.map((memory) => ({
          memoryId: memory.id,
          source: memory.source,
          summary: memory.summary,
          content: memory.content,
          tags: memory.tags,
          entities: memory.entities,
          createdAt: memory.createdAt,
          updatedAt: memory.updatedAt,
          revision: memory.revision,
        })),
      });
      if (candidates.length > MAX_RECALL_LIMIT) {
        throw new FoldSdkError(`memory ranker returned more than ${MAX_RECALL_LIMIT} candidates`);
      }
      const memories = recallProjectedMemories(projection, access, {
        ...filters,
        ...(limit === undefined ? {} : { limit }),
        candidates,
      });
      return {
        memories,
        ranking: { ...ranker.descriptor, corpusSize: corpus.length },
      };
    });
  }

  /** Mutation routing can retain scope after forgetting, without exposing forgotten content. */
  memoryMutationScope(access: FoldSdkAccessContext, memoryId: string): Promise<Pick<PersonalMemory, "audience" | "spaceId"> | undefined> {
    return this.enqueue(async () => {
      const entries = await this.entriesForAccess(access, { include: "canon" });
      for (const { event } of entries) {
        const record = memoryLogRecordsFromEvent(event)[0];
        if (record?.recordType === "recorded" && record.memory.id === memoryId) {
          return { audience: record.memory.audience, ...(record.memory.spaceId === undefined ? {} : { spaceId: record.memory.spaceId }) };
        }
      }
      return undefined;
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
