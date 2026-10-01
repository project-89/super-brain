import { sortLog, type FoldEvent, type FoldLogEntry } from "@_89/fold";
import type { EpisodeWindowInput, EpisodeWindowRecord, WorkEpisodeRevision, EpisodeSource } from "@_89/fold-epistemic";
import type {
  MemoryAudience,
  MemoryCandidateInput,
  MemoryCandidateView,
  MemoryFeedbackInput,
  MemoryFeedbackRecord,
  MemoryInput,
  MemoryRevisionPatch,
  PersonalMemory,
  RecallRequest,
  RecalledMemory,
} from "@_89/fold-epistemic";
import type { FoldSdkCursor, FoldIngestionCursor, RankedMemoryRecallResult, SteeringSnapshot, TrajectoryTaskSummary } from "@_89/fold-sdk";
import type { TranscriptRun, IdentityEntity, IdentityAttribution, ProjectAlias, IdentityRecord, IdentityEntityInput, IdentityAttributionInput, ProjectAliasInput } from "@_89/fold-transcript";
import type {
  TrajectoryInput,
  TrajectoryOutcomeInput,
  TrajectoryOutcomeRecord,
  TrajectoryMutationResult,
  TrajectoryTaskReport,
  TrajectoryTreeMutationResult,
  TrajectoryTreeRecord,
} from "@_89/fold-trajectory";

export interface SuperBrainClientOptions {
  readonly baseUrl: string;
  readonly organizationId?: string;
  readonly workspaceId: string;
  readonly token: string;
  readonly fetch?: typeof fetch;
  readonly recallTelemetry?: {
    readonly sessionId?: string;
    readonly taskId?: string;
    readonly detail?: string;
  };
}

export interface EventStamp {
  readonly id: string;
  readonly t: number;
  readonly worldDate: string;
}

export interface EpisodeSynthesisInput {
  readonly windowId: string; readonly parentWindowId?: string; readonly sourceEventIds: readonly string[];
  readonly projectId: string | null; readonly spaceId?: string; readonly audience: "personal" | "workspace";
  readonly trigger: EpisodeWindowInput["trigger"]; readonly provider?: string; readonly contextEpisodeIds?: readonly string[];
}
export interface EpisodePage<T> { readonly items: readonly T[]; readonly total: number; readonly nextCursor?: string; readonly coverage: "authorized-current-only" }

export interface StreamedFoldEvent {
  readonly entry: FoldLogEntry;
  readonly cursor: FoldIngestionCursor;
}

export interface EventStreamOptions {
  readonly after?: FoldIngestionCursor;
  readonly replay?: "tail" | "all";
  readonly include?: "canon" | "canon+draft";
  readonly kinds?: readonly string[];
  readonly signal?: AbortSignal;
}

export interface ConsumeEventOptions extends Omit<EventStreamOptions, "after" | "replay"> {
  readonly consumerId: string;
  readonly replay?: "tail" | "all";
  readonly reconnect?: boolean;
  readonly reconnectDelayMs?: number;
  readonly checkpointEvery?: number;
  readonly onEvent: (event: StreamedFoldEvent) => void | Promise<void>;
}

export interface IngestionConsumerStatus {
  readonly cursor: FoldIngestionCursor | null;
  readonly legacyCursor: FoldSdkCursor | null;
  readonly migrationRequired: boolean;
  readonly headCursor: FoldIngestionCursor;
}

function parseIngestionCursor(value: unknown): FoldIngestionCursor {
  const cursor = value as Partial<FoldIngestionCursor> | null;
  if (cursor?.kind !== "ingestion" || typeof cursor.sequence !== "string" || !/^(?:0|[1-9][0-9]{0,18})$/.test(cursor.sequence) || BigInt(cursor.sequence) > 9223372036854775807n) throw new TypeError("Invalid ingestion cursor; legacy source-time cursors require explicit replay-all migration");
  return cursor as FoldIngestionCursor;
}

export interface ReasoningResponse {
  readonly answer: string;
  readonly citations: readonly string[];
  readonly provider: { readonly id: string; readonly kind: "extractive" | "model" };
  readonly ranking: { readonly id: string; readonly kind: "lexical" | "semantic" | "explicit"; readonly corpusSize: number };
  readonly evidence: readonly {
    readonly memoryId: string;
    readonly source: string;
    readonly summary: string;
    readonly score?: number;
  }[];
  readonly steering?: SteeringSnapshot;
}

export interface RepositoryEnrollment {
  readonly id: string;
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly normalizedRemote: string;
  readonly projectId?: string;
  readonly enrolledBy: string;
  readonly enrolledAt: string;
}

export interface PlatformAccessAuditRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly credentialId: string;
  readonly reason: string;
  readonly expiresAt: string;
  readonly accessedAt: string;
}

