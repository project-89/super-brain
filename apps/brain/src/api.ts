import { SuperBrainClient, SuperBrainApiError, nextEventStamp, uuidV7, type EventStamp, type EventPageOptions, type RecallProvenance } from "@_89/super-brain-client";
import type { RecallRequest } from "@_89/fold-epistemic";
import { localCaptureRequest } from "./local-capture";
import type { Episode, EpisodePage, EpisodeSourceRecord, EpisodeWindow, EpisodeWindowSummary } from "./episode-types";
import type { IdentityAttribution, IdentityAttributionInput, IdentityEntity, IdentityEntityInput, IdentityHistory, IdentityKind, IdentityPage, IdentityProject, ProjectAlias, ProjectAliasInput, ProjectAliasPreview } from "./identity-types";
import type { ConnectionSettings, CaptureHealth, CursorPage, HookArtifact, HookSource, MemoryDraft, MemoryCandidateView, PersonalMemory, ProjectionSection, SharedDecisionTree, SteeringCandidateDraft, SteeringIntentionEnd, TrajectoryImportBundle, TrajectoryInput, TrajectoryTaskSummary, TranscriptArtifactRecord, TranscriptSource, ProcessingStatus, DataQualityReport, DerivedTranscriptRecord, TranscriptDerivation, TrajectoryOutcomeRecord, TrajectoryTaskReport } from "./types";

// Preserve the existing UI error import while sharing the canonical transport classification.
export { SuperBrainApiError as FoldApiError } from "@_89/super-brain-client";
type RecallOptions = Omit<RecallRequest, "candidates"> & { readonly cursor?: string };

