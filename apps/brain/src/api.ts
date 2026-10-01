import { nextEventStamp, uuidV7 } from "./ids";
import type { Episode, EpisodePage, EpisodeSourceRecord, EpisodeWindow, EpisodeWindowSummary } from "./episode-types";
import type { IdentityAttribution, IdentityAttributionInput, IdentityEntity, IdentityEntityInput, IdentityHistory, IdentityKind, IdentityPage, IdentityProject, ProjectAlias, ProjectAliasInput, ProjectAliasPreview } from "./identity-types";
import type {
  ConnectionSettings,
  CaptureHealth,
  CursorPage,
  DerivedTranscriptRecord,
  TranscriptDerivation,
  DataQualityReport,
  FoldLogEntry,
  FleetResponse,
  HookArtifact,
  HookSource,
  MemoryDraft,
  MemoryCandidateView,
  MemoryScope,
  PersonalMemory,
  ProjectionResponse,
  ProjectionSection,
  RecalledMemory,
  RankedMemoryRecallResult,
  ReasoningResponse,
  ReasoningProviderStatus,
  SharedDecisionTree,
  SteeringCandidateDraft,
  SteeringIntentionEnd,
  SteeringResponse,
  TrajectoryImportBundle,
  TrajectoryInput,
  TrajectoryOutcomeRecord,
  TrajectoryTaskReport,
  TrajectoryTaskSummary,
  TranscriptProjectSummary,
  TranscriptArtifactRecord,
  TranscriptRun,
  TranscriptRunDetail,
  TranscriptSource,
} from "./types";

interface ApiErrorBody {
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
    readonly details?: unknown;
  };
}

export class FoldApiError extends Error {
  override readonly name = "FoldApiError";

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

function appendRepeated(params: URLSearchParams, key: string, values?: readonly string[]): void {
  values?.forEach((value) => {
    if (value.trim()) params.append(key, value.trim());
  });
}

export class FoldApiClient {
  constructor(
    private readonly settings: ConnectionSettings,
    private readonly signal?: AbortSignal,
  ) {}

  private workspacePath(resource: string): string {
    return `/v1/organizations/${encodeURIComponent(this.settings.organizationId)}/workspaces/${encodeURIComponent(this.settings.workspaceId)}/${resource}`;
  }