export class SuperBrainApiError extends Error {
  override readonly name = "SuperBrainApiError";

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

let lastStampTime = -1;
let stampSequence = 0;

function localWorldDate(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getFullYear().toString().padStart(4, "0");
  const month = (date.getMonth() + 1).toString().padStart(2, "0");
  const day = date.getDate().toString().padStart(2, "0");
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

export function uuidV7(now = Date.now()): string {
  if (!Number.isSafeInteger(now) || now < 0 || now > 0xffffffffffff) {
    throw new TypeError("UUIDv7 timestamp must be a non-negative 48-bit integer");
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let timestamp = now;
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = timestamp & 0xff;
    timestamp = Math.floor(timestamp / 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function nextEventStamp(now = Date.now(), producer = "harness"): EventStamp {
  const t = Math.max(now, lastStampTime);
  if (t === lastStampTime) stampSequence += 1;
  else {
    lastStampTime = t;
    stampSequence = 0;
  }
  return {
    id: `${producer}-${t.toString().padStart(13, "0")}-${stampSequence.toString().padStart(4, "0")}`,
    t,
    worldDate: localWorldDate(t),
  };
}

function appendRepeated(params: URLSearchParams, key: string, values?: readonly string[]): void {
  values?.forEach((value) => {
    const normalized = value.trim();
    if (normalized.length > 0) params.append(key, normalized);
  });
}

function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      cleanup();
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export class SuperBrainClient {
  private readonly baseUrl: string;
  private readonly organizationId: string | undefined;
  private readonly workspaceId: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly recallTelemetry: SuperBrainClientOptions["recallTelemetry"] | undefined;

  constructor(options: SuperBrainClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.organizationId = options.organizationId?.trim();
    this.workspaceId = options.workspaceId.trim();
    this.token = options.token.trim();
    this.fetchImpl = options.fetch ?? fetch;
    this.recallTelemetry = options.recallTelemetry;
    if (this.baseUrl.length === 0 || this.workspaceId.length === 0 || this.token.length === 0) {
      throw new TypeError("baseUrl, workspaceId, and token are required");
    }
    if (options.organizationId !== undefined && this.organizationId?.length === 0) {
      throw new TypeError("organizationId must not be empty when provided");
    }
  }

  private workspacePath(resource: string): string {
    const workspace = encodeURIComponent(this.workspaceId);
    return this.organizationId === undefined
      ? `/v1/workspaces/${workspace}/${resource}`
      : `/v1/organizations/${encodeURIComponent(this.organizationId)}/workspaces/${workspace}/${resource}`;
  }

  private async request<T>(path: string, init: RequestInit = {}, timeoutMs = 30_000): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.token}`);
    if (init.body !== undefined) headers.set("content-type", "application/json");
    const controller = new AbortController();
    const abort = () => controller.abort(init.signal?.reason);
    if (init.signal?.aborted) abort();
    else init.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(new DOMException("Super Brain request timed out", "TimeoutError")), timeoutMs);
    timer.unref?.();
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers, signal: controller.signal });
      const body = await response.json().catch((error: unknown) => { if (controller.signal.aborted) throw error; return {}; }) as {
        readonly error?: { readonly code?: string; readonly message?: string; readonly details?: unknown };
      };
      if (!response.ok) {
        throw new SuperBrainApiError(
          response.status,
          body.error?.code ?? "request_failed",
          body.error?.message ?? `Super Brain request failed with HTTP ${response.status}`,
          body.error?.details,
        );
      }
      return body as T;
    } finally { clearTimeout(timer); init.signal?.removeEventListener("abort", abort); }
  }

  appendEvent(event: FoldEvent, status: "canon" | "draft" = "canon") {
    return this.request<{ readonly entry: FoldLogEntry }>(this.workspacePath("events"), {
      method: "POST",
      body: JSON.stringify({ event, status }),
    });
  }

  async listEvents(options: { readonly kinds?: readonly string[]; readonly include?: "canon" | "canon+draft"; readonly limit?: number } = {}): Promise<readonly FoldLogEntry[]> {
    if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1)) throw new TypeError("limit must be a positive integer");
    const entries = new Map<string, FoldLogEntry>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      // Descending cursor pages select the indexed registry path rather than replaying the corpus.
      const params = new URLSearchParams({ order: "desc", limit: "100" });
      appendRepeated(params, "kind", options.kinds);
      if (options.include !== undefined) params.set("include", options.include);
      if (cursor !== undefined) params.set("pageCursor", cursor);
      const response = await this.request<{ readonly entries: readonly FoldLogEntry[]; readonly nextCursor?: string }>(
        `${this.workspacePath("events")}?${params}`,
      );
      if (!Array.isArray(response.entries)) throw new TypeError("Event catalog returned an invalid response");
      for (const entry of response.entries) entries.set(entry.event.id, entry);
      cursor = response.nextCursor;
      if (cursor !== undefined) {
        if (typeof cursor !== "string" || cursor.length === 0 || cursors.has(cursor)) throw new TypeError("Event catalog returned an invalid cursor");
        cursors.add(cursor);
      }
      // Complete a timestamp boundary before applying the legacy ascending last-N limit.
      if (options.limit !== undefined && entries.size >= options.limit && response.entries.length > 0) {
        const ordered = sortLog([...entries.values()]);
        if (response.entries.at(-1)!.event.at.t < ordered[ordered.length - options.limit]!.event.at.t) break;
      }
    } while (cursor !== undefined);
    const ordered = sortLog([...entries.values()]);
    return options.limit === undefined ? ordered : ordered.slice(-options.limit);
  }

  async transcriptRuns(options: { readonly requestTimeoutMs?: number } = {}): Promise<readonly TranscriptRun[]> {
    const timeoutMs = options.requestTimeoutMs ?? 30_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError("requestTimeoutMs must be a positive integer");
    const runs = new Map<string, TranscriptRun>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const params = new URLSearchParams({ limit: "100" });
      if (cursor !== undefined) params.set("pageCursor", cursor);
      const response = await this.request<{ readonly runs: readonly TranscriptRun[]; readonly nextCursor?: string }>(
        `${this.workspacePath("transcript-runs")}?${params}`,
        {}, timeoutMs,
      );
      if (!Array.isArray(response.runs)) throw new TypeError("Transcript run catalog returned an invalid response");
      for (const run of response.runs) runs.set(run.id, run);
      cursor = response.nextCursor;
      if (cursor !== undefined) {
        if (typeof cursor !== "string" || cursor.length === 0 || cursors.has(cursor)) throw new TypeError("Transcript run catalog returned an invalid cursor");
        cursors.add(cursor);
      }
    } while (cursor !== undefined);
    return [...runs.values()];
  }

  async eventById(eventId: string): Promise<FoldEvent | undefined> {
    try {
      const result = await this.request<{ readonly entry: FoldLogEntry }>(`${this.workspacePath("events")}/${encodeURIComponent(eventId)}`);
      if (result.entry.status !== "canon") throw new TypeError("Event lookup returned a non-canonical entry");
      return result.entry.event;
    } catch (error) {
      if (error instanceof SuperBrainApiError && error.status === 404) return undefined;
      throw error;
    }
  }

  synthesizeEpisodeWindow(input: EpisodeSynthesisInput): Promise<EpisodeWindowInput> {
    return this.request(`${this.workspacePath("work-episodes")}/synthesize`, { method: "POST", body: JSON.stringify(input) }, 210_000);
  }
  publishEpisodeWindow(input: EpisodeWindowInput): Promise<EpisodeWindowRecord> {
    return this.request(`${this.workspacePath("work-episodes")}/windows`, { method: "POST", body: JSON.stringify(input) });
  }
  workEpisode(episodeId: string): Promise<WorkEpisodeRevision & { readonly projectName?: string; readonly freshness: "current" }> {
    return this.request(`${this.workspacePath("work-episodes")}/${encodeURIComponent(episodeId)}`);
  }
  episodeWindow(windowId: string): Promise<EpisodeWindowRecord> {
    return this.request(`${this.workspacePath("work-episode-windows")}/${encodeURIComponent(windowId)}`);
  }
  episodePage<T = WorkEpisodeRevision>(options: { readonly section?: "episodes" | "windows"; readonly episodeId?: string; readonly detail?: "history" | "sources"; readonly cursor?: string; readonly limit?: number; readonly projectId?: string } = {}): Promise<EpisodePage<T>> {
    if (options.detail === "sources" && options.limit !== undefined && options.limit !== 1) throw new TypeError("Episode evidence pages contain one complete source event");
    const query = new URLSearchParams({ limit: String(options.limit ?? (options.detail === "sources" ? 1 : 100)) });
    if (options.cursor !== undefined) query.set("pageCursor", options.cursor);
    if (options.projectId !== undefined) query.set("projectId", options.projectId);
    let path = this.workspacePath(options.section === "windows" ? "work-episode-windows" : "work-episodes");
    if (options.episodeId !== undefined) path += `/${encodeURIComponent(options.episodeId)}/${options.detail ?? "history"}`;
    return this.request(`${path}?${query}`);
  }

  identityPage<T = IdentityEntity | IdentityAttribution | ProjectAlias | IdentityRecord>(
    section: "entities" | "attributions" | "aliases" | "history" | "projects",
    options: { readonly cursor?: string; readonly limit?: number; readonly kind?: IdentityEntity["kind"]; readonly active?: boolean } = {},
  ) {
    const query = new URLSearchParams({ limit: String(options.limit ?? 100) });
    if (options.cursor !== undefined) query.set("pageCursor", options.cursor);
    if (options.kind !== undefined) query.set("kind", options.kind);
    if (options.active !== undefined) query.set("active", String(options.active));
    return this.request<{ readonly items: readonly T[]; readonly total: number; readonly nextCursor?: string; readonly revision: string | null; readonly scope: { readonly workspaceId: string; readonly visibility: "workspace" }; readonly canManage: boolean }>(`${this.workspacePath("identities")}/${section}?${query}`);
  }

  reviseIdentityEntity(expectedRevision: string | null, input: IdentityEntityInput) {
    return this.request<{ readonly revision: string; readonly entity: IdentityEntity }>(`${this.workspacePath("identities")}/entities`, { method: "POST", body: JSON.stringify({ expectedRevision, input }) });
  }

  reviseIdentityAttribution(expectedRevision: string | null, input: IdentityAttributionInput) {
    return this.request<{ readonly revision: string; readonly attribution: IdentityAttribution }>(`${this.workspacePath("identities")}/attributions`, { method: "POST", body: JSON.stringify({ expectedRevision, input }) });
  }

  previewProjectAlias(input: ProjectAliasInput) {
    return this.request<{ readonly revision: string | null; readonly previewToken: string; readonly conflicts: readonly string[]; readonly affected: { readonly projectIds: readonly string[]; readonly runs: number; readonly memories: number; readonly candidates: number }; readonly beforeCanonicalProjectId: string; readonly afterCanonicalProjectId: string; readonly scope: { readonly workspaceId: string; readonly visibility: "workspace" } }>(`${this.workspacePath("identities")}/alias-preview`, { method: "POST", body: JSON.stringify({ input }) });
  }

  reviseProjectAlias(expectedRevision: string | null, previewToken: string, input: ProjectAliasInput) {
    return this.request<{ readonly revision: string; readonly alias: ProjectAlias }>(`${this.workspacePath("identities")}/aliases`, { method: "POST", body: JSON.stringify({ expectedRevision, previewToken, input }) });
  }

  async repositoryEnrollments(): Promise<readonly RepositoryEnrollment[]> {
    const response = await this.request<{ readonly enrollments: readonly RepositoryEnrollment[] }>(
      this.workspacePath("repository-enrollments"),
    );
    return response.enrollments;
  }

  enrollRepository(remote: string, projectId?: string): Promise<{ readonly enrollment: RepositoryEnrollment }> {
    return this.request(this.workspacePath("repository-enrollments"), {
      method: "POST",
      body: JSON.stringify({ remote, ...(projectId === undefined ? {} : { projectId }) }),
    });
  }

  async platformAccessAudit(): Promise<readonly PlatformAccessAuditRecord[]> {
    const response = await this.request<{ readonly records: readonly PlatformAccessAuditRecord[] }>(
      this.workspacePath("audit-log"),
    );
    return response.records;
  }

  recordTrajectoryTree(
    stamp: EventStamp,
    tree: TrajectoryTreeRecord["tree"],
    options: { readonly spaceId?: string; readonly captureIdentity?: Readonly<Record<string, string>> } = {},
  ): Promise<TrajectoryTreeMutationResult> {
    return this.request(this.workspacePath("trajectory-tasks"), {
      method: "POST",
      body: JSON.stringify({
        stamp,
        tree,
        ...(options.spaceId === undefined ? {} : { spaceId: options.spaceId }),
        ...(options.captureIdentity === undefined ? {} : { captureIdentity: options.captureIdentity }),
      }),
    });
  }

  async trajectoryTasks(): Promise<readonly TrajectoryTaskSummary[]> {
    const response = await this.request<{ readonly tasks: readonly TrajectoryTaskSummary[] }>(
      this.workspacePath("trajectory-tasks"),
    );
    return response.tasks;
  }

  async trajectoryTask(taskId: string): Promise<TrajectoryTaskReport | undefined> {
    try {
      const response = await this.request<{ readonly report: TrajectoryTaskReport }>(
        `${this.workspacePath("trajectory-tasks")}/${encodeURIComponent(taskId)}`,
      );
      return response.report;
    } catch (error) {
      if (error instanceof SuperBrainApiError && error.status === 404) return undefined;
      throw error;
    }
  }

  async trajectoryTree(taskId: string): Promise<TrajectoryTreeRecord | undefined> {
    try {
      const response = await this.request<{ readonly record: TrajectoryTreeRecord }>(
        `${this.workspacePath("trajectory-tasks")}/${encodeURIComponent(taskId)}/tree`,
      );
      return response.record;
    } catch (error) {
      if (error instanceof SuperBrainApiError && error.status === 404) return undefined;
      throw error;
    }
  }

  recordTrajectoryOutcome(stamp: EventStamp, input: TrajectoryOutcomeInput): Promise<{ readonly event: FoldEvent; readonly record: TrajectoryOutcomeRecord }> {
    return this.request(this.workspacePath("trajectory-outcomes"), {
      method: "POST", body: JSON.stringify({ stamp, input }),
    });
  }

  trajectoryOutcomes(taskId: string, trajectoryId: string, cursor?: string): Promise<{ readonly records: readonly TrajectoryOutcomeRecord[]; readonly total: number; readonly nextCursor?: string }> {
    const query = new URLSearchParams({ taskId, trajectoryId, limit: "100" });
    if (cursor !== undefined) query.set("pageCursor", cursor);
    return this.request(`${this.workspacePath("trajectory-outcomes")}?${query}`);
  }

  recordTrajectory(
    stamp: EventStamp,
    input: TrajectoryInput,
    options: { readonly spaceId?: string; readonly captureIdentity?: Readonly<Record<string, string>> } = {},
  ): Promise<TrajectoryMutationResult> {
    return this.request(this.workspacePath("trajectories"), {
      method: "POST",
      body: JSON.stringify({
        stamp,
        input,
        ...(options.spaceId === undefined ? {} : { spaceId: options.spaceId }),
        ...(options.captureIdentity === undefined ? {} : { captureIdentity: options.captureIdentity }),
      }),
    });
  }

  recallMemories(request: Omit<RecallRequest, "candidates"> = {}): Promise<{ readonly memories: readonly RecalledMemory[] }> {
    return this.request(this.workspacePath("memories/recall"), { method: "POST", body: JSON.stringify(request) });
  }

  async memoryById(memoryId: string): Promise<PersonalMemory | undefined> {
    try {
      const response = await this.request<{ readonly memory: PersonalMemory }>(
        `${this.workspacePath("memories")}/${encodeURIComponent(memoryId)}`,
      );
      return response.memory;
    } catch (error) {
      if (error instanceof SuperBrainApiError && error.status === 404) return undefined;
      throw error;
    }
  }

  async rankMemories(request: Omit<RecallRequest, "candidates"> & { readonly query: string }): Promise<RankedMemoryRecallResult> {
    const result = await this.request<RankedMemoryRecallResult>(
      this.workspacePath("memories/search"),
      { method: "POST", body: JSON.stringify(request) },
    );
    await this.recordRecallTelemetry(
      result.memories.map(({ memory }) => memory.id),
      request.query,
      "ranked-memory-search",
    );
    return result;
  }

  async askReasoning(request: Omit<RecallRequest, "candidates"> & {
    readonly question: string;
    readonly actorId?: string;
    readonly providerId?: string;
    readonly memoryIds?: readonly string[];
  }, options: { readonly requestTimeoutMs?: number } = {}): Promise<ReasoningResponse> {
    const requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
    if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1) throw new TypeError("requestTimeoutMs must be a positive integer");
    const result = await this.request<ReasoningResponse>(
      this.workspacePath("reasoning/ask"),
      { method: "POST", body: JSON.stringify(request) }, requestTimeoutMs,
    );
    await this.recordRecallTelemetry(result.citations, request.question, "reasoning-answer");
    return result;
  }

  private async recordRecallTelemetry(
    memoryIds: readonly string[],
    query: string,
    operation: string,
  ): Promise<void> {
    if (this.recallTelemetry === undefined) return;
    for (const memoryId of [...new Set(memoryIds)]) {
      await this.recordMemoryFeedback(memoryId, {
        signal: "recalled",
        query,
        ...(this.recallTelemetry.taskId === undefined ? {} : { taskId: this.recallTelemetry.taskId }),
        ...(this.recallTelemetry.sessionId === undefined ? {} : { sessionId: this.recallTelemetry.sessionId }),
        detail: this.recallTelemetry.detail ?? operation,
      });
    }
  }

  recordMemory(input: Omit<MemoryInput, "id"> & { readonly id?: string }, causedBy?: readonly string[]) {
    const stamp = nextEventStamp();
    return this.request<{ readonly event: FoldEvent; readonly memory: PersonalMemory }>(this.workspacePath("memories"), {
      method: "POST",
      body: JSON.stringify({
        stamp,
        input: { ...input, id: input.id ?? uuidV7(stamp.t) },
        ...(causedBy === undefined ? {} : { causedBy }),
      }),
    });
  }

  reviseMemory(memoryId: string, patch: MemoryRevisionPatch, causedBy?: readonly string[]) {
    return this.request<{ readonly event: FoldEvent; readonly memory: PersonalMemory }>(
      `${this.workspacePath("memories")}/${encodeURIComponent(memoryId)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ stamp: nextEventStamp(), patch, ...(causedBy === undefined ? {} : { causedBy }) }),
      },
    );
  }

