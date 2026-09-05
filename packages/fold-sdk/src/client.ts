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
  makeMemoryEvidenceContributedEvent,
  makeMemoryCandidateEvidenceContributedEvent,
  memoryEvidenceContributionsFromEvent,
  assertCanWritePersonalMemory,
  assertCanReviewMemoryCandidate,
  memoryWriteAuthority,
  memoryValidity,
  type MemoryCandidateEvidence,
  type MemoryRevisionRef,
  type MemoryValidityInput,
  type MemoryEvidenceContributionInput,
  makeMemoryFeedbackEvent,
  normalizeMemoryFeedbackInputV2,
  summarizeMemoryFeedback,
  type MemoryFeedbackInputV2,
  type MemoryFeedbackRecord,
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
  taskEvidenceRecordsFromEvent, makeTaskEvidenceEvent, rebuildTaskEvidence, TASK_EVIDENCE_KINDS,
  taskVersionKey,
  TaskEvidenceError,
  assertTaskAcceptanceSource,
  type TaskEvidenceInput, type TaskEvidenceMutationResult, type TaskEvidenceAuthority, type TaskOutcomeInput, type TaskInterventionInput,
  type TaskManifest, type AttemptManifest, type AttemptContext, type TaskAcceptanceRef,
} from "@_89/fold-trajectory";
import { isAdditiveTreeRevision } from "@_89/fold-trace";
import type { EvaluationSourceSelectionRequest, EvaluationSourceSelection } from "./evaluation.js";
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
  transcriptRecordsFromEvent,
  makeTranscriptArtifactEvent,
  makeTranscriptChunkEvent,
  makeTranscriptProjectEvent,
  makeTranscriptRunEvent,
  extendTranscriptCatalog,
  rebuildTranscriptCatalog,
  transcriptImportBundleSchema,
  validateTranscriptEventEnvelope,
  validateTranscriptInterpretation,
  type TranscriptCatalog,
  type TranscriptChunk,
  type TranscriptProject,
  type TranscriptRun,
} from "@_89/fold-transcript";

import { FoldSdkAccessError, assertCanAppendEvent, authorizeEventAccess } from "./access.js";
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
  TranscriptEvidenceOrigin,
  TrajectoryMutationResult,
  TrajectoryTaskReport,
  TrajectoryTaskSummary,
  TrajectoryTreeMutationResult,
} from "./types.js";

