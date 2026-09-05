import type { EventPageOptions, ProjectionSection, ProjectionResponse, FleetResponse, SteeringResponse, SteeringCommand, SerializedTrajectoryTaskReport } from "./ports.js";
export * from "./ports.js";
import type { FoldEvent, FoldLogEntry } from "@_89/fold";
import type {
  MemoryAudience,
  MemoryCandidate,
  MemoryCandidateEvidence,
  MemoryRevisionRef,
  MemoryEvidenceContributionInput,
  MemoryCandidateInput,
  MemoryCandidateView,
  MemoryFeedbackInput,
  MemoryFeedbackInputV2,
  MemoryFeedbackSummary,
  MemoryFeedbackRecord,
  MemoryInput,
  MemoryRevisionPatch,
  PersonalMemory,
  RecallRequest,
  RecalledMemory,
} from "@_89/fold-epistemic";
import type { TranscriptProjectSummary, TranscriptRunDetail, MemoryCandidateAcceptanceResult, FoldSdkCursor, FoldDeliveryCursor, FoldConsumerCursor, RankedMemoryRecallResult, SteeringSnapshot, TrajectoryTaskSummary } from "@_89/fold-sdk";
import type { TranscriptEvidenceOrigin } from "@_89/fold-sdk";
import type { TranscriptRun, TranscriptSource } from "@_89/fold-transcript";
import type {
  TrajectoryInput,
  TrajectoryMutationResult,
  TrajectoryTreeMutationResult,
  TrajectoryTreeRecord,
  TaskManifest, AttemptManifest, TaskOutcomeInput, TaskInterventionInput, TaskEvidenceMutationResult, TaskEvidenceRecord,
} from "@_89/fold-trajectory";

export type { MemoryFeedbackInputV2, MemoryFeedbackSummary } from "@_89/fold-epistemic";
export type TokenSupplier = (signal?: AbortSignal) => string | undefined | Promise<string | undefined>;
export interface AuthorizedReadSubject { readonly organizationId: string; readonly workspaceId: string; readonly principalId: string }
export interface RecallProvenance {
  readonly version: 1; readonly recallId: string; readonly subject: AuthorizedReadSubject; readonly observedAt: string;
  readonly operation: "recall" | "search" | "reasoning";
  readonly ranking: { readonly id: string; readonly kind: "lexical" | "semantic" | "explicit"; readonly configRevision?: string };
  readonly provider?: { readonly id: string; readonly configRevision?: string };
  readonly items: readonly { readonly memoryId: string; readonly memoryRevision: number; readonly rank: number }[];
}
export interface MemoryFeedbackBatchItem { readonly stamp: EventStamp; readonly memoryId: string; readonly input: MemoryFeedbackInputV2 }
export interface TelemetryBatch { readonly version: 1; readonly subject: AuthorizedReadSubject; readonly stamp: EventStamp; readonly items: readonly MemoryFeedbackBatchItem[] }
export interface TelemetryOutboxStatus { readonly pending: number; readonly retry: number; readonly denied: number; readonly exhausted: number; readonly unavailable?: string; readonly observedAt: string }
export interface TelemetryOutbox { enqueue(batch: TelemetryBatch): Promise<void>; status(): Promise<TelemetryOutboxStatus>; flush?(options?: { readonly signal?: AbortSignal; readonly maxBatches?: number }): Promise<void>; retryTerminal?(): Promise<number>; discardTerminal?(): Promise<number>; close?(): Promise<void> }
export interface AuthenticatedSession { readonly principalId: string; readonly organizationId: string; readonly identityProvider: "static" | "clerk"; readonly memberships: readonly { readonly organizationId: string; readonly organizationRole: "owner" | "admin" | "member"; readonly workspaceId: string; readonly workspaceRole: "owner" | "admin" | "member" }[] }
export interface AuthorizedIdentity extends AuthorizedReadSubject {
  readonly workspaceRole: "owner" | "admin" | "member" | "viewer";
  readonly spaceRoles: Readonly<Record<string, "admin" | "writer" | "reader">>;
  readonly capabilities: readonly string[];
  readonly taskEvidenceAuthority?: { readonly kind: "human"; readonly principalId: string } | { readonly kind: "integration"; readonly integrationId: string };
  readonly platformDataAccess?: boolean;
}
export interface CursorPage<T> { readonly items: readonly T[]; readonly total: number; readonly nextCursor?: string }
export interface SuperBrainClientOptions {
  readonly baseUrl: string;
  readonly organizationId?: string;
  readonly workspaceId: string;
  readonly token: string | TokenSupplier;
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly telemetryOutbox?: TelemetryOutbox;
  readonly recallTelemetry?: {
    readonly sessionId?: string;
    readonly taskId?: string;
    readonly detail?: string;
  };
}

export interface TrajectoryWriteOptions extends RequestOptions { readonly spaceId?: string; readonly captureIdentity?: Readonly<Record<string, string>> }
export interface TaskEvidencePage {
  readonly items: readonly ({ readonly id: string; readonly kind: "task"; readonly task: TaskManifest } | { readonly id: string; readonly kind: "attempt"; readonly attempt: AttemptManifest } | { readonly id: string; readonly kind: "evidence"; readonly record: TaskEvidenceRecord })[];
  readonly total: number;
  readonly nextCursor?: string;
  readonly evidenceAvailability: "reference-only";
}

export interface EventStamp {
  readonly id: string;
  readonly t: number;
  readonly worldDate: string;
}