  forgetMemory(memoryId: string, reason: string, causedBy?: readonly string[]) {
    return this.request(`${this.workspacePath("memories")}/${encodeURIComponent(memoryId)}`, {
      method: "DELETE",
      body: JSON.stringify({ stamp: nextEventStamp(), reason, ...(causedBy === undefined ? {} : { causedBy }) }),
    });
  }

  recordMemoryFeedback(memoryId: string, input: MemoryFeedbackInput, causedBy?: readonly string[]) {
    return this.request<{ readonly event: FoldEvent; readonly feedback: MemoryFeedbackRecord }>(
      `${this.workspacePath("memories")}/${encodeURIComponent(memoryId)}/feedback`,
      {
        method: "POST",
        body: JSON.stringify({ stamp: nextEventStamp(), input, ...(causedBy === undefined ? {} : { causedBy }) }),
      },
    );
  }

  proposeMemoryCandidate(
    input: Omit<MemoryCandidateInput, "id"> & { readonly id?: string },
    causedBy?: readonly string[],
  ) {
    const stamp = nextEventStamp();
    return this.request(this.workspacePath("memory-candidates"), {
      method: "POST",
      body: JSON.stringify({
        stamp,
        input: { ...input, id: input.id ?? uuidV7(stamp.t) },
        ...(causedBy === undefined ? {} : { causedBy }),
      }),
    });
  }