/** Connection and local-private adapter. Every canonical operation delegates to the shared client. */
export class FoldApiClient {
  readonly canonical: SuperBrainClient;
  private readonly pendingCommands = new Map<string, readonly EventStamp[]>();
  private readonly entityIds = new Map<string, string>();
  private readonly producer = `brain-${crypto.randomUUID()}`;
  private entityId(stamp: EventStamp): string { let id = this.entityIds.get(stamp.id); if (id === undefined) { id = uuidV7(stamp.t); this.entityIds.set(stamp.id, id); } return id; }
  private readonly judgments = new Map<string, { readonly subject: RecallProvenance["subject"]; readonly stamp: EventStamp; readonly item: import("@_89/super-brain-client").MemoryFeedbackBatchItem }>();
  constructor(private readonly settings: ConnectionSettings, private readonly signal?: AbortSignal) {
    this.canonical = new SuperBrainClient({ baseUrl: settings.baseUrl, organizationId: settings.organizationId, workspaceId: settings.workspaceId, token: settings.tokenSupplier ?? (() => settings.token), signal, telemetryOutbox: settings.telemetryOutbox, fetch: (...args) => fetch(...args) });
  }
  private async command<T>(operation: string, input: unknown, action: (stamps: readonly EventStamp[]) => Promise<T>, stampCount = 1): Promise<T> {
    const key = `${operation}:${JSON.stringify(input)}`;
    let stamps = this.pendingCommands.get(key);
    if (stamps === undefined) {
      if (this.pendingCommands.size >= 256) throw new SuperBrainApiError(0, "pending_commands_full", "Too many unfinished commands; reconnect before continuing");
      stamps = Array.from({ length: stampCount }, () => nextEventStamp(Date.now(), this.producer)); this.pendingCommands.set(key, stamps);
    }
    const result = await action(stamps); this.pendingCommands.delete(key); for (const stamp of stamps) this.entityIds.delete(stamp.id); return result;
  }
  /**
   * Workspace-scoped read models that the shared client does not expose yet (episodes, identities, data quality,
   * transcript derivations, trajectory outcome review). They use the same connection, credentials and error type.
   */
  private workspacePath(resource: string): string {
    const workspace = encodeURIComponent(this.settings.workspaceId.trim());
    const organization = this.settings.organizationId?.trim();
    return organization ? `/v1/organizations/${encodeURIComponent(organization)}/workspaces/${workspace}/${resource}` : `/v1/workspaces/${workspace}/${resource}`;
  }
  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    let token: string | undefined;
    try { token = (await (this.settings.tokenSupplier?.(this.signal) ?? this.settings.token))?.trim(); }
    catch (error) { throw new SuperBrainApiError(0, "token_unavailable", error instanceof Error ? error.message : "A current access token is unavailable"); }
    if (!token) throw new SuperBrainApiError(0, "token_unavailable", "A current access token is unavailable");
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    if (init.body !== undefined) headers.set("content-type", "application/json");
    let response: Response;
    try { response = await fetch(`${this.settings.baseUrl.replace(/\/+$/, "")}${path}`, { ...init, headers, ...(this.signal === undefined ? {} : { signal: this.signal }) }); }
    catch (error) { throw new SuperBrainApiError(0, this.signal?.aborted ? "aborted" : "network_error", error instanceof Error ? error.message : "API network request failed"); }
    let body: { readonly error?: { readonly code?: string; readonly message?: string; readonly details?: unknown } };
    try { body = await response.json() as typeof body; }
    catch { throw new SuperBrainApiError(response.status, "invalid_response", "API returned an invalid JSON response"); }
    if (!response.ok) throw new SuperBrainApiError(response.status, body.error?.code ?? "request_failed", body.error?.message ?? `Super Brain request failed with HTTP ${response.status}`, body.error?.details);
    return body as T;
  }
  identity() { return this.canonical.identity(); }
  telemetryStatus() { return this.canonical.telemetryStatus(); }
  captureHealth(): Promise<CaptureHealth> { return localCaptureRequest(this.settings, "/health", { operator: false, signal: this.signal }); }
  processingStatus(): Promise<ProcessingStatus> { return localCaptureRequest(this.settings, "/processing", { signal: this.signal }); }
  async transcriptArtifactPage(options: { readonly source: TranscriptSource; readonly sha256: string; readonly limit?: number; readonly cursor?: string }): Promise<CursorPage<TranscriptArtifactRecord>> {
    const query = new URLSearchParams(); if (options.limit !== undefined) query.set("limit", String(options.limit)); if (options.cursor !== undefined) query.set("cursor", options.cursor);
    const result = await localCaptureRequest<{ records: readonly TranscriptArtifactRecord[]; total: number; nextCursor?: string }>(this.settings, `/artifacts/${encodeURIComponent(options.source)}/${encodeURIComponent(options.sha256)}?${query}`, { signal: this.signal });
    return { items: result.records, total: result.total, ...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }) };
  }
  async hookArtifact(source: HookSource, artifactId: string): Promise<HookArtifact> { return (await localCaptureRequest<{ artifact: HookArtifact }>(this.settings, `/hook-artifacts/${encodeURIComponent(source)}/${encodeURIComponent(artifactId)}`, { signal: this.signal })).artifact; }
  listEventsPage(options: EventPageOptions = {}) { return this.canonical.listEventsPage(options); }
  async listEvents(options: EventPageOptions = {}) { return (await this.listEventsPage(options)).items; }
  eventsById(eventIds: readonly string[]) { return this.canonical.listEvents({ eventIds }); }
  projection(includeDrafts = false, section: ProjectionSection = "nodes", options: { readonly cursor?: string; readonly query?: string } = {}) { return this.canonical.projection(includeDrafts, section, options); }
  listTrajectoryTaskPage(options: { readonly limit?: number; readonly cursor?: string } = {}) { return this.canonical.listTrajectoryTaskPage(options); }
  async listTrajectoryTasks() { return (await this.listTrajectoryTaskPage()).items; }
  trajectoryReport(taskId: string, options: { readonly limit?: number; readonly cursor?: string } = {}): Promise<TrajectoryTaskReport> { return this.canonical.trajectoryReport(taskId, options); }
  taskEvidencePage(taskId: string, options: { readonly limit?: number; readonly cursor?: string } = {}) { return this.canonical.taskEvidence(taskId, options); }
  fleet() { return this.canonical.fleet(); }
  listTranscriptProjects() { return this.canonical.listTranscriptProjects(); }
  listTranscriptRunPage(options: { readonly projectId?: string; readonly source?: TranscriptSource; readonly limit?: number; readonly cursor?: string } = {}) { return this.canonical.listTranscriptRunPage(options); }
  async listTranscriptRuns(options: Parameters<FoldApiClient["listTranscriptRunPage"]>[0] = {}) { return (await this.listTranscriptRunPage(options)).items; }
  async transcriptRun(runId: string) { const detail = await this.canonical.transcriptRun(runId); if (detail === undefined) throw new SuperBrainApiError(404, "transcript_run_not_found", "Transcript run is unavailable"); return detail; }
  steering() { return this.canonical.steering(); }
  async surfaceSteeringCandidate(draft: SteeringCandidateDraft): Promise<void> { await this.command("steering.surface", draft, async ([stamp]) => this.canonical.steer(draft.actorId, { action: "surface", candidate: { id: `candidate-${this.entityId(stamp!)}`, sourceDriveId: draft.sourceDriveId, satisfier: { kind: draft.satisfierKind, ref: draft.satisfierRef }, aim: draft.aim, trigger: draft.trigger } }, { stamp })); }
  async commitSteeringCandidate(actorId: string, candidateId: string): Promise<void> { await this.command("steering.commit", { actorId, candidateId }, async ([stamp]) => this.canonical.steer(actorId, { action: "commit", candidateId, intentionId: `intention-${this.entityId(stamp!)}` }, { stamp })); }
  async declineSteeringCandidate(actorId: string, candidateId: string, reason: string): Promise<void> { await this.command("steering.decline", { actorId, candidateId, reason }, async ([stamp]) => this.canonical.steer(actorId, { action: "decline", candidateId, reason }, { stamp })); }
  async recordSteeringAction(actorId: string, intentionId: string): Promise<void> { await this.command("steering.acted", { actorId, intentionId }, async ([stamp]) => this.canonical.steer(actorId, { action: "acted", intentionId }, { stamp })); }
  async endSteeringIntention(actorId: string, intentionId: string, end: SteeringIntentionEnd): Promise<void> { await this.command("steering.end", { actorId, intentionId, end }, async ([stamp]) => this.canonical.steer(actorId, { action: "end", intentionId, end }, { stamp })); }
  async reasoningProviders() { return (await this.canonical.reasoningProviders()).providers; }
  askReasoning(question: string, actorId?: string, providerId?: string) { return this.canonical.askReasoning({ question, ...(actorId === undefined ? {} : { actorId }), ...(providerId === undefined ? {} : { providerId }), limit: 5 }); }
  async recordTrajectoryTree(tree: SharedDecisionTree, spaceId?: string): Promise<void> { await this.command("trajectory.tree", { tree, spaceId }, ([stamp]) => this.canonical.recordTrajectoryTree(stamp!, tree, { spaceId })); }
  async recordTrajectory(input: TrajectoryInput, spaceId?: string): Promise<void> { await this.command("trajectory.run", { input, spaceId }, ([stamp]) => this.canonical.recordTrajectory(stamp!, input, { spaceId })); }
  async importTrajectoryBundle(bundle: TrajectoryImportBundle, existingTasks: readonly TrajectoryTaskSummary[]): Promise<number> {
    const existing = existingTasks.find(({ taskId }) => taskId === bundle.tree.taskId);
    if (existing !== undefined && JSON.stringify(existing.tree) !== JSON.stringify(bundle.tree)) throw new SuperBrainApiError(409, "trajectory_tree_mismatch", `Task ${bundle.tree.taskId} already has a different shared tree`);
    if (existing === undefined) await this.recordTrajectoryTree(bundle.tree, bundle.spaceId);
    for (const trajectory of bundle.trajectories) await this.recordTrajectory(trajectory, bundle.spaceId);
    return bundle.trajectories.length;
  }
  async recallMemoryPage(options: RecallOptions = {}) { const page = await this.canonical.recallMemoryPage(options); return { ...page, items: page.items.map((item) => ({ ...item, ...(page.provenance === undefined ? {} : { presentation: page.provenance }) })) }; }
  async recallMemories(options: RecallOptions = {}) { return (await this.recallMemoryPage(options)).items; }
  async rankMemories(options: Omit<RecallRequest, "candidates"> & { readonly query: string }) {
    const result = await this.canonical.rankMemories(options);
    return { ...result, memories: result.memories.map((item) => ({ ...item, ...(result.provenance === undefined ? {} : { presentation: result.provenance }) })) };
  }
  async createMemory(draft: MemoryDraft): Promise<PersonalMemory> { return this.command("memory.create", draft, async ([stamp]) => (await this.canonical.recordMemory({ id: this.entityId(stamp!), source: draft.source, audience: draft.audience, projectIds: draft.projectIds, summary: draft.summary, content: draft.content, tags: draft.tags, applicability: draft.applicability, ...(draft.spaceId === undefined ? {} : { spaceId: draft.spaceId }) }, undefined, { stamp })).memory); }
  listMemoryCandidatePage(options: { readonly status?: MemoryCandidateView["status"]; readonly offset?: number; readonly limit?: number; readonly cursor?: string } = {}) { return this.canonical.listMemoryCandidatePage(options); }
  async listMemoryCandidates(options: Parameters<FoldApiClient["listMemoryCandidatePage"]>[0] = {}) { return (await this.listMemoryCandidatePage(options)).items; }
  async acceptMemoryCandidate(candidateId: string): Promise<PersonalMemory> { return this.command("memory.accept", candidateId, async ([stamp, memoryStamp]) => (await this.canonical.acceptMemoryCandidate(candidateId, { stamp, memoryStamp, memoryId: this.entityId(memoryStamp!) })).memory, 2); }
  async rejectMemoryCandidate(candidateId: string, reason: string): Promise<void> { await this.command("memory.reject", { candidateId, reason }, ([stamp]) => this.canonical.rejectMemoryCandidate(candidateId, reason, { stamp })); }
  async reviseMemory(memoryId: string, draft: MemoryDraft): Promise<PersonalMemory> { return this.command("memory.revise", { memoryId, draft }, async ([stamp]) => (await this.canonical.reviseMemory(memoryId, { summary: draft.summary, content: draft.content, tags: draft.tags, applicability: draft.applicability }, undefined, { stamp, expectedRevision: draft.expectedRevision })).memory); }
  async forgetMemory(memoryId: string, reason: string): Promise<void> { await this.command("memory.forget", { memoryId, reason }, ([stamp]) => this.canonical.forgetMemory(memoryId, reason, undefined, { stamp })); }
  memoryEvidencePage(memoryId: string, options: { readonly revision?: number; readonly offset?: number; readonly contributionOffset?: number; readonly limit?: number } = {}) { return this.canonical.memoryEvidencePage(memoryId, options); }
  memoryFeedbackSummary(memoryId: string, revision: number) { return this.canonical.memoryFeedbackSummary(memoryId, revision); }
  async recordMemoryFeedback(memory: Pick<PersonalMemory, "id" | "revision">, judgment: "helpful" | "unhelpful" | "superseded", provenance?: RecallProvenance): Promise<void> {
    const key = JSON.stringify([memory.id, memory.revision, judgment]);
    let command = this.judgments.get(key);
    if (command === undefined) {
      const presented = provenance?.items.find((item) => item.memoryId === memory.id && item.memoryRevision === memory.revision);
      if (provenance === undefined || presented === undefined) throw new SuperBrainApiError(0, "feedback_context_unavailable", "Refresh this memory view before recording a judgment");
      if (this.judgments.size >= 256) throw new SuperBrainApiError(0, "pending_commands_full", "Too many unfinished judgments; reconnect before continuing");
      const itemStamp = nextEventStamp(Date.now(), this.producer);
      command = { subject: structuredClone(provenance.subject), stamp: nextEventStamp(Date.now(), this.producer), item: { stamp: itemStamp, memoryId: memory.id, input: { version: 2, memoryRevision: memory.revision, recallId: provenance.recallId, signal: "judged", judgment, rank: presented.rank, ranking: structuredClone(provenance.ranking), ...(provenance.provider === undefined ? {} : { provider: structuredClone(provenance.provider) }) } } };
      this.judgments.set(key, command);
    }
    await this.canonical.recordMemoryFeedbackBatch([command.item], { stamp: command.stamp, expectedSubject: command.subject });
    this.judgments.delete(key);
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

  private identityPage<T>(resource: "entities" | "attributions" | "aliases" | "history" | "projects", options: { readonly cursor?: string; readonly kind?: IdentityKind; readonly active?: boolean } = {}): Promise<IdentityPage<T>> {
    const params = new URLSearchParams({ limit: "100" });
    if (options.cursor !== undefined) params.set("pageCursor", options.cursor);
    if (options.kind !== undefined) params.set("kind", options.kind);
    if (options.active !== undefined) params.set("active", String(options.active));
    return this.request(this.workspacePath(`identities/${resource}?${params}`));
  }
  identityEntities(options: { readonly cursor?: string; readonly kind?: IdentityKind; readonly active?: boolean } = {}) { return this.identityPage<IdentityEntity>("entities", options); }
  identityAttributions(options: { readonly cursor?: string; readonly active?: boolean } = {}) { return this.identityPage<IdentityAttribution>("attributions", options); }
  projectAliases(options: { readonly cursor?: string; readonly active?: boolean } = {}) { return this.identityPage<ProjectAlias>("aliases", options); }
  identityHistory(cursor?: string) { return this.identityPage<IdentityHistory>("history", { cursor }); }
  identityProjects(cursor?: string) { return this.identityPage<IdentityProject>("projects", { cursor }); }
  saveIdentityEntity(input: IdentityEntityInput, expectedRevision: string | null): Promise<unknown> { return this.request(this.workspacePath("identities/entities"), { method: "POST", body: JSON.stringify({ expectedRevision, input }) }); }
  saveIdentityAttribution(input: IdentityAttributionInput, expectedRevision: string | null): Promise<unknown> { return this.request(this.workspacePath("identities/attributions"), { method: "POST", body: JSON.stringify({ expectedRevision, input }) }); }
  previewProjectAlias(input: ProjectAliasInput): Promise<ProjectAliasPreview> { return this.request(this.workspacePath("identities/alias-preview"), { method: "POST", body: JSON.stringify({ input }) }); }
  saveProjectAlias(input: ProjectAliasInput, preview: ProjectAliasPreview): Promise<unknown> { return this.request(this.workspacePath("identities/aliases"), { method: "POST", body: JSON.stringify({ expectedRevision: preview.revision, previewToken: preview.previewToken, input }) }); }

  async dataQuality(): Promise<DataQualityReport> { return (await this.request<{ readonly report: DataQualityReport }>(this.workspacePath("data-quality"))).report; }

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

  async recordTrajectoryOutcome(input: Pick<TrajectoryOutcomeRecord, "taskId" | "trajectoryId" | "outcome" | "reason" | "previousEventId">): Promise<TrajectoryOutcomeRecord> {
    return this.command("trajectory.outcome", input, async ([stamp]) => (await this.request<{ readonly record: TrajectoryOutcomeRecord }>(this.workspacePath("trajectory-outcomes"), { method: "POST", body: JSON.stringify({ stamp, input }) })).record);
  }
  async trajectoryOutcomes(taskId: string, trajectoryId: string, cursor?: string): Promise<CursorPage<TrajectoryOutcomeRecord>> {
    const query = new URLSearchParams({ taskId, trajectoryId, limit: "100" });
    if (cursor !== undefined) query.set("pageCursor", cursor);
    const result = await this.request<{ readonly records: readonly TrajectoryOutcomeRecord[]; readonly total: number; readonly nextCursor?: string }>(`${this.workspacePath("trajectory-outcomes")}?${query}`);
    return { items: result.records, total: result.total, ...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }) };
  }

  /** Bulk proposal acceptance with stable per-command stamps so a retried batch replays the same events. */
  async acceptMemoryCandidates(candidateIds: readonly string[], options: { readonly audience: "personal" | "workspace"; readonly spaceId?: string }): Promise<readonly PersonalMemory[]> {
    if (candidateIds.length < 1 || candidateIds.length > 100) throw new TypeError("candidateIds must contain 1 to 100 IDs");
    return this.command("memory.accept-many", { candidateIds, options }, async (stamps) => {
      const acceptances = candidateIds.map((candidateId, index) => {
        const stamp = stamps[index * 2]!; const memoryStamp = stamps[index * 2 + 1]!;
        return { candidateId, stamp, memoryStamp, memoryId: this.entityId(memoryStamp) };
      });
      const response = await this.request<{ readonly accepted: readonly { readonly memory: PersonalMemory }[] }>(this.workspacePath("memory-candidate-promotions"), {
        method: "POST",
        body: JSON.stringify({ audience: options.audience, ...(options.spaceId === undefined ? {} : { spaceId: options.spaceId }), acceptances }),
      });
      return response.accepted.map(({ memory }) => memory);
    }, candidateIds.length * 2);
  }
}