export interface RequestOptions { readonly signal?: AbortSignal; readonly timeoutMs?: number }
export interface ReasoningProviderStatus { readonly id: string; readonly kind: "extractive" | "model"; readonly model?: string; readonly configRevision?: string; readonly configured: boolean; readonly isDefault?: boolean }

export interface MutationOptions extends RequestOptions { readonly stamp?: EventStamp; readonly expectedRevision?: number }
export interface MemoryAcceptanceOptions extends MutationOptions { readonly memoryStamp?: EventStamp; readonly memoryId?: string }

export interface StreamedFoldEvent {
  readonly entry: FoldLogEntry;
  readonly cursor: FoldDeliveryCursor;
}

export interface EventStreamOptions {
  readonly after?: FoldConsumerCursor;
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
  readonly onEvent: (event: StreamedFoldEvent) => void | Promise<void>;
}

export interface ReasoningResponse {
  readonly provenance: RecallProvenance;
  readonly feedback?: RankedMemoryRecallResult["feedback"];
  readonly answer: string;
  readonly citations: readonly string[];
  readonly citationRefs: readonly MemoryRevisionRef[];
  readonly provider: { readonly id: string; readonly kind: "extractive" | "model"; readonly configRevision?: string };
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
  get retryable(): boolean { return this.status === 0 ? !["aborted", "invalid_response", "token_unavailable"].includes(this.code) : this.status === 408 || this.status === 429 || this.status >= 500; }
  get terminal(): boolean { return !this.retryable; }

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

const stampProducerInstance = crypto.randomUUID();
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
  if (!Number.isSafeInteger(now) || now < 0 || now > 0xffffffffffff) throw new TypeError("event time must be a non-negative 48-bit integer");
  const t = Math.max(now, lastStampTime);
  if (t === lastStampTime) stampSequence += 1;
  else {
    lastStampTime = t;
    stampSequence = 0;
  }
  return {
    id: `${producer}-${stampProducerInstance}-${t.toString().padStart(13, "0")}-${stampSequence.toString().padStart(4, "0")}`,
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
  private readonly token: string | TokenSupplier;
  private readonly fetchImpl: typeof fetch;
  private readonly defaultSignal: AbortSignal | undefined;
  private readonly timeoutMs: number;
  private readonly telemetryOutbox: TelemetryOutbox | undefined;
  private telemetryUnavailable: string | undefined;
  private readonly recallTelemetry: SuperBrainClientOptions["recallTelemetry"] | undefined;

  constructor(options: SuperBrainClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.organizationId = options.organizationId?.trim();
    this.workspaceId = options.workspaceId.trim();
    this.token = typeof options.token === "string" ? options.token.trim() : options.token;
    this.defaultSignal = options.signal;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.telemetryOutbox = options.telemetryOutbox;
    this.fetchImpl = options.fetch ?? ((...args) => globalThis.fetch(...args));
    this.recallTelemetry = options.recallTelemetry;
    if ((typeof this.token === "string" && this.token.length === 0)) {
      throw new TypeError("token is required");
    }
    if (options.organizationId !== undefined && this.organizationId?.length === 0) {
      throw new TypeError("organizationId must not be empty when provided");
    }
  }

  private workspacePath(resource: string): string {
    if (!this.workspaceId) throw new TypeError("workspaceId is required for workspace operations");
    const workspace = encodeURIComponent(this.workspaceId);
    return this.organizationId === undefined
      ? `/v1/workspaces/${workspace}/${resource}`
      : `/v1/organizations/${encodeURIComponent(this.organizationId)}/workspaces/${workspace}/${resource}`;
  }

  private async tokenFor(signal: AbortSignal): Promise<string> {
    if (signal.aborted) throw signal.reason;
    const token = await this.awaitAbort(Promise.resolve(typeof this.token === "string" ? this.token : this.token(signal)), signal);
    if (!token?.trim()) throw new SuperBrainApiError(0, "token_unavailable", "A current access token is unavailable");
    return token.trim();
  }

  private awaitAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) { void pending.catch(() => undefined); return Promise.reject(signal.reason); }
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  }

  private async request<T>(path: string, init: RequestInit = {}, options: RequestOptions = {}): Promise<T> {
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new TypeError("request timeout must be within 1 to 300000 milliseconds");
    const controller = new AbortController();
    const signals = [this.defaultSignal, options.signal, init.signal].filter((signal): signal is AbortSignal => signal != null);
    const abort = () => controller.abort(signals.find((signal) => signal.aborted)?.reason);
    for (const signal of signals) signal.addEventListener("abort", abort, { once: true });
    if (signals.some((signal) => signal.aborted)) abort();
    const timer = setTimeout(() => controller.abort(new DOMException("Request deadline exceeded", "TimeoutError")), timeoutMs);
    try {
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${await this.tokenFor(controller.signal)}`);
      if (init.body !== undefined) headers.set("content-type", "application/json");
      const response = await this.awaitAbort(this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers, signal: controller.signal }), controller.signal);
      let body: { readonly error?: { readonly code?: string; readonly message?: string; readonly details?: unknown } };
      try { body = await this.awaitAbort(response.json(), controller.signal); }
      catch (error) { if (controller.signal.aborted) throw error; throw new SuperBrainApiError(response.status, "invalid_response", "API returned an invalid JSON response"); }
      if (!response.ok) {
        const hint = response.headers.get("retry-after");
        const delay = hint === null ? undefined : /^\d+(?:\.\d+)?$/.test(hint) ? Number(hint) * 1000 : Math.max(0, Date.parse(hint) - Date.now());
        throw new SuperBrainApiError(response.status, body.error?.code ?? "request_failed", body.error?.message ?? `Super Brain request failed with HTTP ${response.status}`, body.error?.details, delay !== undefined && Number.isFinite(delay) ? delay : undefined);
      }
      if (controller.signal.aborted) throw controller.signal.reason;
      return body as T;
    } catch (error) {
      if (error instanceof SuperBrainApiError) throw error;
      if (controller.signal.aborted) throw new SuperBrainApiError(0, controller.signal.reason instanceof DOMException && controller.signal.reason.name === "TimeoutError" ? "timeout" : "aborted", controller.signal.reason instanceof Error ? controller.signal.reason.message : "Request cancelled");
      throw new SuperBrainApiError(0, "network_error", error instanceof Error ? error.message : "API network request failed");
    } finally { clearTimeout(timer); for (const signal of signals) signal.removeEventListener("abort", abort); }
  }

  async listEventsPage(options: EventPageOptions = {}, request: RequestOptions = {}): Promise<CursorPage<FoldLogEntry>> {
    const query = new URLSearchParams({ order: options.order ?? "desc" });
    if (options.includeDrafts || options.include === "canon+draft") query.set("include", "canon+draft");
    appendRepeated(query, "kind", options.kinds); appendRepeated(query, "eventId", options.eventIds);
    for (const key of ["limit", "sessionId", "runId", "projectId", "actorId"] as const) if (options[key] !== undefined) query.set(key, String(options[key]));
    if (options.cursor !== undefined) query.set("pageCursor", options.cursor);
    const result = await this.request<{ entries: readonly FoldLogEntry[]; total: number; nextCursor?: string }>(`${this.workspacePath("events")}?${query}`, {}, request); return { ...result, items: result.entries };
  }
  projection(includeDrafts = false, section: ProjectionSection = "nodes", options: RequestOptions & { readonly cursor?: string; readonly query?: string } = {}): Promise<ProjectionResponse> {
    const query = new URLSearchParams({ compact: "true", section, limit: "100" }); if (includeDrafts) query.set("include", "canon+draft"); if (options.cursor !== undefined) query.set("pageCursor", options.cursor); if (options.query?.trim()) query.set("query", options.query.trim());
    return this.request(`${this.workspacePath("projection")}?${query}`, {}, options);
  }
  async listTrajectoryTaskPage(options: RequestOptions & { readonly limit?: number; readonly cursor?: string } = {}): Promise<CursorPage<TrajectoryTaskSummary>> {
    const query = new URLSearchParams(); if (options.limit !== undefined) query.set("limit", String(options.limit)); if (options.cursor !== undefined) query.set("pageCursor", options.cursor);
    const result = await this.request<{ tasks: readonly TrajectoryTaskSummary[]; total: number; nextCursor?: string }>(`${this.workspacePath("trajectory-tasks")}?${query}`, {}, options); return { ...result, items: result.tasks };
  }
  async trajectoryReport(taskId: string, options: RequestOptions & { readonly limit?: number; readonly cursor?: string } = {}): Promise<SerializedTrajectoryTaskReport> {
    const query = new URLSearchParams(); if (options.limit !== undefined) query.set("limit", String(options.limit)); if (options.cursor !== undefined) query.set("pageCursor", options.cursor);
    const result = await this.request<{ report: SerializedTrajectoryTaskReport }>(`${this.workspacePath("trajectory-tasks")}/${encodeURIComponent(taskId)}?${query}`, {}, options); return result.report;
  }
  fleet(options: RequestOptions = {}): Promise<FleetResponse> { return this.request(this.workspacePath("fleet"), {}, options); }
  async listTranscriptProjects(options: RequestOptions = {}): Promise<readonly TranscriptProjectSummary[]> { const result = await this.request<{ projects: readonly TranscriptProjectSummary[] }>(this.workspacePath("transcript-projects"), {}, options); return result.projects; }
  async listTranscriptRunPage(options: RequestOptions & { readonly projectId?: string; readonly source?: TranscriptSource; readonly limit?: number; readonly cursor?: string } = {}): Promise<CursorPage<TranscriptRun>> {
    const query = new URLSearchParams(); for (const key of ["projectId", "source", "limit"] as const) if (options[key] !== undefined) query.set(key, String(options[key])); if (options.cursor !== undefined) query.set("pageCursor", options.cursor);
    const result = await this.request<{ runs: readonly TranscriptRun[]; total: number; nextCursor?: string }>(`${this.workspacePath("transcript-runs")}?${query}`, {}, options); return { ...result, items: result.runs };
  }
  steering(options: RequestOptions = {}): Promise<SteeringResponse> { return this.request(this.workspacePath("steering"), {}, options); }
  steer(actorId: string, command: SteeringCommand, options: MutationOptions = {}): Promise<unknown> { return this.request(`${this.workspacePath("steering")}/${encodeURIComponent(actorId)}`, { method: "POST", body: JSON.stringify({ ...command, stamp: options.stamp ?? nextEventStamp() }) }, options); }
  async recallMemoryPage(options: Omit<RecallRequest, "candidates"> & { readonly cursor?: string } = {}, request: RequestOptions = {}): Promise<CursorPage<RecalledMemory> & { readonly provenance: RecallProvenance }> {
    const query = new URLSearchParams(); if (options.scope !== undefined) { query.set("scope", options.scope.kind); if (options.scope.kind === "space") query.set("spaceId", options.scope.spaceId); }
    appendRepeated(query, "tag", options.tags); appendRepeated(query, "source", options.sources); appendRepeated(query, "projectId", options.projectIds);
    for (const key of ["from", "to", "limit", "includeNeedsReview"] as const) if (options[key] !== undefined) query.set(key, String(options[key])); if (options.cursor !== undefined) query.set("pageCursor", options.cursor);
    const result = await this.request<{ memories: readonly RecalledMemory[]; total: number; nextCursor?: string; provenance: RecallProvenance }>(`${this.workspacePath("memories")}?${query}`, {}, request); this.recordRecallTelemetry(result.provenance); return { ...result, items: result.memories };
  }
  async listMemoryCandidatePage(options: { readonly status?: MemoryCandidateView["status"]; readonly projectIds?: readonly string[]; readonly offset?: number; readonly limit?: number; readonly cursor?: string } = {}, request: RequestOptions = {}): Promise<CursorPage<MemoryCandidateView>> {
    const query = new URLSearchParams(); for (const key of ["status", "offset", "limit"] as const) if (options[key] !== undefined) query.set(key, String(options[key])); appendRepeated(query, "projectId", options.projectIds); if (options.cursor !== undefined) query.set("pageCursor", options.cursor);
    const result = await this.request<{ candidates: readonly MemoryCandidateView[]; total: number; nextCursor?: string }>(`${this.workspacePath("memory-candidates")}?${query}`, {}, request); return { ...result, items: result.candidates };
  }

  appendEvent(event: FoldEvent, status: "canon" | "draft" = "canon") {
    return this.request<{ readonly entry: FoldLogEntry }>(this.workspacePath("events"), {
      method: "POST",
      body: JSON.stringify({ event, status }),
    });
  }

  async listEvents(options: { readonly eventIds?: readonly string[]; readonly kinds?: readonly string[]; readonly include?: "canon" | "canon+draft"; readonly limit?: number } = {}): Promise<readonly FoldLogEntry[]> {
    if (options.eventIds !== undefined) {
      if (options.eventIds.length < 1 || options.eventIds.length > 1000 || options.eventIds.some((id) => !id.trim() || id.length > 500)) throw new TypeError("eventIds must contain 1 to 1000 valid event IDs");
      const batches: string[][] = [[]]; let encodedLength = 0;
      for (const id of new Set(options.eventIds)) {
        const length = encodeURIComponent(id).length + 9;
        if (encodedLength + length > 6000 && batches.at(-1)!.length > 0) { batches.push([]); encodedLength = 0; }
        batches.at(-1)!.push(id); encodedLength += length;
      }
      if (batches.length > 1) {
        const entries: FoldLogEntry[] = [];
        for (const batch of batches) entries.push(...await this.listEvents({ ...options, eventIds: batch, limit: batch.length }));
        return entries.sort((a, b) => a.event.at.t - b.event.at.t || (a.event.id < b.event.id ? -1 : a.event.id > b.event.id ? 1 : 0)).slice(0, options.limit ?? 1000);
      }
    }
    const params = new URLSearchParams();
    appendRepeated(params, "eventId", options.eventIds);
    appendRepeated(params, "kind", options.kinds);
    if (options.include !== undefined) params.set("include", options.include);
    if (options.limit !== undefined || options.eventIds !== undefined) params.set("limit", String(options.limit ?? options.eventIds!.length));
    const response = await this.request<{ readonly entries: readonly FoldLogEntry[] }>(
      `${this.workspacePath("events")}${params.size === 0 ? "" : `?${params}`}`,
    );
    return response.entries;
  }

  async transcriptRuns(): Promise<readonly TranscriptRun[]> {
    const response = await this.request<{ readonly runs: readonly TranscriptRun[] }>(this.workspacePath("transcript-runs"));
    return response.runs;
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
    options: TrajectoryWriteOptions = {},
  ): Promise<TrajectoryTreeMutationResult> {
    return this.request(this.workspacePath("trajectory-tasks"), {
      method: "POST",
      body: JSON.stringify({
        stamp,
        tree,
        ...(options.spaceId === undefined ? {} : { spaceId: options.spaceId }),
        ...(options.captureIdentity === undefined ? {} : { captureIdentity: options.captureIdentity }),
      }),
    }, options);
  }

  async transcriptEvidenceOrigins(references: readonly MemoryCandidateEvidence[]): Promise<readonly TranscriptEvidenceOrigin[]> {
    if (references.length > 100) throw new TypeError("at most 100 evidence origins may be resolved");
    const result = await this.request<{ readonly origins: readonly TranscriptEvidenceOrigin[] }>(this.workspacePath("transcript-evidence-origins"), { method: "POST", body: JSON.stringify({ references }) });
    return result.origins;
  }

  private recordTaskEvidence(stamp: EventStamp, input: TaskManifest | AttemptManifest | TaskOutcomeInput | TaskInterventionInput, operation: string, options: TrajectoryWriteOptions): Promise<TaskEvidenceMutationResult> {
    return this.request(this.workspacePath(`trajectory-tasks/${encodeURIComponent(input.taskId)}/${operation}`), { method: "POST", body: JSON.stringify({ stamp, input, ...(options.spaceId === undefined ? {} : { spaceId: options.spaceId }), ...(options.captureIdentity === undefined ? {} : { captureIdentity: options.captureIdentity }) }) }, options);
  }
  recordTaskManifest(stamp: EventStamp, input: TaskManifest, options: TrajectoryWriteOptions = {}): Promise<TaskEvidenceMutationResult> { return this.recordTaskEvidence(stamp, input, "manifests", options); }
  recordAttemptManifest(stamp: EventStamp, input: AttemptManifest, options: TrajectoryWriteOptions = {}): Promise<TaskEvidenceMutationResult> { return this.recordTaskEvidence(stamp, input, "attempts", options); }
  recordTaskOutcome(stamp: EventStamp, input: TaskOutcomeInput, options: TrajectoryWriteOptions = {}): Promise<TaskEvidenceMutationResult> { return this.recordTaskEvidence(stamp, input, "outcomes", options); }
  recordTaskIntervention(stamp: EventStamp, input: TaskInterventionInput, options: TrajectoryWriteOptions = {}): Promise<TaskEvidenceMutationResult> { return this.recordTaskEvidence(stamp, input, "interventions", options); }
  taskEvidence(taskId: string, options: RequestOptions & { readonly limit?: number; readonly cursor?: string } = {}): Promise<TaskEvidencePage> {
    const query = new URLSearchParams(); if (options.limit !== undefined) query.set("limit", String(options.limit)); if (options.cursor !== undefined) query.set("pageCursor", options.cursor);
    return this.request(this.workspacePath(`trajectory-tasks/${encodeURIComponent(taskId)}/evidence`) + (query.size === 0 ? "" : `?${query}`), {}, options);
  }

  async trajectoryTasks(): Promise<readonly TrajectoryTaskSummary[]> {
    const response = await this.request<{ readonly tasks: readonly TrajectoryTaskSummary[] }>(
      this.workspacePath("trajectory-tasks"),
    );
    return response.tasks;
  }

  recordTrajectory(
    stamp: EventStamp,
    input: TrajectoryInput,
    options: TrajectoryWriteOptions = {},
  ): Promise<TrajectoryMutationResult> {
    return this.request(this.workspacePath("trajectories"), {
      method: "POST",
      body: JSON.stringify({
        stamp,
        input,
        ...(options.spaceId === undefined ? {} : { spaceId: options.spaceId }),
        ...(options.captureIdentity === undefined ? {} : { captureIdentity: options.captureIdentity }),
      }),
    }, options);
  }

  reasoningProviders(): Promise<{ readonly providers: readonly ReasoningProviderStatus[] }> { return this.request(this.workspacePath("reasoning/providers")); }

  session(options: RequestOptions = {}): Promise<AuthenticatedSession> { return this.request("/v1/session", {}, options); }

  identity(options: RequestOptions = {}): Promise<AuthorizedIdentity> {
    return this.request(this.workspacePath("identity"), {}, options);
  }

  async transcriptRun(runId: string, options: RequestOptions = {}): Promise<TranscriptRunDetail | undefined> {
    try { return await this.request(`${this.workspacePath("transcript-runs")}/${encodeURIComponent(runId)}`, {}, options); }
    catch (error) { if (error instanceof SuperBrainApiError && error.status === 404) return undefined; throw error; }
  }

  async memoryPage(options: { readonly limit?: number; readonly cursor?: string; readonly projectIds?: readonly string[]; readonly includeNeedsReview?: boolean } = {}): Promise<{ readonly memories: readonly PersonalMemory[]; readonly nextCursor?: string; readonly total: number }> {
    const params = new URLSearchParams();
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    if (options.cursor !== undefined) params.set("pageCursor", options.cursor);
    if (options.includeNeedsReview !== undefined) params.set("includeNeedsReview", String(options.includeNeedsReview));
    appendRepeated(params, "projectId", options.projectIds);
    const page = await this.request<{ memories: readonly RecalledMemory[]; nextCursor?: string; total: number }>(`${this.workspacePath("memories")}${params.size ? `?${params}` : ""}`);
    return { ...page, memories: page.memories.map(({ memory }) => memory) };
  }

  contributeMemoryEvidence(memoryId: string, input: MemoryEvidenceContributionInput, options: MutationOptions = {}): Promise<{ readonly event: FoldEvent; readonly memory: PersonalMemory }> {
    return this.request(`${this.workspacePath("memories")}/${encodeURIComponent(memoryId)}/evidence`, { method: "POST", body: JSON.stringify({ stamp: options.stamp ?? nextEventStamp(), input }) }, options);
  }

  contributeMemoryCandidateEvidence(candidateId: string, input: Pick<MemoryEvidenceContributionInput, "evidence">, options: MutationOptions = {}): Promise<{ readonly event: FoldEvent; readonly candidate: MemoryCandidate }> {
    return this.request(`${this.workspacePath("memory-candidates")}/${encodeURIComponent(candidateId)}/evidence`, { method: "POST", body: JSON.stringify({ stamp: options.stamp ?? nextEventStamp(), input }) }, options);
  }

  memoryEvidencePage(memoryId: string, options: RequestOptions & { readonly revision?: number; readonly offset?: number; readonly limit?: number; readonly contributionOffset?: number } = {}): Promise<{ readonly memoryId: string; readonly revision: number; readonly evidence: readonly MemoryCandidateEvidence[]; readonly contributions: readonly { readonly eventId: string; readonly contributorId: string; readonly contributedAt: number; readonly evidenceCount: number }[]; readonly contributionTotal: number; readonly nextContributionOffset?: number; readonly total: number; readonly nextOffset?: number }> {
    const params = new URLSearchParams(Object.entries(options).filter(([key, value]) => ["revision", "offset", "limit", "contributionOffset"].includes(key) && value !== undefined).map(([key, value]) => [key, String(value)]));
    return this.request(`${this.workspacePath("memories")}/${encodeURIComponent(memoryId)}/evidence${params.size ? `?${params}` : ""}`, {}, options);
  }

  recallMemories(request: Omit<RecallRequest, "candidates"> = {}, options: RequestOptions = {}): Promise<{ readonly memories: readonly RecalledMemory[]; readonly provenance: RecallProvenance }> { return this.recallMemoryPacket(request, options); }
  async recallMemoryPacket(request: Omit<RecallRequest, "candidates"> = {}, options: RequestOptions = {}): Promise<{ readonly memories: readonly RecalledMemory[]; readonly provenance: RecallProvenance }> {
    const result = await this.request<{ readonly memories: readonly RecalledMemory[]; readonly provenance: RecallProvenance }>(this.workspacePath("memories/recall"), { method: "POST", body: JSON.stringify(request) }, options);
    this.recordRecallTelemetry(result.provenance); return result;
  }

  async memoryById(memoryId: string, options: RequestOptions = {}): Promise<PersonalMemory | undefined> {
    try {
      const response = await this.request<{ readonly memory: PersonalMemory }>(
        `${this.workspacePath("memories")}/${encodeURIComponent(memoryId)}`, {}, options,
      );
      return response.memory;
    } catch (error) {
      if (error instanceof SuperBrainApiError && error.status === 404) return undefined;
      throw error;
    }
  }

  async rankMemories(request: Omit<RecallRequest, "candidates"> & { readonly query: string }, options: RequestOptions = {}): Promise<RankedMemoryRecallResult & { readonly provenance: RecallProvenance }> {
    const result = await this.request<RankedMemoryRecallResult & { readonly provenance: RecallProvenance }>(
      this.workspacePath("memories/search"),
      { method: "POST", body: JSON.stringify(request) }, options,
    );
    this.recordRecallTelemetry(result.provenance);
    return result;
  }

  async askReasoning(request: Omit<RecallRequest, "candidates"> & {
    readonly question: string;
    readonly actorId?: string;
    readonly providerId?: string;
    readonly providerConfigRevision?: string;
    readonly memoryIds?: readonly string[];
    readonly memoryRefs?: readonly MemoryRevisionRef[];
  }, options: RequestOptions = {}): Promise<ReasoningResponse> {
    const result = await this.request<ReasoningResponse>(
      this.workspacePath("reasoning/ask"),
      { method: "POST", body: JSON.stringify(request) },
      options,
    );
    this.recordRecallTelemetry(result.provenance);
    return result;
  }

  private recordRecallTelemetry(provenance: RecallProvenance | undefined): void {
    if (this.telemetryOutbox === undefined || provenance === undefined || provenance.items.length === 0) return;
    const items: MemoryFeedbackBatchItem[] = provenance.items.map((item) => ({ stamp: nextEventStamp(), memoryId: item.memoryId, input: { version: 2, memoryRevision: item.memoryRevision, recallId: provenance.recallId, signal: "offered", rank: item.rank, ranking: provenance.ranking, ...(provenance.provider === undefined ? {} : { provider: provenance.provider }), ...(this.recallTelemetry?.taskId === undefined ? {} : { taskId: this.recallTelemetry.taskId }), ...(this.recallTelemetry?.sessionId === undefined ? {} : { sessionId: this.recallTelemetry.sessionId }) } }));
    for (let offset = 0; offset < items.length; offset += 100) {
      const batch: TelemetryBatch = { version: 1, subject: provenance.subject, stamp: nextEventStamp(), items: items.slice(offset, offset + 100) };
      void Promise.resolve().then(() => this.telemetryOutbox!.enqueue(batch)).catch((error: unknown) => { this.telemetryUnavailable = error instanceof Error ? error.message : "Feedback could not be queued"; });
    }
  }
  async repairTelemetry(action: "retry" | "discard-terminal"): Promise<number> {
    const repair = action === "retry" ? this.telemetryOutbox?.retryTerminal : this.telemetryOutbox?.discardTerminal;
    if (repair === undefined) throw new SuperBrainApiError(0, "telemetry_repair_unavailable", "Telemetry repair is unavailable");
    const changed = await repair.call(this.telemetryOutbox);
    this.telemetryUnavailable = undefined;
    return changed;
  }
  async telemetryStatus(): Promise<TelemetryOutboxStatus> {
    try { const status = await this.telemetryOutbox?.status() ?? { pending: 0, retry: 0, denied: 0, exhausted: 0, observedAt: new Date().toISOString(), unavailable: "Telemetry outbox is not configured" }; return this.telemetryUnavailable === undefined ? status : { ...status, unavailable: this.telemetryUnavailable }; }
    catch (error) { return { pending: 0, retry: 0, denied: 0, exhausted: 0, observedAt: new Date().toISOString(), unavailable: error instanceof Error ? error.message : "Telemetry status unavailable" }; }
  }

  recordMemory(input: Omit<MemoryInput, "id"> & { readonly id?: string }, causedBy?: readonly string[], options: MutationOptions = {}) {
    if (options.stamp !== undefined && input.id === undefined) throw new TypeError("stable memory commands require an explicit memory ID");
    const stamp = options.stamp ?? nextEventStamp();
    return this.request<{ readonly event: FoldEvent; readonly memory: PersonalMemory }>(this.workspacePath("memories"), {
      method: "POST",
      body: JSON.stringify({
        stamp,
        input: { ...input, id: input.id ?? uuidV7(stamp.t) },
        ...(causedBy === undefined ? {} : { causedBy }),
      }),
    }, options);
  }

  reviseMemory(memoryId: string, patch: MemoryRevisionPatch, causedBy?: readonly string[], options: MutationOptions = {}) {
    return this.request<{ readonly event: FoldEvent; readonly memory: PersonalMemory }>(
      `${this.workspacePath("memories")}/${encodeURIComponent(memoryId)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ stamp: options.stamp ?? nextEventStamp(), ...(options.expectedRevision === undefined ? {} : { expectedRevision: options.expectedRevision }), patch, ...(causedBy === undefined ? {} : { causedBy }) }),
      }, options,
    );
  }

  forgetMemory(memoryId: string, reason: string, causedBy?: readonly string[], options: MutationOptions = {}) {
    return this.request(`${this.workspacePath("memories")}/${encodeURIComponent(memoryId)}`, {
      method: "DELETE",
      body: JSON.stringify({ stamp: options.stamp ?? nextEventStamp(), reason, ...(causedBy === undefined ? {} : { causedBy }) }),
    }, options);
  }

  recordMemoryFeedback(memoryId: string, input: MemoryFeedbackInputV2, causedBy?: readonly string[], options: MutationOptions = {}) {
    return this.request<{ readonly event: FoldEvent; readonly feedback: MemoryFeedbackRecord }>(`${this.workspacePath("memories")}/${encodeURIComponent(memoryId)}/feedback`, { method: "POST", body: JSON.stringify({ stamp: options.stamp ?? nextEventStamp(), input, ...(causedBy === undefined ? {} : { causedBy }) }) }, options);
  }
  recordMemoryFeedbackBatch(items: readonly MemoryFeedbackBatchItem[], options: RequestOptions & { readonly stamp: EventStamp; readonly expectedSubject: AuthorizedReadSubject }): Promise<{ readonly events: readonly FoldEvent[]; readonly feedback: readonly MemoryFeedbackRecord[] }> {
    if (items.length < 1 || items.length > 100) throw new TypeError("feedback batch requires 1 to 100 items");
    return this.request(this.workspacePath("memory-feedback-batches"), { method: "POST", body: JSON.stringify({ stamp: options.stamp, expectedSubject: options.expectedSubject, items }) }, options);
  }
  async memoryFeedbackSummary(memoryId: string, revision?: number, options: RequestOptions = {}): Promise<MemoryFeedbackSummary> {
    const result = await this.request<{ readonly summary: MemoryFeedbackSummary }>(`${this.workspacePath("memories")}/${encodeURIComponent(memoryId)}/feedback${revision === undefined ? "" : `?revision=${revision}`}`, {}, options); return result.summary;
  }

  proposeMemoryCandidate(
    input: Omit<MemoryCandidateInput, "id"> & { readonly id?: string },
    causedBy?: readonly string[],
    options: MutationOptions = {},
  ) {
    if (options.stamp !== undefined && input.id === undefined) throw new TypeError("stable candidate commands require an explicit candidate ID");
    const stamp = options.stamp ?? nextEventStamp();
    return this.request<{ readonly event: FoldEvent; readonly candidate: MemoryCandidate }>(this.workspacePath("memory-candidates"), {
      method: "POST",
      body: JSON.stringify({
        stamp,
        input: { ...input, id: input.id ?? uuidV7(stamp.t) },
        ...(causedBy === undefined ? {} : { causedBy }),
      }),
    }, options);
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

  acceptMemoryCandidate(candidateId: string, options: MemoryAcceptanceOptions = {}): Promise<MemoryCandidateAcceptanceResult> {
    if ((options.stamp !== undefined && options.memoryId === undefined) || (options.memoryStamp !== undefined && options.stamp === undefined)) throw new TypeError("stable acceptance requires an explicit decision stamp and memory ID");
    const stamp = options.stamp ?? nextEventStamp();
    const memoryStamp = options.memoryStamp ?? (options.stamp === undefined ? nextEventStamp(stamp.t + 1) : { ...stamp, id: `${stamp.id}:memory`, t: stamp.t + 1 });
    return this.request(`${this.workspacePath("memory-candidates")}/${encodeURIComponent(candidateId)}/accept`, {
      method: "POST",
      body: JSON.stringify({ stamp, memoryStamp, memoryId: options.memoryId ?? uuidV7(memoryStamp.t) }),
    }, options);
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

  rejectMemoryCandidate(candidateId: string, reason: string, options: MutationOptions = {}) {
    return this.request(`${this.workspacePath("memory-candidates")}/${encodeURIComponent(candidateId)}/reject`, {
      method: "POST",
      body: JSON.stringify({ stamp: options.stamp ?? nextEventStamp(), reason }),
    }, options);
  }

  async consumerCursor(consumerId: string): Promise<FoldConsumerCursor | undefined> {
    const response = await this.request<{ readonly cursor?: FoldConsumerCursor | null }>(
      `${this.workspacePath("consumers")}/${encodeURIComponent(consumerId)}`,
    );
    return response.cursor ?? undefined;
  }

  commitConsumerCursor(consumerId: string, cursor: FoldConsumerCursor): Promise<unknown> {
    return this.request(`${this.workspacePath("consumers")}/${encodeURIComponent(consumerId)}`, {
      method: "POST",
      body: JSON.stringify({ cursor }),
    });
  }

  async *eventStream(options: EventStreamOptions = {}): AsyncGenerator<StreamedFoldEvent> {
    const params = new URLSearchParams();
    if (options.after !== undefined) {
      if ("version" in options.after) params.set("afterSequence", options.after.sequence);
      else {
        params.set("afterT", options.after.t.toString());
        params.set("afterEventId", options.after.eventId);
      }
    }
    if (options.replay !== undefined) params.set("replay", options.replay);
    if (options.include !== undefined) params.set("include", options.include);
    appendRepeated(params, "kind", options.kinds);
    const controller = new AbortController();
    const signals = [options.signal, this.defaultSignal].filter((signal): signal is AbortSignal => signal !== undefined);
    const abort = () => controller.abort(signals.find((signal) => signal.aborted)?.reason);
    for (const signal of signals) signal.addEventListener("abort", abort, { once: true });
    if (signals.some((signal) => signal.aborted)) abort();
    const timer = setTimeout(() => controller.abort(new DOMException("Stream connection deadline exceeded", "TimeoutError")), this.timeoutMs);
    try {
    const response = await this.awaitAbort(this.fetchImpl(
      `${this.baseUrl}${this.workspacePath("event-stream")}${params.size === 0 ? "" : `?${params}`}`,
      {
        headers: { authorization: `Bearer ${await this.tokenFor(controller.signal)}` },
        signal: controller.signal,
      },
    ), controller.signal);
    if (!response.ok) {
      const body = await this.awaitAbort(response.json(), controller.signal).catch((error: unknown) => { if (controller.signal.aborted) throw error; return {}; }) as {
        readonly error?: { readonly code?: string; readonly message?: string; readonly details?: unknown };
      };
      throw new SuperBrainApiError(
        response.status,
        body.error?.code ?? "stream_failed",
        body.error?.message ?? "Event stream failed",
        body.error?.details,
      );
    }
    clearTimeout(timer);
    if (response.body === null) throw new SuperBrainApiError(502, "stream_unavailable", "Event stream has no response body");
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    try {
      while (true) {
        const { value, done } = await this.awaitAbort(reader.read(), controller.signal);
        buffer += value ?? "";
        if (buffer.length > 4 * 1024 * 1024) throw new SuperBrainApiError(502, "stream_frame_too_large", "Event stream frame exceeded its limit");
        let boundary: number;
        while ((boundary = buffer.search(/\r?\n\r?\n/)) >= 0) {
          const frame = buffer.slice(0, boundary);
          const separator = buffer.slice(boundary).match(/^\r?\n\r?\n/)?.[0] ?? "\n\n";
          buffer = buffer.slice(boundary + separator.length);
          const lines = frame.split(/\r?\n/);
          const eventName = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
          if (eventName !== "fold-event" && eventName !== "stream-error") continue;
          const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
          if (data.length > 0 && eventName === "stream-error") {
            const failure = JSON.parse(data) as { status?: number; code?: string; message?: string };
            throw new SuperBrainApiError(failure.status ?? 503, failure.code ?? "stream_failed", failure.message ?? "Event stream failed");
          }
          if (data.length > 0) yield JSON.parse(data) as StreamedFoldEvent;
        }
        if (done) break;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    } catch (error) {
      if (error instanceof SuperBrainApiError) throw error;
      if (controller.signal.aborted) throw new SuperBrainApiError(0, controller.signal.reason instanceof DOMException && controller.signal.reason.name === "TimeoutError" ? "timeout" : "aborted", "Event stream cancelled");
      throw new SuperBrainApiError(0, error instanceof SyntaxError ? "invalid_response" : "network_error", error instanceof Error ? error.message : "Event stream failed");
    } finally { clearTimeout(timer); controller.abort(); for (const signal of signals) signal.removeEventListener("abort", abort); }
  }

  async consumeEvents(options: ConsumeEventOptions): Promise<void> {
    let cursor = await this.consumerCursor(options.consumerId);
    const reconnect = options.reconnect ?? true;
    do {
      let delayMs = options.reconnectDelayMs ?? 1_000;
      try {
        for await (const event of this.eventStream({
          ...(cursor === undefined ? { replay: options.replay ?? "tail" } : { after: cursor }),
          ...(options.include === undefined ? {} : { include: options.include }),
          ...(options.kinds === undefined ? {} : { kinds: options.kinds }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        })) {
          await options.onEvent(event);
          await this.commitConsumerCursor(options.consumerId, event.cursor);
          cursor = event.cursor;
        }
      } catch (error) {
        if (options.signal?.aborted === true) return;
        if (!reconnect || (error instanceof SuperBrainApiError && !error.retryable)) throw error;
        if (error instanceof SuperBrainApiError && error.retryAfterMs !== undefined) delayMs = Math.max(delayMs, error.retryAfterMs);
        if (error instanceof SuperBrainApiError && error.status === 429) {
          const retryAfterSeconds = (error.details as { readonly retryAfterSeconds?: unknown } | undefined)?.retryAfterSeconds;
          if (typeof retryAfterSeconds === "number" && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
            delayMs = Math.max(delayMs, Math.ceil(retryAfterSeconds * 1_000));
          }
        }
      }
      if (!reconnect || options.signal?.aborted === true) return;
      await sleep(delayMs, options.signal);
    } while (true);
  }
}

export type { MemoryAudience };