  proposeMemoryCandidates(
    inputs: readonly (Omit<MemoryCandidateInput, "id" | "audience" | "spaceId"> & { readonly id?: string })[],
    options: { readonly audience?: MemoryAudience; readonly spaceId?: string } = {},
  ) {
    const audience = options.audience ?? "workspace";
    const proposals = inputs.map((input) => {
      const stamp = nextEventStamp();
      return {
        stamp,
        input: {
          ...input,
          id: input.id ?? uuidV7(stamp.t),
          audience,
          ...(options.spaceId === undefined ? {} : { spaceId: options.spaceId }),
        },
      };
    });
    return this.request(this.workspacePath("memory-candidate-imports"), {
      method: "POST",
      body: JSON.stringify({ audience, ...(options.spaceId === undefined ? {} : { spaceId: options.spaceId }), proposals }),
    });
  }

  addMemoryCandidateEvidence(candidateId: string, input: MemoryCandidateInput): Promise<{ readonly candidate: MemoryCandidateView["candidate"] }> {
    return this.request(`${this.workspacePath("memory-candidates")}/${encodeURIComponent(candidateId)}/evidence`, {
      method: "POST", body: JSON.stringify({ stamp: nextEventStamp(), input }),
    });
  }

  async memoryCandidates(options: {
    readonly status?: MemoryCandidateView["status"];
    readonly projectIds?: readonly string[];
    readonly offset?: number;
    readonly limit?: number;
  } = {}): Promise<readonly MemoryCandidateView[]> {
    const params = new URLSearchParams();
    if (options.status !== undefined) params.set("status", options.status);
    appendRepeated(params, "projectId", options.projectIds);
    if (options.offset !== undefined) params.set("offset", options.offset.toString());
    if (options.limit !== undefined) params.set("limit", options.limit.toString());
    const response = await this.request<{ readonly candidates: readonly MemoryCandidateView[] }>(
      `${this.workspacePath("memory-candidates")}${params.size === 0 ? "" : `?${params}`}`,
    );
    return response.candidates;
  }

