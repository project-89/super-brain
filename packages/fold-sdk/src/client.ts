import {
  fold,
  continueFold,
  forkAt,
  parseEvent,
  sortLog,
  validateProducerOrder,
  type FoldEvent,
  type FoldLogEntry,
} from "@_89/fold";
import { performance } from "node:perf_hooks";
import { EpisodeService } from "./episodes.js";
import { episodeWindowFromEvent, type EpisodePublication, type EpisodeWindowInput } from "@_89/fold-epistemic";
import {
  matchesMemoryProjects,
  makeMemoryForgottenEvent,
  makeMemoryFeedbackEvent,
  makeMemoryCandidateAcceptedEvent,
  makeMemoryCandidateEvidenceAddedEvent,
  equivalentMemoryCandidateMeaning,
  candidateSupportSourceMatches,
  mergeMemoryCandidateEvidence,
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
  type MemoryCandidate,
  type MemoryCandidateProjection,
  type MemoryProjection,
  type MemoryRevisionPatch,
  type RecallRequest,
  type RecalledMemory,
  type PersonalMemory,
} from "@_89/fold-epistemic";
import {
  analyzeTrajectoryTask,
  effectiveTrajectoryRecord,
  makeTrajectoryOutcomeRecordedEvent,
  makeTrajectoryRecordedEvent,
  makeTrajectoryTreeRecordedEvent,
  rebuildTrajectories,
  continueTrajectories,
  trajectoryLogRecordsFromEvent,
  type TrajectoryEventContext,
  type TrajectoryEventStamp,
  type TrajectoryInput,
  type TrajectoryOutcomeInput,
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
  canonicalProjectId,
  identityRecordFromEvent,
  identityRevisionEventId,
  makeIdentityEvent,
  rebuildIdentities,
  resolveProjectIds,
  type IdentityInput,
  type ProjectAliasInput,
  makeTranscriptChunkEvent,
  makeTranscriptProjectEvent,
  makeTranscriptRunEvent,
  extendTranscriptCatalog,
  rebuildTranscriptCatalog,
  transcriptImportBundleSchema,
  validateTranscriptEventEnvelope,
  derivationRecordFromEvent,
  derivationHash,
  makeTranscriptDerivationEvent,
  transcriptDerivationManifestSchema,
  transcriptDerivationChunkSchema,
  type TranscriptDerivationManifest,
  type TranscriptDerivationChunk,
  type TranscriptDerivationRecord,
  type TranscriptCatalog,
  type TranscriptChunk,
  type TranscriptProject,
  type TranscriptRun,
} from "@_89/fold-transcript";