const MEMORY_EVENT_KINDS = new Set([
  "memory.recorded",
  "memory.revised",
  "memory.forgotten",
  "memory.evidence-contributed",
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
  memoryEvidenceContributionsFromEvent(event);
  if (event.kind === "memory.evidence-contributed") return;
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
  if (taskEvidenceRecordsFromEvent(event).length > 0) {
    if (event.changes.length !== 1) throw new FoldSdkError("task evidence event requires one change");
    return;
  }
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

  private commandState: { entries?: FoldLogEntry[]; revision?: string; staged: FoldLogEntry[]; method: string } | undefined;
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
          for (const { event } of existing.entries) {
            assertCanAppendEvent(event, access);
            for (const feedback of memoryFeedbackRecordsFromEvent(event)) {
              if (!("version" in feedback)) throw new FoldSdkAccessError("legacy feedback cannot be replayed as a new command");
              this.feedbackMemory((await this.memoryProjection(access)).projection, access, feedback.memoryId, feedback.memoryRevision);
            }
            for (const record of taskEvidenceRecordsFromEvent(event)) assertCanWritePersonalMemory({ workspaceId: record.workspaceId, ...(record.spaceId === undefined ? {} : { spaceId: record.spaceId }), audience: "workspace", creatorId: record.actorId }, access);
            for (const record of memoryLogRecordsFromEvent(event)) assertCanWritePersonalMemory({ workspaceId: record.workspaceId, ...(record.spaceId === undefined ? {} : { spaceId: record.spaceId }), audience: record.audience, creatorId: record.actorId }, access);
            for (const contribution of memoryEvidenceContributionsFromEvent(event)) assertCanWritePersonalMemory({ ...contribution, creatorId: contribution.actorId }, access);
            for (const record of memoryCandidateLogRecordsFromEvent(event)) {
              if (record.recordType === "proposed") assertCanWritePersonalMemory({ ...record.candidate, creatorId: record.candidate.proposerId }, access);
              else {
                assertCanWritePersonalMemory({ ...record, creatorId: record.decision.actorId }, access);
                if (record.audience === "workspace" && access.workspaceRole !== "owner" && access.workspaceRole !== "admin") throw new FoldSdkAccessError("workspace candidate review requires an owner or admin role");
              }
            }
          }
          return existing.result as T;
        }
        const state: NonNullable<FoldSdk["commandState"]> = { staged: [], method };
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
      memoryFeedbackRecordsFromEvent(event);
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
      memoryFeedbackRecordsFromEvent(candidate);
      if (candidate.kind === "memory.feedback-recorded" && !["recordMemoryFeedback", "recordMemoryFeedbackBatch"].includes(this.commandState?.method ?? "")) throw new FoldSdkAccessError("feedback must use the validated feedback command");
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
    for (const { event, status } of added) if (status === "canon" && event.kind.startsWith("memory.")) this.validateMemoryReferences(access, event, canonicalEvents);
    for (const { event, status } of added) if (status === "canon" && event.kind.startsWith("trajectory.")) this.validateTaskReferences(access, event, canonicalEvents);
    for (const { event, status } of added) if (status === "canon" && event.kind.startsWith("transcript.")) {
      const contained = canonicalEvents.slice(0, canonicalEvents.findIndex((item) => item.id === event.id)).filter((source) => authorizeEventAccess(source, access).allowed && source.capture.scope.creator === undefined && (source.capture.scope.space === undefined || source.capture.scope.space === event.capture.scope.space));
      for (const record of transcriptRecordsFromEvent(event)) if (record.recordType === "run" && record.run.interpretation !== undefined) {
        const catalog = rebuildTranscriptCatalog(contained); const artifact = catalog.artifacts.get(record.run.artifactId);
        if (!artifact) throw new FoldSdkAccessError("reinterpretation artifact is unavailable in target scope");
        validateTranscriptInterpretation(record.run, artifact, catalog);
      }
    }
    // Raw append and domain commands share the same invariant checks before any durable write.
    if (added.some(({ event, status }) => status === "canon" && (MEMORY_EVENT_KINDS.has(event.kind) || event.kind === "memory.feedback-recorded"))) rebuildMemories(canonicalEvents);
    if (added.some(({ event, status }) => status === "canon" && event.kind.startsWith("memory.candidate-"))) rebuildMemoryCandidates(canonicalEvents);
    if (added.some(({ event, status }) => status === "canon" && event.kind.startsWith("trajectory."))) rebuildTrajectories(canonicalEvents);
    if (added.some(({ event, status }) => status === "canon" && event.kind.startsWith("transcript."))) rebuildTranscriptCatalog(canonicalEvents);
    if (this.commandState === undefined) throw new FoldSdkError("append requires a command boundary");
    this.commandState.staged.push(...added);
    entries.push(...added);
    for (const entry of added) this.clearProjectionCachesFor(entry.event);
    return parsed;
  }

  private validateMemoryReferences(access: FoldSdkAccessContext, event: FoldEvent, allEvents: readonly FoldEvent[]): void {
    const eventIndex = allEvents.findIndex(({ id }) => id === event.id);
    const before = allEvents.slice(0, eventIndex).filter((item) => authorizeEventAccess(item, access).allowed);
    const projection = rebuildMemories(before);
    const candidates = rebuildMemoryCandidates(before);
    type Scope = { workspaceId: string; spaceId?: string; audience: "personal" | "workspace"; creatorId: string };
    const contains = (source: FoldEvent["capture"]["scope"], target: Scope) => source.workspace === target.workspaceId && (source.space === undefined || source.space === target.spaceId) && (source.creator === undefined || (target.audience === "personal" && source.creator === target.creatorId));
    const assertEvidence = (target: Scope, evidence: readonly MemoryCandidateEvidence[]) => {
      if (evidence.length === 0) return;
      const catalog = rebuildTranscriptCatalog(before.filter((source) => contains(source.capture.scope, target)));
      for (const ref of evidence) {
        const source = before.find(({ id }) => id === ref.eventId);
        if (source === undefined || !contains(source.capture.scope, target)) throw new FoldSdkAccessError("memory evidence is unavailable in the target audience and space");
        const records = transcriptRecordsFromEvent(source);
        const run = ref.runId === undefined ? undefined : catalog.runs.get(ref.runId);
        if (ref.runId !== undefined && !(source.capture.identity?.run === ref.runId || (run !== undefined && records.some((record) => (record.recordType === "run" && record.run.id === ref.runId) || (record.recordType === "chunk" && record.chunk.runId === ref.runId) || (record.recordType === "artifact" && record.artifact.id === run.artifactId))))) throw new FoldSdkAccessError("memory evidence run does not match the cited event");
        if (ref.turnId !== undefined && source.capture.identity?.turn !== ref.turnId && !(ref.runId !== undefined && run !== undefined && (catalog.chunksByRun.get(ref.runId) ?? []).some((chunk) => chunk.turns.some((turn) => turn.id === ref.turnId)))) throw new FoldSdkAccessError("memory evidence turn does not match the cited event or run");
        if (ref.projectId !== undefined) {
          const turn = ref.runId === undefined || ref.turnId === undefined ? undefined : (catalog.chunksByRun.get(ref.runId) ?? []).flatMap((chunk) => chunk.turns).find(({ id }) => id === ref.turnId);
          const segments = run?.segments ?? [];
          const turnStart = turn?.startedAt === undefined ? undefined : Date.parse(turn.startedAt);
          const turnEnd = turn?.endedAt === undefined ? turnStart : Date.parse(turn.endedAt);
          const matchingSegments = turnStart === undefined ? segments : segments.filter((segment) => (segment.startedAt === undefined || Date.parse(segment.startedAt) <= (turnEnd ?? turnStart)) && (segment.endedAt === undefined || Date.parse(segment.endedAt) >= turnStart));
          const projectIds = new Set(matchingSegments.length ? matchingSegments.map(({ projectId }) => projectId).filter((id): id is string => id !== undefined) : run?.projectId === undefined ? [] : [run.projectId]);
          const transcriptMatch = run !== undefined && catalog.projects.has(ref.projectId) && projectIds.has(ref.projectId) && (ref.turnId === undefined || turnStart !== undefined || projectIds.size === 1);
          const liveMatch = records.length === 0 && (source.capture.identity?.repo === ref.projectId || (source.capture.identity?.repo === undefined && source.capture.identity?.project === ref.projectId));
          if (!liveMatch && !transcriptMatch && !records.some((record) => record.recordType === "project" && record.project.id === ref.projectId)) throw new FoldSdkAccessError("memory evidence project does not match its source turn or context segment");
        }
      }
    };
    const assertValidity = (target: Scope, input: MemoryValidityInput) => {
      const normalized = memoryValidity(input);
      for (const ref of [...normalized.sourceMemoryRefs, ...normalized.supersedes, ...normalized.contradicts]) {
        const source = projection.memories.get(ref.memoryId);
        if (source === undefined || source.revision !== ref.revision || !contains({ workspace: source.workspaceId, ...(source.spaceId === undefined ? {} : { space: source.spaceId }), ...(source.audience === "personal" ? { creator: source.creatorId } : {}) }, target)) throw new FoldSdkAccessError("source memory revision is unavailable in the target audience and space");
      }
    };
    for (const record of memoryLogRecordsFromEvent(event)) {
      const memory = record.recordType === "recorded" ? record.memory : projection.memories.get(record.memoryId);
      if (memory === undefined) throw new FoldSdkConflictError("memory mutation references an inactive memory");
      assertCanWritePersonalMemory(memory, access);
      if (record.actorId !== access.principalId || (record.recordType !== "recorded" && record.authority !== undefined && record.authority !== memoryWriteAuthority(memory, access))) throw new FoldSdkAccessError("memory mutation authority does not match its authenticated actor");
      if (record.recordType === "forgotten") continue;
      const input = record.recordType === "recorded" ? record.memory : record.patch;
      assertValidity(memory, input); assertEvidence(memory, input.evidence ?? []);
      if (record.recordType === "recorded" && record.memory.sourceCandidate !== undefined) {
        const source = candidates.candidates.get(record.memory.sourceCandidate.candidateId);
        if (source === undefined) throw new FoldSdkAccessError("source candidate is unavailable");
        assertEvidence(memory, source.evidence); assertValidity(memory, source);
      }
    }
    for (const record of memoryCandidateLogRecordsFromEvent(event)) {
      const candidate = record.recordType === "proposed" ? record.candidate : candidates.candidates.get(record.decision.candidateId);
      if (candidate === undefined) throw new FoldSdkConflictError("candidate is unavailable");
      const scope = { ...candidate, creatorId: candidate.proposerId };
      assertCanWritePersonalMemory(scope, access);
      if (record.recordType === "proposed" && candidate.proposerId !== access.principalId) throw new FoldSdkAccessError("candidate proposer does not match authenticated actor");
      if (record.recordType !== "proposed") assertCanReviewMemoryCandidate(candidate, access);
      if (record.recordType !== "proposed" && record.decision.actorId !== access.principalId) throw new FoldSdkAccessError("candidate decision actor does not match authenticated actor");
      if (record.recordType !== "rejected") { assertValidity(scope, candidate); assertEvidence(scope, candidate.evidence); }
    }
    for (const contribution of memoryEvidenceContributionsFromEvent(event)) {
      const scope = contribution.target === "memory" ? projection.memories.get(contribution.targetId) : (() => { const candidate = candidates.candidates.get(contribution.targetId); return candidate === undefined ? undefined : { ...candidate, creatorId: candidate.proposerId }; })();
      if (scope === undefined || contribution.actorId !== access.principalId) throw new FoldSdkAccessError("evidence contribution target or actor is unavailable");
      if (contribution.authority !== memoryWriteAuthority(scope, access)) throw new FoldSdkAccessError("evidence contribution authority does not match authenticated access");
      assertEvidence(scope, contribution.evidence);
    }
  }

  private validateTaskReferences(access: FoldSdkAccessContext, event: FoldEvent, allEvents: readonly FoldEvent[]): void {
    const before = allEvents.slice(0, allEvents.findIndex(({ id }) => id === event.id)).filter((source) => authorizeEventAccess(source, access).allowed);
    const target = event.capture.scope;
    const contains = (scope: FoldEvent["capture"]["scope"]) => scope.workspace === target.workspace && scope.creator === undefined && (scope.space === undefined || scope.space === target.space);
    const contained = before.filter((source) => contains(source.capture.scope));
    const taskState = rebuildTaskEvidence(contained);
    const visibleTaskState = rebuildTaskEvidence(before);
    const assertTask = (taskId: string, taskVersion: string) => {
      const key = taskVersionKey(taskId, taskVersion);
      if (visibleTaskState.tasks.has(key) && !taskState.tasks.has(key)) throw new FoldSdkAccessError("task specification is unavailable in target scope");
    };
    const sourceEvent = (id: string) => {
      const source = contained.find((item) => item.id === id);
      if (!source) throw new FoldSdkAccessError("task evidence source is unavailable in target scope");
      return source;
    };
    const assertContext = (context: AttemptContext | undefined) => {
      if (!context) return;
      const memories = rebuildMemories(before);
      for (const ref of context.memoryRefs ?? []) {
        const current = memories.memories.get(ref.memoryId);
        const source = current?.revision === ref.revision ? current : memories.revisions?.get(ref.memoryId)?.get(ref.revision);
        if (!current || !source || source.audience !== "workspace" || source.workspaceId !== target.workspace || (source.spaceId !== undefined && source.spaceId !== target.space)) throw new FoldSdkAccessError("task memory context revision is unavailable in target scope");
      }
      for (const lineage of context.lineage ?? []) {
        const source = sourceEvent(lineage.eventId);
        if (lineage.previousAttemptId !== undefined && !taskState.attempts.has(lineage.previousAttemptId)) throw new FoldSdkAccessError("context parent attempt is unavailable");
        if (lineage.previousTurnId !== undefined && source.capture.identity?.turn !== lineage.previousTurnId) throw new FoldSdkAccessError("context turn does not match its source");
      }
    };
    const assertAttempt = (attempt: AttemptManifest) => {
      assertTask(attempt.taskId, attempt.taskVersion);
      if (visibleTaskState.attempts.has(attempt.attemptId) && !taskState.attempts.has(attempt.attemptId)) throw new FoldSdkAccessError("attempt baseline is unavailable in target scope");
      if (attempt.parentAttemptId !== undefined && !taskState.attempts.has(attempt.parentAttemptId)) throw new FoldSdkAccessError("parent attempt is unavailable in target scope");
      assertContext(attempt.context);
      if (attempt.acceptance) {
        const source = sourceEvent(attempt.acceptance.eventId);
        assertTaskAcceptanceSource(attempt.acceptance, source);
      }
    };
    for (const record of trajectoryLogRecordsFromEvent(event)) if (record.recordType === "trajectory") {
      if (record.trajectory.manifest) assertAttempt(record.trajectory.manifest.attempt);
      for (const step of record.trajectory.steps) assertContext(step.context);
    }
    for (const record of taskEvidenceRecordsFromEvent(event)) {
      if (this.commandState?.method === "append") throw new FoldSdkAccessError("task evidence requires a dedicated authorized command");
      if (record.actorId !== access.principalId) throw new FoldSdkAccessError("task evidence actor mismatch");
      if (record.recordType === "task-manifest") assertTask(record.input.taskId, record.input.taskVersion);
      if (record.recordType === "attempt-manifest") assertAttempt(record.input as AttemptManifest);
      if (record.recordType === "outcome" || record.recordType === "intervention") {
        if (record.input.sourceEventId !== undefined) sourceEvent(record.input.sourceEventId);
        if (!taskState.attempts.has(record.input.attemptId)) throw new FoldSdkAccessError("task evidence attempt is unavailable in target scope");
        if (record.recordType === "outcome" && record.input.acceptance !== undefined) assertTaskAcceptanceSource(record.input.acceptance as TaskAcceptanceRef, sourceEvent(record.input.acceptance.eventId));
      }
    }
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
      const contained = events.filter((event) => event.capture.scope.creator === undefined && (event.capture.scope.space === undefined || event.capture.scope.space === context.capture.scope.space));
      validateTranscriptInterpretation(bundle.run, bundle.artifact, rebuildTranscriptCatalog(contained));
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

  transcriptEvidenceOrigins(access: FoldSdkAccessContext, refs: readonly MemoryCandidateEvidence[]): Promise<readonly TranscriptEvidenceOrigin[]> {
    return this.enqueue(async () => {
      if (refs.length > 100) throw new FoldSdkError("at most 100 transcript evidence origins may be resolved");
      const events = (await this.entriesForAccess(access, { include: "canon" })).map(({ event }) => event);
      const catalog = rebuildTranscriptCatalog(events);
      return refs.flatMap((reference): TranscriptEvidenceOrigin[] => {
        const source = events.find(({ id }) => id === reference.eventId);
        const run = reference.runId === undefined ? undefined : catalog.runs.get(reference.runId);
        if (!source || !run) return [];
        const sourceRecords = transcriptRecordsFromEvent(source);
        if (!sourceRecords.some((record) => (record.recordType === "run" && record.run.id === run.id) || (record.recordType === "chunk" && record.chunk.runId === run.id) || (record.recordType === "artifact" && record.artifact.id === run.artifactId))) return [];
        const turn = reference.turnId === undefined ? undefined : (catalog.chunksByRun.get(run.id) ?? []).flatMap((chunk) => chunk.turns).find(({ id }) => id === reference.turnId);
        if (reference.turnId !== undefined && turn === undefined) return [];
        const sourceOccurrenceId = run.interpretation?.sourceOccurrenceId ?? run.artifactId;
        const original = catalog.artifacts.get(run.interpretation?.sourceArtifactId ?? run.artifactId)!;
        // A caller-selected artifact ID or renamed source path cannot create independent corroboration.
        // This is conservative content-family equivalence, distinct from a witnessed live occurrence.
        const independenceKey = `transcript-source-family-v1:${original.source}:${original.sha256}`;
        return [{ reference, sourceOccurrenceId, ...(turn?.origin === undefined ? {} : { recordRanges: turn.origin.recordRanges }), independenceKey, verified: true }];
      });
    });
  }

  private recordTaskEvidence(context: TrajectoryEventContext, stamp: TrajectoryEventStamp, data: TaskEvidenceInput): Promise<TaskEvidenceMutationResult> {
    const identity = data.recordType === "outcome" && data.input.source !== undefined ? [data.input.source.providerId, data.input.source.deliveryId] : stamp.id;
    return this.command(context.access, `recordTaskEvidence:${data.recordType}`, identity, { context, stamp, data }, async () => {
      const event = makeTaskEvidenceEvent(context, stamp, data);
      await this.appendInternal(context.access, event, "canon");
      return { event, record: taskEvidenceRecordsFromEvent(event)[0]! };
    });
  }
  recordTaskManifest(context: TrajectoryEventContext, stamp: TrajectoryEventStamp, input: TaskManifest): Promise<TaskEvidenceMutationResult> {
    return this.recordTaskEvidence(context, stamp, { recordType: "task-manifest", input });
  }
  recordAttemptManifest(context: TrajectoryEventContext, stamp: TrajectoryEventStamp, input: AttemptManifest): Promise<TaskEvidenceMutationResult> {
    return this.recordTaskEvidence(context, stamp, { recordType: "attempt-manifest", input });
  }
  recordTaskOutcome(context: TrajectoryEventContext & { readonly evidenceAuthority: TaskEvidenceAuthority }, stamp: TrajectoryEventStamp, input: TaskOutcomeInput): Promise<TaskEvidenceMutationResult> {
    return this.recordTaskEvidence(context, stamp, { recordType: "outcome", input, authority: context.evidenceAuthority });
  }
  recordTaskIntervention(context: TrajectoryEventContext & { readonly evidenceAuthority: TaskEvidenceAuthority }, stamp: TrajectoryEventStamp, input: TaskInterventionInput): Promise<TaskEvidenceMutationResult> {
    return this.recordTaskEvidence(context, stamp, { recordType: "intervention", input, authority: context.evidenceAuthority });
  }
  taskEvidence(access: FoldSdkAccessContext, taskId: string): Promise<ReturnType<typeof rebuildTaskEvidence>> {
    return this.enqueue(async () => {
      const events = (await this.entriesForAccess(access, { include: "canon" })).map(({ event }) => event);
      const state = rebuildTaskEvidence(events);
      return { tasks: new Map([...state.tasks].filter(([, task]) => task.taskId === taskId)), attempts: new Map([...state.attempts].filter(([, attempt]) => attempt.taskId === taskId)), records: state.records.filter((record) => record.input.taskId === taskId) };
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
        ...memoryValidity(candidate, candidate.projectIds),
        sourceCandidate: { candidateId: candidate.id, revision: candidate.revision ?? 0, decisionEventId: decisionEvent.id },
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
          ...memoryValidity(candidate, candidate.projectIds),
        sourceCandidate: { candidateId: candidate.id, revision: candidate.revision ?? 0, decisionEventId: decisionEvent.id },
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
    expectedRevision?: number,
  ): Promise<MemoryMutationResult> {
    return this.command(context.access, "reviseMemory", stamp.id, { context, stamp, memoryId, patch, causedBy, expectedRevision }, async () => {
      const current = await this.memoryProjection(context.access);
      const memory = recallProjectedMemoryById(current.projection, context.access, memoryId);
      if (memory === undefined) throw new PersonalMemoryUnavailableError(memoryId);
      if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || memory.revision !== expectedRevision)) throw new FoldSdkConflictError("memory expected revision changed");
      const event = makeMemoryRevisedEvent(context, stamp, memory, patch, causedBy);
      await this.appendInternal(context.access, event, "canon");
      const next = rebuildMemories([...current.events, event]);
      const revised = recallProjectedMemoryById(next, context.access, memoryId);
      if (revised === undefined) throw new FoldSdkError(`memory ${memoryId} disappeared after revision`);
      return { event, memory: revised };
    });
  }

  contributeMemoryEvidence(context: EpistemicEventContext, stamp: EpistemicEventStamp, memoryId: string, input: MemoryEvidenceContributionInput): Promise<MemoryMutationResult> {
    return this.command(context.access, "contributeMemoryEvidence", stamp.id, { context, stamp, memoryId, input }, async () => {
      const current = await this.memoryProjection(context.access);
      const memory = recallProjectedMemoryById(current.projection, context.access, memoryId);
      if (memory === undefined) throw new PersonalMemoryUnavailableError(memoryId);
      if (input.expectedRevision !== undefined && memory.revision !== input.expectedRevision) throw new FoldSdkConflictError("memory evidence expected revision changed");
      const event = makeMemoryEvidenceContributedEvent(context, stamp, memory, input.evidence);
      await this.appendInternal(context.access, event, "canon");
      return { event, memory: rebuildMemories([...current.events, event]).memories.get(memoryId)! };
    });
  }

  contributeMemoryCandidateEvidence(context: EpistemicEventContext, stamp: EpistemicEventStamp, candidateId: string, input: Pick<MemoryEvidenceContributionInput, "evidence">): Promise<MemoryCandidateMutationResult> {
    return this.command(context.access, "contributeMemoryCandidateEvidence", stamp.id, { context, stamp, candidateId, input }, async () => {
      const current = await this.memoryCandidateProjection(context.access);
      const candidate = current.projection.candidates.get(candidateId);
      if (candidate === undefined || current.projection.decisions.has(candidateId)) throw new FoldSdkConflictError("evidence contributions require a pending candidate");
      const event = makeMemoryCandidateEvidenceContributedEvent(context, stamp, candidate, input.evidence);
      await this.appendInternal(context.access, event, "canon");
      return { event, candidate: rebuildMemoryCandidates([...current.events, event]).candidates.get(candidateId)! };
    });
  }

  memoryRevisions(access: FoldSdkAccessContext, refs: readonly MemoryRevisionRef[], includeNeedsReview = false): Promise<readonly PersonalMemory[]> {
    return this.enqueue(async () => {
      const { projection } = await this.memoryProjection(access);
      return refs.map((ref) => {
        const memory = recallProjectedMemoryById(projection, access, ref.memoryId);
        if (memory === undefined) throw new PersonalMemoryUnavailableError(ref.memoryId);
        if (memory.revision !== ref.revision || (!includeNeedsReview && memory.currentness?.status !== "current")) throw new FoldSdkConflictError("memory revision is stale or requires review");
        return memory;
      });
    });
  }

  selectEvaluationSources(access: FoldSdkAccessContext, request: EvaluationSourceSelectionRequest): Promise<EvaluationSourceSelection> {
    return this.enqueue(async () => {
      validateAccessContext(access);
      if (access.platformDataAccess === true) throw new FoldSdkAccessError("platform inspection does not authorize evaluation export");
      const subject = request.expectedSubject;
      if (subject.principalId !== access.principalId || subject.organizationId !== access.organizationId || subject.workspaceId !== access.workspaceId) throw new FoldSdkAccessError("evaluation selection subject changed");
      if (request.audience !== "local-reviewed" || !request.selectionId?.trim() || request.selectionId.length > 300 || !request.redactionVersion?.trim() || request.redactionVersion.length > 300 || !Array.isArray(request.references) || request.references.length > 100 || !Array.isArray(request.reviewedReferences) || request.reviewedReferences.length > 100) throw new FoldSdkError("invalid bounded evaluation selection");
      const key = (reference: EvaluationSourceSelectionRequest["references"][number]) => {
        if (reference.kind === "memory" && typeof reference.memoryId === "string" && reference.memoryId.length > 0 && reference.memoryId.length <= 300 && Number.isSafeInteger(reference.revision) && reference.revision >= 0) return `memory:${reference.memoryId}:${reference.revision}`;
        if (reference.kind === "event" && typeof reference.eventId === "string" && reference.eventId.length > 0 && reference.eventId.length <= 300) return `event:${reference.eventId}`;
        throw new FoldSdkError("invalid exact evaluation source reference");
      };
      const selected = new Set(request.references.map(key));
      const reviewed = new Set(request.reviewedReferences.map(key));
      if (selected.size !== request.references.length || reviewed.size !== request.reviewedReferences.length || [...reviewed].some((reference) => !selected.has(reference))) throw new FoldSdkError("evaluation review must name distinct selected references");
      const { projection, events } = await this.memoryProjection(access);
      const eventIndex = new Map(events.map((event) => [event.id, event]));
      let taskState: ReturnType<typeof rebuildTaskEvidence> | undefined;
      if (request.references.some((reference) => reference.kind === "event")) {
        try { taskState = rebuildTaskEvidence(events); }
        catch (error) { if (!(error instanceof TaskEvidenceError)) throw error; }
      }
      const eligible: EvaluationSourceSelection["eligible"][number][] = [];
      const excluded: EvaluationSourceSelection["excluded"][number][] = [];
      const current = (ref: MemoryRevisionRef): EvaluationSourceSelection["excluded"][number]["reason"] | undefined => {
        const memory = recallProjectedMemoryById(projection, access, ref.memoryId);
        if (memory === undefined) return "unavailable-or-denied";
        if (memory.revision !== ref.revision) return "stale-revision";
        if (memory.currentness?.status !== "current" || memory.applicability?.kind === "unresolved") return "needs-review";
        return undefined;
      };
      for (const reference of request.references) {
        if (!reviewed.has(key(reference))) { excluded.push({ reference, reason: "unreviewed" }); continue; }
        if (reference.kind === "memory") {
          const reason = current(reference);
          if (reason !== undefined) { excluded.push({ reference, reason }); continue; }
          const memory = recallProjectedMemoryById(projection, access, reference.memoryId)!;
          eligible.push({ reference, eligibility: "current-authorized", updatedAt: memory.updatedAt, snapshot: { memoryId: memory.id, revision: memory.revision, summary: memory.summary, content: memory.content } });
          continue;
        }
        const event = eventIndex.get(reference.eventId);
        if (event === undefined) { excluded.push({ reference, reason: "unavailable-or-denied" }); continue; }
        const record = taskEvidenceRecordsFromEvent(event)[0];
        if (record === undefined) { excluded.push({ reference, reason: "unsupported-source" }); continue; }
        if (taskState === undefined) { excluded.push({ reference, reason: "unavailable-or-denied" }); continue; }
        // Immutable evidence remains historical. Its dependent memory claims must still be eligible now.
        const attempt = record.recordType === "task-manifest" ? undefined : record.recordType === "attempt-manifest" ? record.input : taskState.attempts.get(record.input.attemptId);
        if ((record.recordType !== "task-manifest" && attempt === undefined) || !taskState.tasks.has(taskVersionKey(record.input.taskId, record.recordType === "task-manifest" ? record.input.taskVersion : attempt!.taskVersion))) { excluded.push({ reference, reason: "unavailable-or-denied" }); continue; }
        const reason = (attempt?.context?.memoryRefs ?? []).map(current).find((value) => value !== undefined);
        if (reason !== undefined) { excluded.push({ reference, reason }); continue; }
        eligible.push({ reference, eligibility: "current-authorized", updatedAt: event.at.t, snapshot: JSON.parse(JSON.stringify({ recordType: record.recordType, input: record.input, ...(record.recordType === "outcome" || record.recordType === "intervention" ? { authorityKind: record.authority.kind } : {}) })) as import("@_89/fold").JsonValue });
      }
      return { selectionId: request.selectionId, audience: request.audience, redactionVersion: request.redactionVersion, subject, eligible, excluded };
    });
  }

  memoryEvidencePage(access: FoldSdkAccessContext, memoryId: string, options: { revision?: number; offset?: number; limit?: number; contributionOffset?: number } = {}) {
    return this.enqueue(async () => {
      const { projection, events } = await this.memoryProjection(access);
      const active = recallProjectedMemoryById(projection, access, memoryId);
      if (active === undefined) throw new PersonalMemoryUnavailableError(memoryId);
      const revision = options.revision ?? active.revision;
      const memory = revision === active.revision ? active : projection.revisions?.get(memoryId)?.get(revision);
      if (memory === undefined) throw new FoldSdkConflictError("memory evidence revision is unavailable");
      const offset = options.offset ?? 0, limit = options.limit ?? 100;
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new FoldSdkError("invalid evidence page bounds");
      const contributionOffset = options.contributionOffset ?? 0;
      if (!Number.isSafeInteger(contributionOffset) || contributionOffset < 0) throw new FoldSdkError("invalid contribution page offset");
      const evidence = memory.evidence ?? [];
      const contributions = events.flatMap(memoryEvidenceContributionsFromEvent).filter((record) => (record.target === "memory" && record.targetId === memoryId && record.baseRevision < revision) || (record.target === "candidate" && record.targetId === memory.sourceCandidate?.candidateId && record.baseRevision < memory.sourceCandidate.revision)).map((record) => ({ eventId: record.eventId, contributorId: record.actorId, contributedAt: record.atMs, evidenceCount: record.evidence.filter((ref) => evidence.some((item) => canonicalJson(ref) === canonicalJson(item))).length })).filter((record) => record.evidenceCount > 0);
      return { memoryId, revision, contributions: contributions.slice(contributionOffset, contributionOffset + limit), contributionTotal: contributions.length, ...(contributionOffset + limit < contributions.length ? { nextContributionOffset: contributionOffset + limit } : {}), evidence: evidence.slice(offset, offset + limit), total: evidence.length, ...(offset + limit < evidence.length ? { nextOffset: offset + limit } : {}) };
    });
  }

  private feedbackMemory(projection: MemoryProjection, access: FoldSdkAccessContext, memoryId: string, revision: number): PersonalMemory {
    // An exact historical claim can be judged after correction, but current access and deletion still govern disclosure.
    const active = recallProjectedMemoryById(projection, access, memoryId);
    if (active === undefined) throw new PersonalMemoryUnavailableError(memoryId);
    const memory = revision === active.revision ? active : projection.revisions?.get(memoryId)?.get(revision);
    if (memory === undefined) throw new FoldSdkConflictError("feedback memory revision is unavailable");
    return memory;
  }

  private feedbackContext(context: EpistemicEventContext, memory: PersonalMemory): EpistemicEventContext {
    return { ...context, capture: { ...context.capture, scope: { workspace: memory.workspaceId, ...(memory.spaceId === undefined ? {} : { space: memory.spaceId }), ...(memory.audience === "personal" ? { creator: memory.creatorId } : {}) } } };
  }

  private validateFeedbackOutcome(access: FoldSdkAccessContext, input: MemoryFeedbackInputV2, memory: PersonalMemory, events: readonly FoldEvent[]): void {
    const contained = events.filter((source) => authorizeEventAccess(source, access).allowed && (source.capture.scope.creator === undefined || (memory.audience === "personal" && source.capture.scope.creator === memory.creatorId)) && (source.capture.scope.space === undefined || source.capture.scope.space === memory.spaceId));
    if (input.taskId !== undefined || input.attemptId !== undefined) {
      const state = rebuildTaskEvidence(contained);
      if (input.taskId !== undefined && ![...state.tasks.values()].some((task) => task.taskId === input.taskId)) throw new FoldSdkAccessError("feedback task is unavailable in memory scope");
      const attempt = input.attemptId === undefined ? undefined : state.attempts.get(input.attemptId);
      if (input.attemptId !== undefined && (attempt === undefined || attempt.taskId !== input.taskId)) throw new FoldSdkAccessError("feedback attempt does not match the task in memory scope");
    }
    if (input.outcomeEventId === undefined) return;
    const source = contained.find((event) => event.id === input.outcomeEventId);
    if (!source || !authorizeEventAccess(source, access).allowed || (source.capture.scope.creator !== undefined && (memory.audience !== "personal" || source.capture.scope.creator !== memory.creatorId)) || (source.capture.scope.space !== undefined && source.capture.scope.space !== memory.spaceId)) throw new FoldSdkAccessError("feedback outcome is unavailable in memory scope");
    const outcomes = taskEvidenceRecordsFromEvent(source).filter((record) => record.recordType === "outcome");
    if (!outcomes.some((record) => record.recordType === "outcome" && (input.taskId === undefined || record.input.taskId === input.taskId) && (input.attemptId === undefined || record.input.attemptId === input.attemptId))) throw new FoldSdkAccessError("feedback outcome must reference a matching canonical task outcome");
  }

  recordMemoryFeedback(context: EpistemicEventContext, stamp: EpistemicEventStamp, memoryId: string, input: MemoryFeedbackInput, causedBy?: readonly string[]): Promise<MemoryFeedbackResult> {
    return this.command(context.access, "recordMemoryFeedback", stamp.id, { context, stamp, memoryId, input, causedBy }, async () => {
      const normalized = normalizeMemoryFeedbackInputV2(input);
      const current = await this.memoryProjection(context.access);
      const memory = this.feedbackMemory(current.projection, context.access, memoryId, normalized.memoryRevision);
      this.validateFeedbackOutcome(context.access, normalized, memory, current.events);
      const event = makeMemoryFeedbackEvent(this.feedbackContext(context, memory), stamp, memory, normalized, causedBy);
      await this.appendInternal(context.access, event, "canon");
      return { event, feedback: memoryFeedbackRecordsFromEvent(event)[0]! };
    });
  }

  recordMemoryFeedbackBatch(context: EpistemicEventContext, stamp: EpistemicEventStamp, items: readonly { readonly stamp: EpistemicEventStamp; readonly memoryId: string; readonly input: MemoryFeedbackInputV2 }[], expectedSubject: { readonly principalId: string; readonly organizationId: string; readonly workspaceId: string }): Promise<{ readonly events: readonly FoldEvent[]; readonly feedback: readonly MemoryFeedbackRecord[] }> {
    if (expectedSubject.principalId !== context.access.principalId || expectedSubject.organizationId !== context.access.organizationId || expectedSubject.workspaceId !== context.access.workspaceId) throw new FoldSdkAccessError("feedback subject changed");
    return this.command(context.access, "recordMemoryFeedbackBatch", stamp.id, { context, stamp, items, expectedSubject }, async () => {
      if (items.length < 1 || items.length > 100 || new Set(items.map((item) => item.stamp.id)).size !== items.length) throw new FoldSdkError("feedback batch requires 1 to 100 distinct event IDs");
      const current = await this.memoryProjection(context.access);
      const events = items.map((item) => {
        const input = normalizeMemoryFeedbackInputV2(item.input);
        const memory = this.feedbackMemory(current.projection, context.access, item.memoryId, input.memoryRevision);
        this.validateFeedbackOutcome(context.access, input, memory, current.events);
        return makeMemoryFeedbackEvent(this.feedbackContext(context, memory), item.stamp, memory, input);
      });
      await this.commitEntryBatch(context.access, events.map((event) => ({ event, status: "canon" })));
      return { events, feedback: events.flatMap(memoryFeedbackRecordsFromEvent) };
    });
  }

  memoryFeedbackSummary(access: FoldSdkAccessContext, memoryId: string, revision?: number) {
    return this.enqueue(async () => {
      const current = await this.memoryProjection(access);
      const active = recallProjectedMemoryById(current.projection, access, memoryId);
      if (!active) throw new PersonalMemoryUnavailableError(memoryId);
      const memory = this.feedbackMemory(current.projection, access, memoryId, revision ?? active.revision);
      return summarizeMemoryFeedback(current.events.flatMap(memoryFeedbackRecordsFromEvent), memoryId, memory.revision);
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
      // Ranking may await a remote embedder while another process changes or forgets a claim.
      const fresh = await this.memoryProjection(access);
      for (const { memory } of memories) {
        const current = recallProjectedMemoryById(fresh.projection, access, memory.id);
        if (current === undefined || current.revision !== memory.revision || (request.includeNeedsReview !== true && current.currentness?.status !== "current")) throw new FoldSdkConflictError("memory changed while ranking; repeat the search");
      }
      const judgments = new Map<string, MemoryFeedbackInputV2>();
      for (const record of (await this.entriesForAccess(access, { include: "canon" })).flatMap(({ event }) => memoryFeedbackRecordsFromEvent(event))) if ("version" in record && record.signal === "judged" && record.actorId === access.principalId) judgments.set(`${record.memoryId}:${record.memoryRevision}`, record);
      const preference = (memory: PersonalMemory) => { const judgment = judgments.get(`${memory.id}:${memory.revision}`)?.judgment; return judgment === "helpful" ? 1 : judgment === "unhelpful" || judgment === "superseded" ? -1 : 0; };
      const ordered = memories.map((row, index) => ({ row, index })).sort((a, b) => (b.row.score ?? 0) - (a.row.score ?? 0) || preference(b.row.memory) - preference(a.row.memory) || a.index - b.index).map(({ row }) => row);
      return {
        memories: ordered,
        ranking: { ...ranker.descriptor, corpusSize: corpus.length },
        feedback: { basis: "requester-latest-judgment-tiebreak-v1", items: ordered.filter(({ memory }) => preference(memory) !== 0).map(({ memory }) => ({ memoryId: memory.id, memoryRevision: memory.revision, preference: preference(memory) })) },
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