  acceptMemoryCandidate(candidateId: string, options: { readonly memoryId?: string } = {}) {
    const stamp = nextEventStamp();
    const memoryStamp = nextEventStamp(stamp.t + 1);
    return this.request(`${this.workspacePath("memory-candidates")}/${encodeURIComponent(candidateId)}/accept`, {
      method: "POST",
      body: JSON.stringify({ stamp, memoryStamp, memoryId: options.memoryId ?? uuidV7(memoryStamp.t) }),
    });
  }

  acceptMemoryCandidates(
    candidateIds: readonly string[],
    options: { readonly audience?: MemoryAudience; readonly spaceId?: string } = {},
  ) {
    if (candidateIds.length < 1 || candidateIds.length > 100) {
      throw new TypeError("candidateIds must contain 1 to 100 IDs");
    }
    const acceptances = candidateIds.map((candidateId) => {
      const stamp = nextEventStamp();
      const memoryStamp = nextEventStamp(stamp.t + 1);
      return { candidateId, stamp, memoryStamp, memoryId: uuidV7(memoryStamp.t) };
    });
    return this.request<{ readonly accepted: readonly { readonly memory: PersonalMemory }[] }>(
      this.workspacePath("memory-candidate-promotions"),
      {
        method: "POST",
        body: JSON.stringify({
          audience: options.audience ?? "workspace",
          ...(options.spaceId === undefined ? {} : { spaceId: options.spaceId }),
          acceptances,
        }),
      },
    );
  }