import { assertCanAppendEvent, authorizeEventAccess, FoldSdkAccessError } from "./access.js";
import { identitySnapshotFromEvents, projectAliasPreview } from "./identity.js";
import type {
  FoldSdkAccessContext,
  FoldSdkActivityContext,
  FoldSdkSteeringContext,
  FoldSdkListOptions,
  FoldSdkProjectOptions,
  FoldSdkProjection,
  FoldSdkSystemProjection,
  FoldSdkReadOptions,
  FoldSdkStore,
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
  "trajectory.outcome-recorded",
  "trajectory.tree-recorded",
  "trajectory.recorded",
]);
const MEMORY_RECORD_TYPE_BY_KIND = {
  "memory.recorded": "recorded",
  "memory.revised": "revised",
  "memory.forgotten": "forgotten",
} as const;
const TRAJECTORY_RECORD_TYPE_BY_KIND = {
  "trajectory.outcome-recorded": "outcome",
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

let lastDerivationAt = 0;
function derivationTimestamp(events: readonly FoldEvent[]): number {
  const clock = performance.timeOrigin + performance.now();
  const next = events.reduce((latest, event) => Math.max(latest, event.at.t + 1), Math.max(clock, lastDerivationAt + 0.001));
  // Avoid ties with the capture clock's integer-millisecond timestamps.
  lastDerivationAt = Number.isInteger(next) ? next + 0.5 : next;
  return lastDerivationAt;
}

export class FoldSdk {
  private queue: Promise<void> = Promise.resolve();
  private storedEntries: FoldLogEntry[] | undefined;
  private storedRevision: string | undefined;
  private readonly validatedStoredEvents = new WeakMap<FoldEvent, FoldEvent>();
  private readonly trajectoryProjections = new Map<string, { readonly revision?: string; readonly events: readonly FoldEvent[]; readonly state: TrajectoryState }>();
  private readonly transcriptDerivationRecords = new WeakMap<FoldEvent, TranscriptDerivationRecord>();
  private readonly transcriptCatalogs = new Map<string, { readonly revision?: string; readonly catalog: TranscriptCatalog }>();
  private readonly memoryProjections = new Map<string, { readonly revision?: string; readonly events: readonly FoldEvent[]; readonly projection: MemoryProjection }>();
  private readonly candidateProjections = new Map<string, { readonly revision?: string; readonly events: readonly FoldEvent[]; readonly projection: MemoryCandidateProjection }>();
  private readonly identityProjections = new Map<string, { readonly revision?: string; readonly projection: ReturnType<typeof rebuildIdentities> }>();
  private readonly systemProjections = new Map<string, { readonly entries: readonly FoldLogEntry[]; readonly projection: FoldSdkSystemProjection }>();

  constructor(private readonly store: FoldSdkStore) {}

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

  private async refreshRevisionAfterAppend(): Promise<void> {
    // An independently queried head can include another writer not present in our cached entries.
    this.storedRevision = this.store.stableReads === true && this.store.revision !== undefined
      ? await this.store.revision()
      : undefined;
  }

  private clearProjectionCachesFor(event: FoldEvent): void {
    if (event.kind.startsWith("identity.")) this.identityProjections.clear();
    if (event.kind.startsWith("transcript.")) this.transcriptCatalogs.clear();
    if (event.kind.startsWith("memory.")) this.memoryProjections.clear();
    if (event.kind.startsWith("memory.candidate-")) this.candidateProjections.clear();
  }

  private async readStoredEntries(): Promise<FoldLogEntry[]> {
    if (this.store.stableReads === true && this.storedEntries !== undefined) {
      return this.storedEntries;
    }
    const read = await this.store.read({ missing: "empty" });
    if (
      read.revision !== undefined &&
      this.storedEntries !== undefined &&
      read.revision === this.storedRevision
    ) {
      return this.storedEntries;
    }
    const entries = read.entries.map((entry) => {
      validateStatus(entry.status);
      const prior = this.store.immutableEventReferences === true ? this.validatedStoredEvents.get(entry.event) : undefined;
      if (prior !== undefined) return { event: prior, status: entry.status };
      const event = parseEvent(entry.event);
      validateMemoryEnvelope(event);
      validateMemoryCandidateEnvelope(event);
      validateTrajectoryEnvelope(event);
      validateActivityEventEnvelope(event);
      validateIntentionEventEnvelope(event);
      validateTranscriptEventEnvelope(event);
      identityRecordFromEvent(event);
      episodeWindowFromEvent(event);
      if (this.store.immutableEventReferences === true) this.validatedStoredEvents.set(entry.event, event);
      return { event, status: entry.status };
    });
    validateProducerOrder(entries.map((entry) => entry.event));
    if (this.store.stableReads === true || read.revision !== undefined) this.storedEntries = entries;
    this.storedRevision = read.revision;
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
    validateMemoryCandidateEnvelope(parsed);
    validateTrajectoryEnvelope(parsed);
    validateActivityEventEnvelope(parsed);
    validateIntentionEventEnvelope(parsed);
    validateTranscriptEventEnvelope(parsed);
    identityRecordFromEvent(parsed);
    episodeWindowFromEvent(parsed);
    assertCanAppendEvent(parsed, access);
    if (this.store.appendValidated !== undefined) {
      const entry = { event: parsed, status } as const;
      const result = await this.store.appendValidated(entry);
      if (result === "appended") {
        this.storedEntries?.push(entry);
        this.clearProjectionCachesFor(parsed);
        await this.refreshRevisionAfterAppend();
      }
      return entry;
    }
    const entries = await this.readStoredEntries();
    const existing = entries.find((entry) => entry.event.id === parsed.id);
    if (existing !== undefined) {
      if (existing.status === status && JSON.stringify(existing.event) === JSON.stringify(parsed)) {
        return existing;
      }
      throw new FoldSdkConflictError(`event id is already used: ${parsed.id}`);
    }
    validateProducerOrder([...entries.map((entry) => entry.event), parsed]);
    const entry = { event: parsed, status } as const;
    await this.store.append(entry);
    this.storedEntries?.push(entry);
    await this.refreshRevisionAfterAppend();
    this.clearProjectionCachesFor(parsed);
    return entry;
  }

  private async appendSequenceInternal(
    access: FoldSdkAccessContext,
    events: readonly FoldEvent[],
  ): Promise<readonly FoldEvent[]> {
    const parsed = events.map((event) => {
      const candidate = parseEvent(event);
      validateMemoryEnvelope(candidate);
      validateMemoryCandidateEnvelope(candidate);
      validateTrajectoryEnvelope(candidate);
      validateActivityEventEnvelope(candidate);
      validateIntentionEventEnvelope(candidate);
      validateTranscriptEventEnvelope(candidate);
      identityRecordFromEvent(candidate);
      if (episodeWindowFromEvent(candidate) !== undefined) throw new FoldSdkAccessError("Episodes require the episode publication API");
      assertCanAppendEvent(candidate, access);
      return candidate;
    });
    if (parsed.length === 0) return parsed;
    if (this.store.appendManyValidated !== undefined) {
      validateProducerOrder(parsed);
      const appended = parsed.map((event) => ({ event, status: "canon" as const }));
      await this.store.appendManyValidated(appended);
      this.storedEntries?.push(...appended);
      for (const event of parsed) this.clearProjectionCachesFor(event);
      await this.refreshRevisionAfterAppend();
      return parsed;
    }
    const entries = await this.readStoredEntries();
    validateProducerOrder([...entries.map((entry) => entry.event), ...parsed]);
    const appended = parsed.map((event) => ({ event, status: "canon" as const }));
    if (this.store.appendMany === undefined) {
      for (const entry of appended) await this.store.append(entry);
    } else {
      await this.store.appendMany(appended);
    }
    for (const entry of appended) {
      this.storedEntries?.push(entry);
      this.clearProjectionCachesFor(entry.event);
    }
    await this.refreshRevisionAfterAppend();
    return parsed;
  }

  append(
    access: FoldSdkAccessContext,
    event: FoldEvent,
    status: FoldLogEntry["status"] = "canon",
  ): Promise<FoldLogEntry> {
    return this.enqueue(() => {
      if (identityRecordFromEvent(event) !== undefined) throw new FoldSdkAccessError("Identity records require the reviewed identity mutation API");
      if (episodeWindowFromEvent(event) !== undefined) throw new FoldSdkAccessError("Episodes require the episode publication API");
      if (event.kind === "memory.candidate-evidence-added") throw new FoldSdkAccessError("Candidate support requires the candidate evidence API");
      return this.appendInternal(access, event, status);
    });
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

  systemProjection(access: FoldSdkAccessContext, include: "canon" | "canon+draft" = "canon"): Promise<FoldSdkSystemProjection> {
    return this.enqueue(async () => {
      validateAccessContext(access);
      validateReadOptions({ include });
      if (this.store.systemProjection !== undefined) return this.store.systemProjection(access, include);
      const entries = await this.entriesForAccess(access, { include });
      const key = JSON.stringify([access.organizationId, include, transcriptCatalogCacheKey(access)]);
      const previous = this.systemProjections.get(key);
      const prefix = previous !== undefined && previous.entries.length <= entries.length && previous.entries.every((entry, index) =>
        entry.event === entries[index]!.event && entry.status === entries[index]!.status);
      if (prefix && previous.entries.length === entries.length) return previous.projection;
      const options = { include: "canon+draft", existingCreate: "replace", retainApplied: false, validatedInput: true, orderedInput: true } as const;
      const state = prefix ? continueFold({
        nodes: new Map(previous.projection.state.nodes), values: new Map(previous.projection.state.values),
        edges: new Map(previous.projection.state.edges), redirects: new Map(previous.projection.state.redirects),
        diagnostics: [...previous.projection.state.diagnostics], appliedEvents: [], appliedChanges: [],
      }, entries.slice(previous.entries.length), options) : fold(entries, options);
      const projection = {
        state,
        appliedEventCount: entries.length,
        appliedChangeCount: entries.reduce((count, entry) => count + entry.event.changes.length, 0),
      };
      this.systemProjections.delete(key);
      this.systemProjections.set(key, { entries, projection });
      while (this.systemProjections.size > 4) this.systemProjections.delete(this.systemProjections.keys().next().value!);
      return projection;
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
    validateAccessContext(access);
    const key = JSON.stringify([access.organizationId, transcriptCatalogCacheKey(access)]);
    const cached = this.trajectoryProjections.get(key);
    await this.readStoredEntries();
    if (cached?.revision !== undefined && cached.revision === this.storedRevision) return cached;
    const entries = await this.entriesForAccess(access, { include: "canon" });
    const events = entries.map((entry) => entry.event).filter((event) => TRAJECTORY_EVENT_KINDS.has(event.kind));
    const extendsPrefix = cached !== undefined && events.length >= cached.events.length &&
      cached.events.every((event, index) => events[index] === event);
    const state = extendsPrefix
      ? continueTrajectories(cached.state, events.slice(cached.events.length))
      : rebuildTrajectories(events);
    const result = { events, state, ...(this.storedRevision === undefined ? {} : { revision: this.storedRevision }) };
    this.trajectoryProjections.delete(key);
    this.trajectoryProjections.set(key, result);
    while (this.trajectoryProjections.size > 16) this.trajectoryProjections.delete(this.trajectoryProjections.keys().next().value!);
    return result;
  }

  private async transcriptProjection(access: FoldSdkAccessContext): Promise<TranscriptCatalog> {
    const cacheKey = transcriptCatalogCacheKey(access);
    const cached = this.transcriptCatalogs.get(cacheKey);
    if (this.store.stableReads === true && cached !== undefined) return cached.catalog;
    await this.readStoredEntries();
    if (cached !== undefined && this.projectionCacheIsCurrent(cached.revision)) return cached.catalog;
    const entries = await this.entriesForAccess(access, { include: "canon" });
    const catalog = rebuildTranscriptCatalog(entries.map((entry) => entry.event).filter((event) => !event.kind.startsWith("transcript.derivation")));
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
      const projectIds = await this.expandedProjects(access, filters.projectId === undefined ? undefined : [filters.projectId]);
      return [...catalog.runs.values()]
        .filter((run) => filters.source === undefined || run.source === filters.source)
        .filter((run) => projectIds === undefined ||
          (run.projectId !== undefined && projectIds.includes(run.projectId)) ||
          run.segments.some((segment) => segment.projectId !== undefined && projectIds.includes(segment.projectId)))
        .sort((left, right) => {
          const leftAt = left.endedAt ?? left.startedAt ?? "";
          const rightAt = right.endedAt ?? right.startedAt ?? "";
          return leftAt < rightAt ? 1 : leftAt > rightAt ? -1 : left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
        });
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

  transcriptReprocessingSources(access: FoldSdkAccessContext) {
    return this.enqueue(async () => {
      const catalog = await this.transcriptProjection(access);
      return [...catalog.runs.values()].map((run) => ({ run, artifact: catalog.artifacts.get(run.artifactId)! }));
    });
  }

  private transcriptDerivationRecord(event: FoldEvent): TranscriptDerivationRecord | undefined {
    if (!event.kind.startsWith("transcript.derivation")) return undefined;
    const cached = this.transcriptDerivationRecords.get(event);
    if (cached !== undefined) return cached;
    const record = derivationRecordFromEvent(event);
    if (record !== undefined) this.transcriptDerivationRecords.set(event, record);
    return record;
  }

  transcriptDerivations(access: FoldSdkAccessContext, runId: string) {
    return this.enqueue(async () => {
      const catalog = await this.transcriptProjection(access);
      if (!catalog.runs.has(runId)) throw new FoldSdkError("Transcript run is unavailable");
      const entries = await this.entriesForAccess(access, { include: "canon" });
      const records = entries.flatMap(({ event }) => {
        const record = this.transcriptDerivationRecord(event);
        return record === undefined ? [] : [{ record, eventId: event.id, recordedAt: event.at.t }];
      });
      return records.flatMap(({ record, eventId, recordedAt }) => {
        if (record.recordType !== "derivation" || record.manifest.runId !== runId) return [];
        const chunks = records.flatMap(({ record: item }) => item.recordType === "derivation-chunk" && item.chunk.derivationId === record.derivationId ? [item.chunk] : []).sort((a, b) => a.sequence - b.sequence);
        let ordinal = 0;
        for (const [sequence, chunk] of chunks.entries()) {
          if (chunk.runId !== runId || chunk.sequence !== sequence || derivationHash(chunk.records) !== record.manifest.chunkHashes[sequence] || chunk.records.some((item) => item.ordinal !== ordinal++)) throw new FoldSdkConflictError("Stored derivation chunks failed integrity validation");
        }
        if (chunks.length === record.manifest.chunkHashes.length && ordinal !== record.manifest.records) throw new FoldSdkConflictError("Stored derivation record total is invalid");
        return [{ ...record, eventId, recordedAt, complete: chunks.length === record.manifest.chunkHashes.length, chunks }];
      });
    });
  }

  recordTranscriptDerivation(context: FoldSdkTranscriptContext, input: { readonly manifest: TranscriptDerivationManifest } | { readonly chunk: TranscriptDerivationChunk }) {
    return this.enqueue(async () => {
      const entries = await this.entriesForAccess(context.access, { include: "canon" });
      const events = entries.map(({ event }) => event);
      const catalog = rebuildTranscriptCatalog(events.filter((event) => !event.kind.startsWith("transcript.derivation")));
      let record: TranscriptDerivationRecord;
      if ("manifest" in input) {
        const manifest = transcriptDerivationManifestSchema.parse(input.manifest);
        record = { recordType: "derivation", derivationId: derivationHash(manifest), manifest };
      } else record = { recordType: "derivation-chunk", chunk: transcriptDerivationChunkSchema.parse(input.chunk) };
      const runId = record.recordType === "derivation" ? record.manifest.runId : record.chunk.runId;
      const run = catalog.runs.get(runId);
      const artifact = run === undefined ? undefined : catalog.artifacts.get(run.artifactId);
      const sourceEvent = events.find((event) => event.kind === "transcript.run-imported" && event.changes.some((change) => change.verb === "create" && change.after.run !== null && typeof change.after.run === "object" && !Array.isArray(change.after.run) && change.after.run.id === runId));
      if (run === undefined || artifact === undefined || sourceEvent === undefined) throw new FoldSdkError("Transcript run is unavailable");
      const prior = events.flatMap((event) => { const value = this.transcriptDerivationRecord(event); return value === undefined ? [] : [{ event, record: value }]; });
      if (record.recordType === "derivation") {
        const manifest = record.manifest;
        const policy = { contentPolicy: artifact.contentPolicy, ...(artifact.reasoningPolicy === undefined ? {} : { reasoningPolicy: artifact.reasoningPolicy }), ...(artifact.encryptedReasoningPolicy === undefined ? {} : { encryptedReasoningPolicy: artifact.encryptedReasoningPolicy }), ...(artifact.anonymizationPolicy === undefined ? {} : { anonymizationPolicy: artifact.anonymizationPolicy }) };
        if (!artifact.stored || artifact.contentPolicy !== "redacted" || manifest.artifactId !== run.artifactId || manifest.sourceSha256 !== artifact.sha256 || derivationHash(manifest.policy) !== derivationHash(policy)) throw new FoldSdkError("Derivation source or retention policy does not match the imported artifact");
        if ((manifest.records === 0) !== (manifest.chunkHashes.length === 0)) throw new FoldSdkError("Derivation record and chunk counts disagree");
        if (Object.values(manifest.byKind).reduce((sum, count) => sum + count, 0) !== manifest.records) throw new FoldSdkError("Derivation evidence counts disagree");
      } else {
        const chunk = record.chunk;
        const parent = prior.find(({ record: item }) => item.recordType === "derivation" && item.derivationId === chunk.derivationId)?.record;
        if (parent?.recordType !== "derivation" || parent.manifest.runId !== runId) throw new FoldSdkError("Derivation manifest is unavailable");
        if (parent.manifest.chunkHashes[chunk.sequence] !== derivationHash(chunk.records)) throw new FoldSdkConflictError("Derivation chunk checksum does not match its manifest");
        const earlier = prior.flatMap(({ record: item }) => item.recordType === "derivation-chunk" && item.chunk.derivationId === chunk.derivationId && item.chunk.sequence < chunk.sequence ? [item.chunk] : []);
        if (earlier.length !== chunk.sequence) throw new FoldSdkConflictError("Derivation chunks must arrive in order");
        const offset = earlier.reduce((sum, item) => sum + item.records.length, 0);
        if (chunk.records.some((item, index) => item.ordinal !== offset + index)) throw new FoldSdkConflictError("Derived record ordinals must be contiguous");
        if (chunk.sequence === parent.manifest.chunkHashes.length - 1 && offset + chunk.records.length !== parent.manifest.records) throw new FoldSdkConflictError("Derivation record total does not match its manifest");
      }
      const key = record.recordType === "derivation" ? `${record.derivationId}:manifest` : `${record.chunk.derivationId}:${record.chunk.sequence}`;
      const eventId = `transcript-derivation:${key}`;
      const existing = prior.find(({ event }) => event.id === eventId);
      if (existing !== undefined) {
        if (derivationHash(existing.record) !== derivationHash(record)) throw new FoldSdkConflictError("Derivation changed after recording");
        return { imported: false, eventId };
      }
      const t = derivationTimestamp(events);
      const event = makeTranscriptDerivationEvent({
        author: context.author,
        capture: { ...sourceEvent.capture, identity: { ...sourceEvent.capture.identity, principal: context.access.principalId, derivation: record.recordType === "derivation" ? record.derivationId : record.chunk.derivationId } },
      }, { id: eventId, t, worldDate: new Date(t).toISOString().slice(0, 10) }, record);
      await this.appendInternal(context.access, event, "canon");
      return { imported: true, eventId };
    });
  }

  importTranscript(
    context: FoldSdkTranscriptContext,
    input: unknown,
    options: TranscriptImportOptions,
  ): Promise<TranscriptImportResult> {
    return this.enqueue(async () => {
      const incoming = transcriptImportBundleSchema.parse(input);
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
      const existingRun = catalog.runs.get(incoming.run.id);
      const bundle = existingRun === undefined || same(existingRun, incoming.run)
        ? incoming
        : (() => {
            if (
              existingRun.source !== incoming.run.source ||
              existingRun.nativeId !== incoming.run.nativeId ||
              existingRun.artifactId === incoming.run.artifactId
            ) {
              throw new FoldSdkConflictError(`transcript run ${incoming.run.id} changed after import`);
            }
            const suffix = `:snapshot:${incoming.artifact.sha256.slice(0, 16)}`;
            const snapshotId = `${incoming.run.id.slice(0, 500 - suffix.length)}${suffix}`;
            return transcriptImportBundleSchema.parse({
              ...incoming,
              run: {
                ...incoming.run,
                id: snapshotId,
                snapshotOfRunId: incoming.run.id,
              },
              chunks: incoming.chunks.map((chunk) => ({ ...chunk, runId: snapshotId })),
            });
          })();
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
      const eventContext = bundle.run.id === context.capture.identity?.run
        ? context
        : {
            ...context,
            capture: {
              ...context.capture,
              identity: { ...context.capture.identity, run: bundle.run.id },
            },
          };
      const newEvents = records.map((record, index) => {
        const stamp = {
          id: `${options.importId}:${String(index).padStart(6, "0")}`,
          t: firstT + index,
          worldDate,
        };
        if (record.type === "project") return makeTranscriptProjectEvent(eventContext, stamp, record.value);
        if (record.type === "artifact") return makeTranscriptArtifactEvent(eventContext, stamp, record.value);
        if (record.type === "run") return makeTranscriptRunEvent(eventContext, stamp, record.value);
        return makeTranscriptChunkEvent(eventContext, stamp, record.value);
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
    return this.enqueue(async () => {
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
      const last = current.events.at(-1);
      if (last !== undefined && (event.at.t < last.at.t || (event.at.t === last.at.t && event.id < last.id))) {
        try { rebuildTrajectories(sortLog([...current.events, event].map((item) => ({ event: item, status: "canon" as const }))).map((entry) => entry.event)); }
        catch { throw new FoldSdkConflictError(`trajectory tree revision conflicts with source-ordered history for task ${tree.taskId}`); }
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
    return this.enqueue(async () => {
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

  recordTrajectoryOutcome(
    context: TrajectoryEventContext,
    stamp: TrajectoryEventStamp,
    input: TrajectoryOutcomeInput,
  ) {
    return this.enqueue(async () => {
      const current = await this.trajectoryProjection(context.access);
      const run = current.state.trajectories.get(input.trajectoryId);
      if (run === undefined || run.trajectory.taskId !== input.taskId) {
        throw new TrajectoryTaskUnavailableError(input.taskId);
      }
      // A review inherits the run's visibility, never the caller's requested scope.
      const scopedContext = {
        ...context,
        capture: {
          scope: { workspace: run.workspaceId, ...(run.spaceId === undefined ? {} : { space: run.spaceId }) },
          identity: { principal: context.access.principalId, workspace: run.workspaceId },
        },
      };
      const event = makeTrajectoryOutcomeRecordedEvent(scopedContext, stamp, input);
      const existing = current.events.find((candidate) => candidate.id === event.id);
      const record = trajectoryLogRecordsFromEvent(event)[0];
      if (record?.recordType !== "outcome") throw new FoldSdkError("missing trajectory outcome record");
      if (existing !== undefined) {
        if (JSON.stringify(existing) === JSON.stringify(event)) return { event: existing, record };
        throw new FoldSdkConflictError(`event id is already used: ${event.id}`);
      }
      const previous = current.state.outcomes.get(input.trajectoryId)?.at(-1)?.eventId ?? null;
      if (previous !== input.previousEventId) throw new FoldSdkConflictError("Outcome changed; reload before reviewing again");
      const previousTime = current.state.outcomes.get(input.trajectoryId)?.at(-1)?.recordedAt ?? run.recordedAt;
      if (stamp.t <= previousTime) throw new FoldSdkConflictError("Outcome review must be later than the run and its previous review");
      await this.appendInternal(context.access, event, "canon");
      return { event, record };
    });
  }

  trajectoryOutcomes(access: FoldSdkAccessContext, taskId: string, trajectoryId: string) {
    return this.enqueue(async () => {
      const { state } = await this.trajectoryProjection(access);
      if (state.trajectories.get(trajectoryId)?.trajectory.taskId !== taskId) {
        throw new TrajectoryTaskUnavailableError(taskId);
      }
      return state.outcomes.get(trajectoryId) ?? [];
    });
  }

  trajectoryTasks(access: FoldSdkAccessContext): Promise<readonly TrajectoryTaskSummary[]> {
    return this.enqueue(async () => {
      const { state } = await this.trajectoryProjection(access);
      return [...state.trees.values()]
        .map((treeRecord): TrajectoryTaskSummary => {
          const records = [...state.trajectories.values()].filter(
            (record) => record.trajectory.taskId === treeRecord.tree.taskId,
          ).map((record) => effectiveTrajectoryRecord(state, record));
          return {
            taskId: treeRecord.tree.taskId,
            tree: treeRecord.tree,
            trajectoryCount: records.length,
            successCount: records.filter((record) => record.trajectory.outcome === "success").length,
            failureCount: records.filter((record) => record.trajectory.outcome === "failure").length,
            unknownCount: records.filter((record) => record.trajectory.outcome === "unknown").length,
            lastRecordedAt: records.reduce(
              (latest, record) => Math.max(latest, record.recordedAt, record.outcomeReview?.recordedAt ?? 0),
              treeRecord.recordedAt,
            ),
          };
        })
        .sort((left, right) => right.lastRecordedAt - left.lastRecordedAt || left.taskId.localeCompare(right.taskId));
    });
  }

  trajectoryTree(access: FoldSdkAccessContext, taskId: string): Promise<TrajectoryTreeRecord | undefined> {
    return this.enqueue(async () => (await this.trajectoryProjection(access)).state.trees.get(taskId));
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
    return this.enqueue(async () => {
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
    return this.enqueue(() => this.appendSteeringEvent(
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
    return this.enqueue(() => this.appendSteeringEvent(
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
    return this.enqueue(() => this.appendSteeringEvent(
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
    return this.enqueue(() => this.appendSteeringEvent(
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
    return this.enqueue(() => this.appendSteeringEvent(
      context,
      makeIntentionEndedEvent(context, stamp, intentionId, end, causedBy),
    ));
  }

  private episodeService(access: FoldSdkAccessContext) {
    return new EpisodeService(() => this.readStoredEntries(), async id => this.store.eventById === undefined ? (await this.readStoredEntries()).find(entry => entry.event.id === id) : this.store.eventById(id), event => this.appendInternal(access, event, "canon"), access);
  }

  episodeSources(access: FoldSdkAccessContext, eventIds: readonly string[], publication: EpisodePublication, options: { readonly maxBytes?: number } = {}) { return this.enqueue(() => this.episodeService(access).sources(eventIds, publication, options)); }
  workEpisodes(access: FoldSdkAccessContext) { return this.enqueue(() => this.episodeService(access).list()); }
  workEpisode(access: FoldSdkAccessContext, episodeId: string) { return this.enqueue(() => this.episodeService(access).get(episodeId)); }
  episodeHistory(access: FoldSdkAccessContext, episodeId: string) { return this.enqueue(() => this.episodeService(access).history(episodeId)); }
  episodeWindow(access: FoldSdkAccessContext, windowId: string) { return this.enqueue(() => this.episodeService(access).window(windowId)); }
  episodeWindows(access: FoldSdkAccessContext) { return this.enqueue(() => this.episodeService(access).windows()); }
  publishEpisodeWindow(context: { readonly access: FoldSdkAccessContext; readonly author: EpistemicEventContext["author"] }, input: EpisodeWindowInput) { return this.enqueue(() => this.episodeService(context.access).publish(context.author, input)); }

  private async identityEvents(access: FoldSdkAccessContext): Promise<FoldEvent[]> {
    return (await this.entriesForAccess(access, { include: "canon" })).map(({ event }) => event);
  }

  private async expandedProjects(access: FoldSdkAccessContext, projectIds: readonly string[] | undefined): Promise<readonly string[] | undefined> {
    if (projectIds === undefined || projectIds.length === 0) return projectIds;
    const key = transcriptCatalogCacheKey(access);
    const cached = this.identityProjections.get(key);
    await this.readStoredEntries();
    if (cached !== undefined && this.projectionCacheIsCurrent(cached.revision)) return resolveProjectIds(cached.projection, projectIds);
    const projection = rebuildIdentities(await this.identityEvents(access));
    this.identityProjections.set(key, { projection, ...(this.storedRevision === undefined ? {} : { revision: this.storedRevision }) });
    while (this.identityProjections.size > 8) this.identityProjections.delete(this.identityProjections.keys().next().value!);
    return resolveProjectIds(projection, projectIds);
  }

  resolveProjectFilter(access: FoldSdkAccessContext, projectIds: readonly string[]) {
    return this.enqueue(async () => await this.expandedProjects(access, projectIds) ?? []);
  }

  identities(access: FoldSdkAccessContext) {
    return this.enqueue(async () => {
      const { projection, catalog, scope } = identitySnapshotFromEvents(await this.identityEvents(access), access.workspaceId);
      return { revision: projection.revision, scope, entities: [...projection.entities.values()], attributions: [...projection.attributions.values()], aliases: [...projection.aliases.values()], history: projection.history,
        projects: [...catalog.projects.values()].map(({ id, name }) => ({ id, name, canonicalProjectId: canonicalProjectId(projection, id) })) };
    });
  }

  previewProjectAlias(access: FoldSdkAccessContext, input: ProjectAliasInput) {
    return this.enqueue(async () => projectAliasPreview(await this.identityEvents(access), access.workspaceId, access.principalId, input));
  }

  reviseIdentity(context: { readonly access: FoldSdkAccessContext; readonly author: EpistemicEventContext["author"] },
    expectedRevision: string | null, operation: IdentityInput, previewToken?: string) {
    return this.enqueue(async () => {
      if (context.access.platformDataAccess === true || !["owner", "admin"].includes(context.access.workspaceRole) || context.author.kind !== "human" || context.author.id !== context.access.principalId) {
        throw new FoldSdkAccessError("Identity changes require a workspace administrator");
      }
      const events = await this.identityEvents(context.access);
      const projection = rebuildIdentities(events);
      const expectedId = identityRevisionEventId(context.access.workspaceId, expectedRevision);
      const existing = events.find(({ id }) => id === expectedId);
      if (existing !== undefined) {
        const record = identityRecordFromEvent(existing);
        if (record === undefined) throw new FoldSdkConflictError("Identity revision namespace is occupied by an invalid record");
        if (record.actorId !== context.access.principalId || derivationHash({ kind: record.kind, input: record.input }) !== derivationHash(operation)) throw new FoldSdkConflictError("Identity revision changed; reload and review again");
        return { event: existing, revision: projection.revision, record };
      }
      if (projection.revision !== expectedRevision) throw new FoldSdkConflictError("Identity revision changed; reload and review again");
      if (operation.kind === "project-alias") {
        const preview = projectAliasPreview(events, context.access.workspaceId, context.access.principalId, operation.input);
        if (preview.conflicts.length > 0) throw new FoldSdkConflictError(preview.conflicts.join("; "));
        if (previewToken !== preview.previewToken) throw new FoldSdkConflictError("Alias preview changed; preview the affected records again");
      }
      for (const id of operation.input.evidenceEventIds) {
        const known = events.find((event) => event.id === id);
        const entry = known === undefined ? await this.store.eventById?.(id) : { event: known, status: "canon" };
        if (entry?.status !== "canon" || !authorizeEventAccess(entry.event, context.access).allowed || entry.event.capture.scope.creator !== undefined || entry.event.capture.scope.space !== undefined) {
          throw new FoldSdkAccessError("Identity evidence must be available to the whole workspace");
        }
      }
      const t = Math.max(Date.now(), (projection.history.at(-1)?.recordedAt ?? 0) + 1);
      const event = makeIdentityEvent({ workspaceId: context.access.workspaceId, principalId: context.access.principalId, author: context.author }, { t, worldDate: new Date(t).toISOString().slice(0, 10) }, expectedRevision, operation);
      rebuildIdentities([...events, event]);
      await this.appendInternal(context.access, event, "canon");
      return { event, revision: event.id, record: identityRecordFromEvent(event)! };
    });
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

  proposeMemoryCandidate(
    context: EpistemicEventContext,
    stamp: EpistemicEventStamp,
    input: MemoryCandidateInput,
    causedBy?: readonly string[],
  ): Promise<MemoryCandidateMutationResult> {
    return this.enqueue(async () => {
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
    return this.enqueue(async () => {
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
      const projectIds = await this.expandedProjects(access, options.projectIds);
      const filtered = listMemoryCandidateViews(projection)
        .filter((view) => options.status === undefined || view.status === options.status)
        .filter((view) => matchesMemoryProjects(view.candidate, projectIds));
      const offset = options.offset ?? 0;
      return options.limit === undefined
        ? filtered.slice(offset)
        : filtered.slice(offset, offset + options.limit);
    });
  }

  addMemoryCandidateEvidence(
    context: EpistemicEventContext,
    stamp: EpistemicEventStamp,
    candidateId: string,
    incoming: MemoryCandidateInput,
  ): Promise<{ readonly event?: FoldEvent; readonly candidate: MemoryCandidate }> {
    return this.enqueue(async () => {
      const current = await this.memoryCandidateProjection(context.access);
      const candidate = current.projection.candidates.get(candidateId);
      if (candidate === undefined || current.projection.decisions.has(candidateId)) throw new FoldSdkConflictError("candidate support requires an undecided candidate");
      if (!equivalentMemoryCandidateMeaning(candidate, incoming)) throw new FoldSdkConflictError("candidate support meaning or scope differs; retain a separate proposal");
      const projectIds = await this.expandedProjects(context.access, candidate.projectIds) ?? [];
      const knownProjectIds = [...rebuildTranscriptCatalog(current.events.filter((event) => event.kind === "transcript.project-recorded")).projects.keys()];
      const events = new Map(current.events.map((event) => [event.id, event]));
      for (const reference of incoming.evidence) {
        const known = events.get(reference.eventId);
        const entry = known === undefined ? await this.store.eventById?.(reference.eventId) : { event: known, status: "canon" };
        const source = entry?.event;
        if (source === undefined || entry?.status !== "canon" || !authorizeEventAccess(source, context.access).allowed || !candidateSupportSourceMatches(candidate, reference, source, projectIds, knownProjectIds)) {
          throw new FoldSdkError("candidate support source is unavailable or incompatible with publication scope");
        }
      }
      const merged = mergeMemoryCandidateEvidence(candidate.evidence, incoming.evidence);
      if (merged.length === candidate.evidence.length) return { candidate };
      const event = makeMemoryCandidateEvidenceAddedEvent(context, stamp, candidate, incoming.evidence);
      const projection = rebuildMemoryCandidates([...current.events, event]);
      await this.appendInternal(context.access, event, "canon");
      return { event, candidate: projection.candidates.get(candidateId)! };
    });
  }

  acceptMemoryCandidate(
    context: EpistemicEventContext,
    decisionStamp: EpistemicEventStamp,
    memoryStamp: EpistemicEventStamp,
    candidateId: string,
    memoryId: string,
  ): Promise<MemoryCandidateAcceptanceResult> {
    return this.enqueue(async () => {
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
        ...(candidate.applicability === undefined ? {} : { applicability: candidate.applicability }),
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
    return this.enqueue(async () => {
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
          ...(candidate.applicability === undefined ? {} : { applicability: candidate.applicability }),
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
    return this.enqueue(async () => {
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

  recordMemoryFeedback(
    context: EpistemicEventContext,
    stamp: EpistemicEventStamp,
    memoryId: string,
    input: MemoryFeedbackInput,
    causedBy?: readonly string[],
  ): Promise<MemoryFeedbackResult> {
    return this.enqueue(async () => {
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
      const projectIds = await this.expandedProjects(access, request.projectIds);
      return recallProjectedMemories(projection, access, { ...request, ...(projectIds === undefined ? {} : { projectIds }) });
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
      const projectIds = await this.expandedProjects(access, filters.projectIds);
      const corpus = recallMemoryCorpus(projection, access, { ...filters, ...(projectIds === undefined ? {} : { projectIds }) });
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

      const { query: _query, limit, ...originalFilters } = request;
      const projectIds = await this.expandedProjects(access, originalFilters.projectIds);
      const filters = { ...originalFilters, ...(projectIds === undefined ? {} : { projectIds }) };
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