  episodePage<T>(resource: "work-episodes" | "work-episode-windows", options: { cursor?: string; projectId?: string; id?: string; section?: "sources" | "history"; eventId?: string; revision?: string } = {}): Promise<EpisodePage<T>> {
    const params = new URLSearchParams({ limit: options.section === "sources" ? "1" : "100" });
    if (options.cursor !== undefined) params.set("pageCursor", options.cursor);
    if (options.projectId !== undefined) params.set("projectId", options.projectId);
    if (options.eventId !== undefined) params.set("eventId", options.eventId);
    if (options.revision !== undefined) params.set("revision", options.revision);
    const path = `${resource}${options.id === undefined ? "" : `/${encodeURIComponent(options.id)}`}${options.section === undefined ? "" : `/${options.section}`}`;
    return this.request(this.workspacePath(`${path}?${params}`));
  }
  workEpisodes(options: { cursor?: string; projectId?: string } = {}) { return this.episodePage<Episode>("work-episodes", options); }
  episodeWindows(options: { cursor?: string; projectId?: string } = {}) { return this.episodePage<EpisodeWindowSummary>("work-episode-windows", options); }
  workEpisode(id: string): Promise<Episode> { return this.request(this.workspacePath(`work-episodes/${encodeURIComponent(id)}`)); }
  episodeWindow(id: string): Promise<EpisodeWindow> { return this.request(this.workspacePath(`work-episode-windows/${encodeURIComponent(id)}`)); }
  episodeSources(id: string, window = false, cursor?: string, eventId?: string, revision?: string) { return this.episodePage<EpisodeSourceRecord>(window ? "work-episode-windows" : "work-episodes", { id, section: "sources", ...(cursor === undefined ? {} : { cursor }), ...(eventId === undefined ? {} : { eventId }), ...(revision === undefined ? {} : { revision }) }); }
  episodeHistory(id: string, cursor?: string) { return this.episodePage<Episode>("work-episodes", { id, section: "history", ...(cursor === undefined ? {} : { cursor }) }); }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.settings.token}`);
    if (init.body !== undefined) headers.set("content-type", "application/json");
    let response: Response;
    try {
      response = await fetch(`${this.settings.baseUrl}${path}`, {
        ...init,
        headers,
        signal: init.signal ?? this.signal,
      });
    } catch (error) {
      throw new FoldApiError(0, "network_error", error instanceof Error ? error.message : "API request failed");
    }
    const body = (await response.json().catch(() => ({}))) as ApiErrorBody;
    if (!response.ok) {
      throw new FoldApiError(
        response.status,
        body.error?.code ?? "request_failed",
        body.error?.message ?? `API request failed (${response.status})`,
        body.error?.details,
      );
    }
    return body as T;
  }

  private identityPage<T>(resource: "entities" | "attributions" | "aliases" | "history" | "projects", options: {
    readonly cursor?: string; readonly kind?: IdentityKind; readonly active?: boolean;
  } = {}): Promise<IdentityPage<T>> {
    const params = new URLSearchParams({ limit: "100" });
    if (options.cursor !== undefined) params.set("pageCursor", options.cursor);
    if (options.kind !== undefined) params.set("kind", options.kind);
    if (options.active !== undefined) params.set("active", String(options.active));
    return this.request(this.workspacePath(`identities/${resource}?${params}`));
  }

  identityEntities(options: { readonly cursor?: string; readonly kind?: IdentityKind; readonly active?: boolean } = {}) {
    return this.identityPage<IdentityEntity>("entities", options);
  }

  identityAttributions(options: { readonly cursor?: string; readonly active?: boolean } = {}) {
    return this.identityPage<IdentityAttribution>("attributions", options);
  }

  projectAliases(options: { readonly cursor?: string; readonly active?: boolean } = {}) {
    return this.identityPage<ProjectAlias>("aliases", options);
  }

  identityHistory(cursor?: string) {
    return this.identityPage<IdentityHistory>("history", { cursor });
  }

  identityProjects(cursor?: string) {
    return this.identityPage<IdentityProject>("projects", { cursor });
  }

  saveIdentityEntity(input: IdentityEntityInput, expectedRevision: string | null): Promise<unknown> {
    return this.request(this.workspacePath("identities/entities"), { method: "POST", body: JSON.stringify({ expectedRevision, input }) });
  }

  saveIdentityAttribution(input: IdentityAttributionInput, expectedRevision: string | null): Promise<unknown> {
    return this.request(this.workspacePath("identities/attributions"), { method: "POST", body: JSON.stringify({ expectedRevision, input }) });
  }

  previewProjectAlias(input: ProjectAliasInput): Promise<ProjectAliasPreview> {
    return this.request(this.workspacePath("identities/alias-preview"), { method: "POST", body: JSON.stringify({ input }) });
  }

  saveProjectAlias(input: ProjectAliasInput, preview: ProjectAliasPreview): Promise<unknown> {
    return this.request(this.workspacePath("identities/aliases"), { method: "POST", body: JSON.stringify({ expectedRevision: preview.revision, previewToken: preview.previewToken, input }) });
  }

  async captureHealth(): Promise<CaptureHealth> {
    let response: Response;
    try {
      response = await fetch(`${this.settings.captureBaseUrl}/health`, { signal: this.signal });
    } catch (error) {
      throw new FoldApiError(0, "capture_unavailable", error instanceof Error ? error.message : "Capture daemon unavailable");
    }
    const body = await response.json().catch(() => ({})) as CaptureHealth & ApiErrorBody;
    if (!response.ok) {
      throw new FoldApiError(response.status, body.error?.code ?? "capture_unavailable", body.error?.message ?? "Capture daemon unavailable");
    }
    return body;
  }

  async dataQuality(): Promise<DataQualityReport> {
    const response = await this.request<{ readonly report: DataQualityReport }>(this.workspacePath("data-quality"));
    return response.report;
  }

  async transcriptArtifactPage(options: {
    readonly source: TranscriptSource;
    readonly sha256: string;
    readonly limit?: number;
    readonly cursor?: string;
  }): Promise<CursorPage<TranscriptArtifactRecord>> {
    const params = new URLSearchParams();
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    if (options.cursor !== undefined) params.set("cursor", options.cursor);
    let response: Response;
    try {
      response = await fetch(
        `${this.settings.captureBaseUrl}/artifacts/${encodeURIComponent(options.source)}/${encodeURIComponent(options.sha256)}${params.size === 0 ? "" : `?${params}`}`,
        {
          headers: { "x-super-brain-operator-token": this.settings.captureOperatorToken },
          signal: this.signal,
        },
      );
    } catch (error) {
      throw new FoldApiError(0, "artifact_unavailable", error instanceof Error ? error.message : "Transcript artifact unavailable");
    }
    const body = await response.json().catch(() => ({})) as {
      readonly records?: readonly TranscriptArtifactRecord[];
      readonly total?: number;
      readonly nextCursor?: string;
      readonly error?: string;
    };
    if (!response.ok || body.records === undefined || body.total === undefined) {
      if (response.status === 401 || response.status === 403) throw new FoldApiError(response.status, "capture_access_denied", "Local archive access denied: capture operator credential is missing or invalid.");
      throw new FoldApiError(response.status, "artifact_unavailable", body.error ?? "Transcript artifact unavailable");
    }
    return { items: body.records, total: body.total, ...(body.nextCursor === undefined ? {} : { nextCursor: body.nextCursor }) };
  }

  async hookArtifact(source: HookSource, artifactId: string): Promise<HookArtifact> {
    let response: Response;
    try {
      response = await fetch(
        `${this.settings.captureBaseUrl}/hook-artifacts/${encodeURIComponent(source)}/${encodeURIComponent(artifactId)}`,
        {
          headers: { "x-super-brain-operator-token": this.settings.captureOperatorToken },
          signal: this.signal,
        },
      );
    } catch (error) {
      throw new FoldApiError(0, "artifact_unavailable", error instanceof Error ? error.message : "Hook artifact unavailable");
    }
    const body = await response.json().catch(() => ({})) as { readonly artifact?: HookArtifact; readonly error?: string };
    if (!response.ok || body.artifact === undefined) {
      throw new FoldApiError(response.status, "artifact_unavailable", body.error ?? "Hook artifact unavailable");
    }
    return body.artifact;
  }

  async listEvents(options: {
    readonly includeDrafts?: boolean;
    readonly kinds?: readonly string[];
    readonly limit?: number;
  } = {}) {
    return (await this.listEventsPage(options)).items;
  }

  async listEventsPage(options: {
    readonly includeDrafts?: boolean;
    readonly kinds?: readonly string[];
    readonly limit?: number;
    readonly cursor?: string;
    readonly sessionId?: string;
    readonly runId?: string;
    readonly projectId?: string;
    readonly actorId?: string;
  } = {}): Promise<CursorPage<FoldLogEntry>> {
    const params = new URLSearchParams();
    if (options.includeDrafts) params.set("include", "canon+draft");
    appendRepeated(params, "kind", options.kinds);
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    params.set("order", "desc");
    if (options.cursor !== undefined) params.set("pageCursor", options.cursor);
    if (options.sessionId !== undefined) params.set("sessionId", options.sessionId);
    if (options.runId !== undefined) params.set("runId", options.runId);
    if (options.projectId !== undefined) params.set("projectId", options.projectId);
    if (options.actorId !== undefined) params.set("actorId", options.actorId);
    const query = params.size > 0 ? `?${params.toString()}` : "";
    const response = await this.request<{ readonly entries: readonly FoldLogEntry[]; readonly total: number; readonly nextCursor?: string }>(
      `${this.workspacePath("events")}${query}`,
    );
    return {
      items: response.entries,
      total: response.total,
      ...(response.nextCursor === undefined ? {} : { nextCursor: response.nextCursor }),
    };
  }

  async projection(
    includeDrafts = false,
    section: ProjectionSection = "nodes",
    options: { readonly cursor?: string; readonly query?: string } = {},
  ): Promise<ProjectionResponse> {
    const params = new URLSearchParams({ compact: "true", section, limit: "100" });
    if (includeDrafts) params.set("include", "canon+draft");
    if (options.cursor !== undefined) params.set("pageCursor", options.cursor);
    if (options.query?.trim()) params.set("query", options.query.trim());
    return this.request<ProjectionResponse>(`${this.workspacePath("projection")}?${params}`);
  }

  async listTrajectoryTasks(): Promise<readonly TrajectoryTaskSummary[]> {
    return (await this.listTrajectoryTaskPage()).items;
  }

  async listTrajectoryTaskPage(options: { readonly limit?: number; readonly cursor?: string } = {}): Promise<CursorPage<TrajectoryTaskSummary>> {
    const params = new URLSearchParams({ compact: "true" });
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    if (options.cursor !== undefined) params.set("pageCursor", options.cursor);
    const response = await this.request<{ readonly tasks: readonly TrajectoryTaskSummary[]; readonly total: number; readonly nextCursor?: string }>(
      `${this.workspacePath("trajectory-tasks")}${params.size === 0 ? "" : `?${params}`}`,
    );
    return { items: response.tasks, total: response.total, ...(response.nextCursor === undefined ? {} : { nextCursor: response.nextCursor }) };
  }

  async trajectoryReport(taskId: string, options: { readonly limit?: number; readonly cursor?: string } = {}): Promise<TrajectoryTaskReport> {
    const params = new URLSearchParams();
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    if (options.cursor !== undefined) params.set("pageCursor", options.cursor);
    const response = await this.request<{ readonly report: TrajectoryTaskReport }>(
      `${this.workspacePath("trajectory-tasks")}/${encodeURIComponent(taskId)}${params.size === 0 ? "" : `?${params}`}`,
    );
    return response.report;
  }

  async fleet(): Promise<FleetResponse> {
    return this.request<FleetResponse>(this.workspacePath("fleet"));
  }

  async listTranscriptProjects(): Promise<readonly TranscriptProjectSummary[]> {
    const response = await this.request<{ readonly projects: readonly TranscriptProjectSummary[] }>(
      this.workspacePath("transcript-projects"),
    );
    return response.projects;
  }

  async listTranscriptRuns(options: {
    readonly projectId?: string;
    readonly source?: TranscriptSource;
  } = {}): Promise<readonly TranscriptRun[]> {
    return (await this.listTranscriptRunPage(options)).items;
  }

  async listTranscriptRunPage(options: {
    readonly projectId?: string;
    readonly source?: TranscriptSource;
    readonly limit?: number;
    readonly cursor?: string;
  } = {}): Promise<CursorPage<TranscriptRun>> {
    const params = new URLSearchParams();
    if (options.projectId !== undefined) params.set("projectId", options.projectId);
    if (options.source !== undefined) params.set("source", options.source);
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    if (options.cursor !== undefined) params.set("pageCursor", options.cursor);
    const query = params.size === 0 ? "" : `?${params.toString()}`;
    const response = await this.request<{ readonly runs: readonly TranscriptRun[]; readonly total: number; readonly nextCursor?: string }>(
      `${this.workspacePath("transcript-runs")}${query}`,
    );
    return { items: response.runs, total: response.total, ...(response.nextCursor === undefined ? {} : { nextCursor: response.nextCursor }) };
  }

  async transcriptRun(runId: string): Promise<TranscriptRunDetail> {
    return this.request<TranscriptRunDetail>(
      `${this.workspacePath("transcript-runs")}/${encodeURIComponent(runId)}`,
    );
  }

  async transcriptDerivations(runId: string, cursor?: string): Promise<CursorPage<TranscriptDerivation>> {
    const params = new URLSearchParams({ runId, limit: "100" });
    if (cursor !== undefined) params.set("pageCursor", cursor);
    const response = await this.request<{ derivations: TranscriptDerivation[]; total: number; nextCursor?: string }>(`${this.workspacePath("transcript-derivations")}?${params}`);
    return { items: response.derivations, total: response.total, ...(response.nextCursor === undefined ? {} : { nextCursor: response.nextCursor }) };
  }

  async transcriptDerivedRecords(runId: string, derivationId: string, cursor?: string): Promise<CursorPage<DerivedTranscriptRecord>> {
    const params = new URLSearchParams({ runId, limit: "100" });
    if (cursor !== undefined) params.set("pageCursor", cursor);
    const response = await this.request<{ records: DerivedTranscriptRecord[]; total: number; nextCursor?: string }>(`${this.workspacePath("transcript-derivations")}/${encodeURIComponent(derivationId)}?${params}`);
    const items = response.records.map((record) => {
      if (record.dataEncoding !== "base64-json-utf8") return record;
      if (typeof record.data.base64 !== "string") throw new Error("Encoded evidence payload is invalid");
      const data: unknown = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(record.data.base64), (character) => character.charCodeAt(0))));
      if (data === null || typeof data !== "object" || Array.isArray(data)) throw new Error("Decoded evidence payload is invalid");
      return { ...record, data: data as Readonly<Record<string, unknown>> };
    });
    return { items, total: response.total, ...(response.nextCursor === undefined ? {} : { nextCursor: response.nextCursor }) };
  }

  async steering(): Promise<SteeringResponse> {
    return this.request<SteeringResponse>(this.workspacePath("steering"));
  }

  private async steer(actorId: string, body: Readonly<Record<string, unknown>>): Promise<void> {
    await this.request(`${this.workspacePath("steering")}/${encodeURIComponent(actorId)}`, {
      method: "POST",
      body: JSON.stringify({ ...body, stamp: nextEventStamp() }),
    });
  }

  async surfaceSteeringCandidate(draft: SteeringCandidateDraft): Promise<void> {
    const now = Date.now();
    await this.steer(draft.actorId, {
      action: "surface",
      candidate: {
        id: `candidate-${uuidV7(now)}`,
        sourceDriveId: draft.sourceDriveId,
        satisfier: { kind: draft.satisfierKind, ref: draft.satisfierRef },
        aim: draft.aim,
        trigger: draft.trigger,
      },
    });
  }

  async commitSteeringCandidate(actorId: string, candidateId: string): Promise<void> {
    await this.steer(actorId, {
      action: "commit",
      candidateId,
      intentionId: `intention-${uuidV7()}`,
    });
  }

  async declineSteeringCandidate(actorId: string, candidateId: string, reason: string): Promise<void> {
    await this.steer(actorId, { action: "decline", candidateId, reason });
  }

  async recordSteeringAction(actorId: string, intentionId: string): Promise<void> {
    await this.steer(actorId, { action: "acted", intentionId });
  }

  async endSteeringIntention(
    actorId: string,
    intentionId: string,
    end: SteeringIntentionEnd,
  ): Promise<void> {
    await this.steer(actorId, { action: "end", intentionId, end });
  }

  async reasoningProviders(): Promise<readonly ReasoningProviderStatus[]> {
    const response = await this.request<{ readonly providers: readonly ReasoningProviderStatus[] }>(
      this.workspacePath("reasoning/providers"),
    );
    return response.providers;
  }

  async askReasoning(question: string, actorId?: string, providerId?: string): Promise<ReasoningResponse> {
    return this.request<ReasoningResponse>(this.workspacePath("reasoning/ask"), {
      method: "POST",
      body: JSON.stringify({
        question,
        ...(actorId === undefined ? {} : { actorId }),
        ...(providerId === undefined ? {} : { providerId }),
        limit: 5,
      }),
    });
  }

  async recordTrajectoryTree(tree: SharedDecisionTree, spaceId?: string): Promise<void> {
    await this.request(this.workspacePath("trajectory-tasks"), {
      method: "POST",
      body: JSON.stringify({
        stamp: nextEventStamp(),
        ...(spaceId === undefined ? {} : { spaceId }),
        tree,
      }),
    });
  }

  async recordTrajectoryOutcome(input: Pick<TrajectoryOutcomeRecord, "taskId" | "trajectoryId" | "outcome" | "reason" | "previousEventId">): Promise<TrajectoryOutcomeRecord> {
    const result = await this.request<{ readonly record: TrajectoryOutcomeRecord }>(this.workspacePath("trajectory-outcomes"), {
      method: "POST", body: JSON.stringify({ stamp: nextEventStamp(), input }),
    });
    return result.record;
  }

  async trajectoryOutcomes(taskId: string, trajectoryId: string, cursor?: string): Promise<CursorPage<TrajectoryOutcomeRecord>> {
    const query = new URLSearchParams({ taskId, trajectoryId, limit: "100" });
    if (cursor !== undefined) query.set("pageCursor", cursor);
    const result = await this.request<{ readonly records: readonly TrajectoryOutcomeRecord[]; readonly total: number; readonly nextCursor?: string }>(`${this.workspacePath("trajectory-outcomes")}?${query}`);
    return { items: result.records, total: result.total, ...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }) };
  }

  async recordTrajectory(input: TrajectoryInput, spaceId?: string): Promise<void> {
    await this.request(this.workspacePath("trajectories"), {
      method: "POST",
      body: JSON.stringify({
        stamp: nextEventStamp(),
        ...(spaceId === undefined ? {} : { spaceId }),
        input,
      }),
    });
  }

  async importTrajectoryBundle(
    bundle: TrajectoryImportBundle,
    existingTasks: readonly TrajectoryTaskSummary[],
  ): Promise<number> {
    const existing = existingTasks.find(({ taskId }) => taskId === bundle.tree.taskId);
    if (existing !== undefined && JSON.stringify(existing.tree) !== JSON.stringify(bundle.tree)) {
      throw new FoldApiError(409, "trajectory_tree_mismatch", `Task ${bundle.tree.taskId} already has a different shared tree`);
    }
    if (existing === undefined) {
      await this.recordTrajectoryTree(bundle.tree, bundle.spaceId);
    }
    for (const trajectory of bundle.trajectories) {
      await this.recordTrajectory(trajectory, bundle.spaceId);
    }
    return bundle.trajectories.length;
  }

  async recallMemories(options: {
    readonly scope?: MemoryScope;
    readonly tags?: readonly string[];
    readonly sources?: readonly string[];
    readonly projectIds?: readonly string[];
    readonly from?: number;
    readonly to?: number;
    readonly limit?: number;
  } = {}): Promise<readonly RecalledMemory[]> {
    return (await this.recallMemoryPage(options)).items;
  }

  async recallMemoryPage(options: {
    readonly scope?: MemoryScope;
    readonly tags?: readonly string[];
    readonly sources?: readonly string[];
    readonly projectIds?: readonly string[];
    readonly from?: number;
    readonly to?: number;
    readonly limit?: number;
    readonly cursor?: string;
  } = {}): Promise<CursorPage<RecalledMemory>> {
    const params = new URLSearchParams();
    if (options.scope !== undefined) {
      params.set("scope", options.scope.kind);
      if (options.scope.kind === "space") params.set("spaceId", options.scope.spaceId);
    }
    appendRepeated(params, "tag", options.tags);
    appendRepeated(params, "source", options.sources);
    appendRepeated(params, "projectId", options.projectIds);
    if (options.from !== undefined) params.set("from", options.from.toString());
    if (options.to !== undefined) params.set("to", options.to.toString());
    if (options.limit !== undefined) params.set("limit", options.limit.toString());
    if (options.cursor !== undefined) params.set("pageCursor", options.cursor);
    const query = params.size > 0 ? `?${params.toString()}` : "";
    const response = await this.request<{ readonly memories: readonly RecalledMemory[]; readonly total: number; readonly nextCursor?: string }>(
      `${this.workspacePath("memories")}${query}`,
    );
    return { items: response.memories, total: response.total, ...(response.nextCursor === undefined ? {} : { nextCursor: response.nextCursor }) };
  }

  async rankMemories(options: {
    readonly query: string;
    readonly scope?: MemoryScope;
    readonly sources?: readonly string[];
    readonly projectIds?: readonly string[];
    readonly limit?: number;
  }): Promise<RankedMemoryRecallResult> {
    return this.request<RankedMemoryRecallResult>(this.workspacePath("memories/search"), {
      method: "POST",
      body: JSON.stringify(options),
    });
  }

  async createMemory(draft: MemoryDraft): Promise<PersonalMemory> {
    const stamp = nextEventStamp();
    const response = await this.request<{ readonly memory: PersonalMemory }>(
      this.workspacePath("memories"),
      {
        method: "POST",
        body: JSON.stringify({
          stamp,
          input: {
            id: uuidV7(stamp.t),
            audience: draft.audience,
            projectIds: draft.projectIds,
            ...(draft.applicability === undefined ? {} : { applicability: draft.applicability }),
            source: draft.source,
            summary: draft.summary,
            content: draft.content,
            tags: draft.tags,
            ...(draft.spaceId === undefined ? {} : { spaceId: draft.spaceId }),
          },
        }),
      },
    );
    return response.memory;
  }

  async listMemoryCandidates(options: {
    readonly status?: MemoryCandidateView["status"];
    readonly offset?: number;
    readonly limit?: number;
  } = {}): Promise<readonly MemoryCandidateView[]> {
    return (await this.listMemoryCandidatePage(options)).items;
  }

  async listMemoryCandidatePage(options: {
    readonly status?: MemoryCandidateView["status"];
    readonly offset?: number;
    readonly limit?: number;
    readonly cursor?: string;
  } = {}): Promise<CursorPage<MemoryCandidateView>> {
    const query = new URLSearchParams();
    if (options.status !== undefined) query.set("status", options.status);
    if (options.offset !== undefined) query.set("offset", options.offset.toString());
    if (options.limit !== undefined) query.set("limit", options.limit.toString());
    if (options.cursor !== undefined) query.set("pageCursor", options.cursor);
    const response = await this.request<{ readonly candidates: readonly MemoryCandidateView[]; readonly total: number; readonly nextCursor?: string }>(
      `${this.workspacePath("memory-candidates")}${query.size === 0 ? "" : `?${query}`}`,
    );
    return { items: response.candidates, total: response.total, ...(response.nextCursor === undefined ? {} : { nextCursor: response.nextCursor }) };
  }

  async acceptMemoryCandidate(candidateId: string): Promise<PersonalMemory> {
    const stamp = nextEventStamp();
    const memoryStamp = nextEventStamp(stamp.t + 1);
    const response = await this.request<{ readonly memory: PersonalMemory }>(
      `${this.workspacePath("memory-candidates")}/${encodeURIComponent(candidateId)}/accept`,
      {
        method: "POST",
        body: JSON.stringify({ stamp, memoryStamp, memoryId: uuidV7(memoryStamp.t) }),
      },
    );
    return response.memory;
  }

  async acceptMemoryCandidates(
    candidateIds: readonly string[],
    options: { readonly audience: "personal" | "workspace"; readonly spaceId?: string },
  ): Promise<readonly PersonalMemory[]> {
    if (candidateIds.length < 1 || candidateIds.length > 100) {
      throw new TypeError("candidateIds must contain 1 to 100 IDs");
    }
    const acceptances = candidateIds.map((candidateId) => {
      const stamp = nextEventStamp();
      const memoryStamp = nextEventStamp(stamp.t + 1);
      return { candidateId, stamp, memoryStamp, memoryId: uuidV7(memoryStamp.t) };
    });
    const response = await this.request<{ readonly accepted: readonly { readonly memory: PersonalMemory }[] }>(
      this.workspacePath("memory-candidate-promotions"),
      {
        method: "POST",
        body: JSON.stringify({
          audience: options.audience,
          ...(options.spaceId === undefined ? {} : { spaceId: options.spaceId }),
          acceptances,
        }),
      },
    );
    return response.accepted.map(({ memory }) => memory);
  }

  async rejectMemoryCandidate(candidateId: string, reason: string): Promise<void> {
    await this.request(
      `${this.workspacePath("memory-candidates")}/${encodeURIComponent(candidateId)}/reject`,
      { method: "POST", body: JSON.stringify({ stamp: nextEventStamp(), reason }) },
    );
  }

  async reviseMemory(memoryId: string, draft: MemoryDraft): Promise<PersonalMemory> {
    const response = await this.request<{ readonly memory: PersonalMemory }>(
      `${this.workspacePath("memories")}/${encodeURIComponent(memoryId)}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          stamp: nextEventStamp(),
          patch: {
            summary: draft.summary, content: draft.content, tags: draft.tags,
            projectIds: draft.projectIds,
            ...(draft.applicability === undefined ? {} : { applicability: draft.applicability }),
          },
        }),
      },
    );
    return response.memory;
  }

  async forgetMemory(memoryId: string, reason: string): Promise<void> {
    await this.request(
      `${this.workspacePath("memories")}/${encodeURIComponent(memoryId)}`,
      {
        method: "DELETE",
        body: JSON.stringify({ stamp: nextEventStamp(), reason }),
      },
    );
  }

  async recordMemoryFeedback(memoryId: string, signal: "helpful" | "unhelpful" | "superseded", context: { readonly query?: string; readonly detail?: string } = {}): Promise<void> {
    await this.request(
      `${this.workspacePath("memories")}/${encodeURIComponent(memoryId)}/feedback`,
      {
        method: "POST",
        body: JSON.stringify({ stamp: nextEventStamp(), input: { signal, ...context } }),
      },
    );
  }
}