  rejectMemoryCandidate(candidateId: string, reason: string) {
    return this.request(`${this.workspacePath("memory-candidates")}/${encodeURIComponent(candidateId)}/reject`, {
      method: "POST",
      body: JSON.stringify({ stamp: nextEventStamp(), reason }),
    });
  }

  async consumerCursor(consumerId: string): Promise<FoldSdkCursor | undefined> {
    const response = await this.request<{ readonly cursor?: FoldSdkCursor | null }>(
      `${this.workspacePath("consumers")}/${encodeURIComponent(consumerId)}`,
    );
    return response.cursor ?? undefined;
  }

  commitConsumerCursor(consumerId: string, cursor: FoldSdkCursor): Promise<unknown> {
    return this.request(`${this.workspacePath("consumers")}/${encodeURIComponent(consumerId)}`, {
      method: "POST",
      body: JSON.stringify({ cursor }),
    });
  }

  private ingestionConsumerPath(consumerId: string, options: Pick<EventStreamOptions, "kinds" | "include">): string {
    const params = new URLSearchParams({ order: "ingestion" });
    appendRepeated(params, "kind", options.kinds);
    if (options.include !== undefined) params.set("include", options.include);
    return `${this.workspacePath("consumers")}/${encodeURIComponent(consumerId)}?${params}`;
  }

  async ingestionConsumerStatus(consumerId: string, options: Pick<EventStreamOptions, "kinds" | "include"> = {}): Promise<IngestionConsumerStatus> {
    const status = await this.request<IngestionConsumerStatus>(this.ingestionConsumerPath(consumerId, options));
    if (status.cursor !== null) parseIngestionCursor(status.cursor);
    parseIngestionCursor(status.headCursor);
    if (typeof status.migrationRequired !== "boolean") throw new TypeError("Invalid ingestion consumer status");
    return status;
  }

  migrateConsumerCursor(consumerId: string, options: Pick<EventStreamOptions, "kinds" | "include"> = {}): Promise<IngestionConsumerStatus> {
    return this.request(this.ingestionConsumerPath(consumerId, options), { method: "POST", body: JSON.stringify({ migration: "replay-all" }) });
  }

  resetConsumerCursor(consumerId: string, expectedCursor: FoldIngestionCursor, reason: string, options: Pick<EventStreamOptions, "kinds" | "include"> = {}): Promise<IngestionConsumerStatus> {
    return this.request(this.ingestionConsumerPath(consumerId, options), { method: "POST", body: JSON.stringify({ reset: { expectedCursor: parseIngestionCursor(expectedCursor), reason } }) });
  }

  commitIngestionCursor(consumerId: string, cursor: FoldIngestionCursor): Promise<unknown> {
    return this.request(this.ingestionConsumerPath(consumerId, {}), { method: "POST", body: JSON.stringify({ cursor: parseIngestionCursor(cursor) }) });
  }

  async *eventStream(options: EventStreamOptions = {}): AsyncGenerator<StreamedFoldEvent> {
    const params = new URLSearchParams({ order: "ingestion" });
    if (options.after !== undefined) {
      params.set("afterSequence", parseIngestionCursor(options.after).sequence);
    }
    if (options.replay !== undefined) params.set("replay", options.replay);
    if (options.include !== undefined) params.set("include", options.include);
    appendRepeated(params, "kind", options.kinds);
    const response = await this.fetchImpl(
      `${this.baseUrl}${this.workspacePath("event-stream")}${params.size === 0 ? "" : `?${params}`}`,
      {
        headers: { authorization: `Bearer ${this.token}` },
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as {
        readonly error?: { readonly code?: string; readonly message?: string; readonly details?: unknown };
      };
      throw new SuperBrainApiError(
        response.status,
        body.error?.code ?? "stream_failed",
        body.error?.message ?? "Event stream failed",
        body.error?.details,
      );
    }
    if (response.body === null) throw new SuperBrainApiError(502, "stream_unavailable", "Event stream has no response body");
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        buffer += value ?? "";
        let boundary: number;
        while ((boundary = buffer.search(/\r?\n\r?\n/)) >= 0) {
          const frame = buffer.slice(0, boundary);
          const separator = buffer.slice(boundary).match(/^\r?\n\r?\n/)?.[0] ?? "\n\n";
          buffer = buffer.slice(boundary + separator.length);
          const lines = frame.split(/\r?\n/);
          const eventName = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
          if (eventName === "stream-error") throw new SuperBrainApiError(502, "stream_failed", "Event stream failed");
          if (eventName !== "fold-event") continue;
          const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
          if (data.length > 0) {
            const event = JSON.parse(data) as StreamedFoldEvent;
            parseIngestionCursor(event.cursor);
            yield event;
          }
        }
        if (done) break;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  async consumeEvents(options: ConsumeEventOptions): Promise<void> {
    const checkpointEvery = options.checkpointEvery ?? 1;
    if (!Number.isInteger(checkpointEvery) || checkpointEvery < 1 || checkpointEvery > 100) throw new TypeError("checkpointEvery must be an integer within [1, 100]");
    if (Boolean(options.signal?.aborted)) return;
    const status = await this.ingestionConsumerStatus(options.consumerId, options);
    if (Boolean(options.signal?.aborted)) return;
    if (status.migrationRequired) throw new SuperBrainApiError(409, "ingestion_cursor_migration_required", "Legacy consumer requires explicit replay-all migration; no events were skipped or offsets changed", status);
    let cursor: FoldIngestionCursor = status.cursor ?? ((options.replay ?? "tail") === "all" ? { kind: "ingestion", sequence: "0" } : status.headCursor);
    if (status.cursor === null) await this.commitIngestionCursor(options.consumerId, cursor);
    let pendingCursor: FoldIngestionCursor | undefined;
    let pendingCount = 0;
    let checkpointChain = Promise.resolve();
    const checkpoint = (): Promise<void> => {
      const next = checkpointChain.then(async () => {
        const through = pendingCursor;
        const count = pendingCount;
        if (through === undefined) return;
        await this.commitIngestionCursor(options.consumerId, through);
        cursor = through;
        if (pendingCursor === through) { pendingCursor = undefined; pendingCount = 0; }
        else pendingCount -= count;
      });
      checkpointChain = next.catch(() => undefined);
      return next;
    };
    const reconnect = options.reconnect ?? true;
    do {
      let delayMs = options.reconnectDelayMs ?? 1_000;
      const connection = new AbortController();
      const abort = () => connection.abort(options.signal?.reason);
      if (options.signal?.aborted) abort();
      else options.signal?.addEventListener("abort", abort, { once: true });
      let timerError: unknown;
      let timerBusy = false;
      const timer = checkpointEvery === 1 ? undefined : setInterval(() => {
        if (timerBusy || pendingCursor === undefined) return;
        timerBusy = true;
        void checkpoint().catch((error: unknown) => { timerError = error; connection.abort(error); }).finally(() => { timerBusy = false; });
      }, 1_000);
      timer?.unref?.();
      try {
        for await (const event of this.eventStream({
          after: cursor,
          ...(options.include === undefined ? {} : { include: options.include }),
          ...(options.kinds === undefined ? {} : { kinds: options.kinds }),
          signal: connection.signal,
        })) {
          if (connection.signal.aborted) break;
          await options.onEvent(event);
          pendingCursor = event.cursor;
          pendingCount += 1;
          if (pendingCount >= checkpointEvery) await checkpoint();
        }
        await checkpoint();
      } catch (caught) {
        const error = timerError ?? caught;
        try { await checkpoint(); } catch (commitError) {
          if (!reconnect || (commitError instanceof SuperBrainApiError && commitError.status < 500 && commitError.status !== 429)) throw commitError;
          // Resume from the last acknowledged cursor, never an uncommitted callback result.
          pendingCursor = undefined; pendingCount = 0;
        }
        if (options.signal?.aborted === true) return;
        if (!reconnect || (error instanceof SuperBrainApiError && error.status < 500 && error.status !== 429)) throw error;
        if (error instanceof SuperBrainApiError && error.status === 429) {
          const retryAfterSeconds = (error.details as { readonly retryAfterSeconds?: unknown } | undefined)?.retryAfterSeconds;
          if (typeof retryAfterSeconds === "number" && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
            delayMs = Math.max(delayMs, Math.ceil(retryAfterSeconds * 1_000));
          }
        }
      } finally {
        if (timer !== undefined) clearInterval(timer);
        options.signal?.removeEventListener("abort", abort);
        await checkpointChain;
      }
      if (!reconnect || options.signal?.aborted === true) return;
      await sleep(delayMs, options.signal);
    } while (true);
  }
}

export type { MemoryAudience };
export type { MemoryApplicability } from "@_89/fold-epistemic";
