import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { FoldEvent } from "@_89/fold";
import { episodeWindowInputSchema, memoryLogRecordsFromEvent, type EpisodeWindowInput, type MemoryCandidateEvidence, type MemoryCandidateView, type PersonalMemory } from "@_89/fold-epistemic";
import { transcriptDerivationChunkSchema, transcriptRecordsFromEvent, type TranscriptRun } from "@_89/fold-transcript";
import { trajectoryLogRecordsFromEvent } from "@_89/fold-trajectory";
import { SuperBrainApiError, SuperBrainClient, type EventStamp } from "@_89/super-brain-client";
import { deterministicCandidateId, extractedClaimContent, extractLiveMemoryCandidates, extractMemoryCandidates, RULE_EXTRACTOR } from "./extractor.js";
import { DurableWorkerJobs, jobDigest, ProcessingBackpressureError, processingDigest, workerJobNamespace, type ProcessingCoverage, type WorkerJob, type WorkerJobState } from "./jobs.js";
import type { ExtractedCandidate, RunExtraction, VaultMessage } from "./types.js";
import { readVaultEvidence } from "./vault.js";
import { verifiedTaskAcceptance } from "./authority.js";
import { publishWorkerProcessingStatus, type WorkerProcessingStatus } from "./status.js";
import { DurableWindowScheduler, readSchedulingCoverage, validateSchedulingWindow, type SchedulingWindow } from "./scheduler.js";
import { MEMORY_WORKER_EVENT_KINDS } from "./subscription.js";

export interface WorkerOptions {
  readonly client: SuperBrainClient;
  readonly vaultRoot: string;
  readonly vaultEncryptionKey?: Uint8Array;
  readonly stateRoot?: string;
  readonly statusFile?: string;
  /** Per-kind dispatch budget, never a source extraction limit. */
  readonly maxCandidatesPerRun?: number;
  readonly audience?: "personal" | "workspace";
  readonly spaceId?: string;
  readonly autoPromote?: boolean;
  readonly continuousCognition?: boolean;
  readonly cognitionEveryEvents?: number;
  readonly cognitionProviderId?: string;
  /** Project-scoped work-episode formation over exact durable source windows. */
  readonly episodeFormation?: boolean;
  readonly episodeEveryEvents?: number;
  readonly episodeElapsedMs?: number;
  /** Active ledger capacity; intake pauses (transport checkpoint unchanged) when reached. */
  readonly maxActiveJobs?: number;
  readonly modelTimeoutMs?: number;
  readonly maxModelAttempts?: number;
  readonly verifyCapturedEvent?: (event: FoldEvent) => Promise<boolean>;
  readonly verifyCapturedTrajectory?: (event: FoldEvent) => Promise<boolean>;
  readonly retryBaseMs?: number;
  readonly pollIntervalMs?: number;
  readonly reconciliationIntervalMs?: number;
  readonly now?: () => number;
  readonly reportWarning?: (message: string) => void;
  readonly reportCoverage?: (coverage: ProcessingCoverage) => void | Promise<void>;
}
const PROMPTS = [
  { kind: "synthesis", question: "What reusable principle is supported across separate projects? Cite only supplied memories." },
  { kind: "contradiction", question: "Which current memories conflict or need a scope qualification? Cite only supplied memories." },
  { kind: "procedure", question: "What repeatable cross-project procedure is supported by the supplied memories?" },
  { kind: "investigation", question: "What unresolved cross-project investigation is warranted by the supplied memories?" },
] as const;
function evidenceKey(item: MemoryCandidateEvidence): string {
  const source = [item.eventId, item.runId ?? "", item.turnId ?? ""];
  return jobDigest([source, item.projectId ?? "", item.relation ?? "supports"]);
}
function uniqueEvidence(items: readonly MemoryCandidateEvidence[]): MemoryCandidateEvidence[] {
  return [...new Map(items.map((item) => [evidenceKey(item), item])).values()];
}
function applicability(candidate: Pick<ExtractedCandidate, "applicability" | "projectIds">) {
  const value = candidate.applicability ?? ((candidate.projectIds?.length ?? 0) > 0
    ? { kind: "projects" as const, projectIds: [...candidate.projectIds!].sort() } : { kind: "unresolved" as const });
  return value.kind === "projects" ? { kind: "projects" as const, projectIds: [...new Set(value.projectIds)].sort() } : value;
}
function applicableProjects(memory: PersonalMemory): readonly string[] { const value = applicability(memory); return value.kind === "projects" ? value.projectIds : []; }
function candidateKey(candidate: Pick<ExtractedCandidate, "audience" | "spaceId" | "source" | "summary" | "content" | "extractor" | "projectIds" | "applicability" | "sourceMemoryRefs">, owner: string): string {
  return jobDigest([candidate.audience ?? "personal", candidate.audience === "workspace" ? "" : owner,
    candidate.spaceId ?? "", applicability(candidate), candidate.source,
    candidate.summary.toLowerCase().replace(/\s+/g, " ").trim(), extractedClaimContent(candidate), candidate.sourceMemoryRefs ?? []]);
}
/** The sole consolidation policy preserves visibility, applicability and distinct evidence. */
export function consolidateCandidateEvidence(inputs: readonly ExtractedCandidate[], defaults: {
  readonly principalId: string; readonly audience: "personal" | "workspace"; readonly spaceId?: string;
}): ExtractedCandidate[] {
  const grouped = new Map<string, ExtractedCandidate>();
  for (const input of inputs) {
    const candidate: ExtractedCandidate = { ...input, audience: input.audience ?? defaults.audience, applicability: applicability(input),
      ...(input.spaceId === undefined && defaults.spaceId !== undefined ? { spaceId: defaults.spaceId } : {}) };
    const key = candidateKey(candidate, defaults.principalId);
    const existing = grouped.get(key);
    grouped.set(key, existing === undefined ? { ...candidate, evidence: uniqueEvidence(candidate.evidence) } : {
      ...existing, evidence: uniqueEvidence([...existing.evidence, ...candidate.evidence]),
      tags: [...new Set([...(existing.tags ?? []), ...(candidate.tags ?? [])])],
    });
  }
  return [...grouped.values()];
}
interface ProposalPayload { readonly candidate: ExtractedCandidate; readonly witnessEvent?: FoldEvent; readonly trajectoryEvent?: FoldEvent; readonly stamps?: Readonly<Record<string, EventStamp>> }
interface RunPayload { readonly run: TranscriptRun; readonly eventId: string }
interface TurnPayload extends RunPayload { readonly messages: readonly VaultMessage[] }
interface SynthesisPayload {
  readonly prompt: (typeof PROMPTS)[number]; readonly memories: readonly PersonalMemory[];
  readonly providerId: string; readonly providerRevision: string;
  readonly result?: Awaited<ReturnType<SuperBrainClient["askReasoning"]>>;
}
interface EpisodePayload {
  readonly window: SchedulingWindow;
  readonly anchor: FoldEvent;
  readonly episode?: EpisodeWindowInput;
  readonly episodeContext?: { readonly ids: readonly string[]; readonly omitted: boolean };
}
class JobDisposition extends Error {
  constructor(readonly state: "waiting" | "excluded" | "blocked", readonly reason: string) { super(reason); }
}
const COGNITION_TRIGGER_KINDS = ["trajectory.recorded", "trajectory.outcome-recorded", "memory.recorded", "memory.revised"];
const EPISODE_CAPACITY = 200;

function completionSignal(event: FoldEvent): boolean {
  return trajectoryLogRecordsFromEvent(event).some((record) =>
    record.recordType === "outcome" ? record.outcome !== "unknown" : record.recordType === "trajectory" && record.trajectory.outcome !== "unknown");
}

/** Operator repair reads honour bounded server rate limits instead of failing a partial pass. */
async function repairRequest<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try { return await operation(); } catch (error) {
      if (!(error instanceof SuperBrainApiError) || error.status !== 429 || attempt >= 3) throw error;
      const details = error.details as { readonly retryAfterSeconds?: unknown } | undefined;
      const seconds = typeof details?.retryAfterSeconds === "number" ? details.retryAfterSeconds : 1;
      if (!Number.isFinite(seconds) || seconds > 300) throw error;
      await delay(Math.max(1, seconds) * 1_000);
    }
  }
}

export class TranscriptMemoryWorker {
  private store: DurableWorkerJobs | undefined;
  private opening: Promise<DurableWorkerJobs> | undefined;
  private principalId: string | undefined;
  private statusSubject: WorkerProcessingStatus["subject"] | undefined;
  private statusPublishing: Promise<void> = Promise.resolve();
  private draining: Promise<{ proposed: number; promoted: number }> | undefined;
  private modelDraining: Promise<void> | undefined;
  private readonly modelRequests = new Set<AbortController>();
  private closing = false;
  private watchController: AbortController | undefined;
  private background: Promise<unknown>[] = [];
  private projectRoots: Array<{ root: string; projectId: string }> = [];
  private readonly episodeRuns = new Map<string, TranscriptRun>();
  private readonly episodeProjects = new Set<string>();
  private episodeScheduler: DurableWindowScheduler | undefined;
  private readonly evidenceTimes = new Map<string, number>();
  private readonly sourceOrigins = new Map<string, string>();
  private readonly now: () => number;
  constructor(private readonly options: WorkerOptions) {
    this.now = options.now ?? Date.now;
    const budget = options.maxCandidatesPerRun ?? 25;
    if (!Number.isInteger(budget) || budget < 1 || budget > 500) throw new TypeError("proposal dispatch budget must be within [1,500]");
    if (!Number.isInteger(options.maxModelAttempts ?? 3) || (options.maxModelAttempts ?? 3) < 1 || (options.maxModelAttempts ?? 3) > 10) throw new TypeError("maxModelAttempts must be within [1,10]");
  }
  private jobs(): Promise<DurableWorkerJobs> {
    if (this.closing && this.opening === undefined) return Promise.reject(new Error("Worker is closed"));
    if (this.opening === undefined) this.opening = (async () => {
      const identity = await this.options.client.identity();
      if (this.closing) throw new Error("Worker is closing");
      this.principalId = identity.principalId;
      this.statusSubject = { ...identity, organizationId: identity.organizationId ?? "local" };
      const namespace = workerJobNamespace(identity, { audience: this.options.audience ?? "workspace", ...(this.options.spaceId === undefined ? {} : { spaceId: this.options.spaceId }) });
      const store = new DurableWorkerJobs(this.options.stateRoot ?? join(homedir(), ".local", "state", "super-brain", "memory-worker", "jobs"), namespace, this.options.maxActiveJobs);
      await store.open(); this.store = store; await this.publishStatus("running"); return store;
    })().catch((error) => { this.opening = undefined; throw error; });
    return this.opening;
  }
  async close(): Promise<void> {
    this.closing = true;
    this.watchController?.abort();
    for (const controller of this.modelRequests) controller.abort(new Error("worker-closed"));
    await Promise.allSettled([...this.background, this.draining, this.modelDraining, this.opening]);
    await this.publishStatus("stopped");
    await this.store?.close(); this.store = undefined; this.opening = undefined; this.episodeScheduler = undefined;
  }
  private publishStatus(status: WorkerProcessingStatus["status"]): Promise<void> {
    return this.statusPublishing = this.statusPublishing.then(async () => {
      if (this.options.statusFile === undefined || this.store === undefined || this.statusSubject === undefined) return;
      try { await publishWorkerProcessingStatus(this.options.statusFile, { version: 1, observedAt: new Date(this.now()).toISOString(), status: this.closing ? "stopped" : status, subject: this.statusSubject, coverage: await this.store.coverage() }); }
      catch { this.options.reportWarning?.("Processing status publication is unavailable"); }
    });
  }
  configureProjectRoots(runs: readonly TranscriptRun[]): void {
    for (const run of runs) this.rememberEpisodeRun(run);
    this.projectRoots = runs.flatMap((run) => run.segments.flatMap((segment) =>
      segment.cwd && segment.projectId && !segment.cwd.includes("/.claude-mem/observer-sessions")
        ? [{ root: segment.cwd.replace(/\/$/, ""), projectId: segment.projectId }] : [])).sort((a, b) => b.root.length - a.root.length);
  }
  private resolveCandidate(candidate: ExtractedCandidate): ExtractedCandidate {
    if ((candidate.projectIds?.length ?? 0) > 0) return { ...candidate, applicability: applicability(candidate) };
    const content = candidate.content;
    const files = content !== null && typeof content === "object" && !Array.isArray(content) && Array.isArray(content.files) ? content.files : [];
    const projects = [...new Set(files.flatMap((file) => {
      if (typeof file !== "string") return [];
      const match = this.projectRoots.find(({ root }) => file === root || file.startsWith(`${root}/`));
      return match === undefined ? [] : [match.projectId];
    }))].sort();
    return projects.length === 0 ? { ...candidate, applicability: applicability(candidate) } : {
      ...candidate, projectIds: projects, applicability: { kind: "projects", projectIds: projects },
    };
  }
  private async candidateViews(): Promise<MemoryCandidateView[]> {
    const views: MemoryCandidateView[] = [];
    for (let offset = 0; ; offset += 1_000) {
      const page = await this.options.client.memoryCandidates({ offset, limit: 1_000 });
      views.push(...page); if (page.length < 1_000) return views;
    }
  }
  private async enqueueCandidates(candidates: readonly ExtractedCandidate[], witnessEvent?: FoldEvent, trajectoryEvent?: FoldEvent): Promise<number> {
    const jobs = await this.jobs();
    const merged = consolidateCandidateEvidence(candidates.map((candidate) => this.resolveCandidate(candidate)), {
      principalId: this.principalId!, audience: this.options.audience ?? "workspace",
      ...(this.options.spaceId === undefined ? {} : { spaceId: this.options.spaceId }),
    });
    let admitted = 0;
    for (const candidate of merged) {
      const identity = [candidateKey(candidate, this.principalId!), candidate.evidence.map(evidenceKey).sort(), candidate.extractor, ...(trajectoryEvent === undefined ? [] : [trajectoryEvent.id])];
      if (await jobs.get(jobs.identify("propose", identity)) === undefined) admitted++;
      await jobs.enqueue("propose", identity, {
        candidate, ...(witnessEvent === undefined ? {} : { witnessEvent }), ...(trajectoryEvent === undefined ? {} : { trajectoryEvent }),
      } satisfies ProposalPayload, this.now());
    }
    return admitted;
  }
  async extractRun(run: TranscriptRun, runEventId: string): Promise<RunExtraction> {
    const detail = await this.options.client.transcriptRun(run.id);
    if (detail === undefined) return { run, source: run.source, candidates: [], skippedReason: "canonical run metadata unavailable" };
    const result = await readVaultEvidence(this.options.vaultRoot, run, { artifact: detail.artifact,
      canonicalTurns: detail.chunks.flatMap(({ turns }) => turns),
      ...(this.options.vaultEncryptionKey === undefined ? {} : { encryptionKey: this.options.vaultEncryptionKey }) });
    if (result.status !== "ready") return { run, source: run.source, candidates: [], skippedReason: result.reason };
    return { run, source: run.source, candidates: extractMemoryCandidates(run, runEventId, result.messages).map((candidate) => this.resolveCandidate(candidate)) };
  }
  async propose(candidates: readonly ExtractedCandidate[]): Promise<number> {
    await this.enqueueCandidates(candidates); return (await this.drainJobs()).proposed;
  }
  private async stamp(job: WorkerJob, action: string, minimum = 0): Promise<EventStamp> {
    const jobs = await this.jobs();
    const current = await jobs.get(job.id) ?? job;
    const payload = current.payload as ProposalPayload;
    const existing = payload.stamps?.[action];
    if (existing !== undefined) return existing;
    const t = Math.max(this.now(), minimum);
    const stamp = { id: `memory-worker-${job.id}-${action}`, t, worldDate: new Date(t).toISOString().slice(0, 10) };
    // Persist the exact first dispatch before I/O. Ambiguous acknowledgements retry
    // the same command, even after a restart or a later source timestamp.
    await jobs.put({ ...current, payload: { ...payload, stamps: { ...payload.stamps, [action]: stamp } }, updatedAt: this.now() });
    return stamp;
  }
  private async applyProposal(job: WorkerJob): Promise<{ proposed: number; promoted: number }> {
    const { witnessEvent, trajectoryEvent } = job.payload as ProposalPayload;
    let { candidate } = job.payload as ProposalPayload;
    if (witnessEvent !== undefined) this.rememberEvidenceTime(witnessEvent.id, witnessEvent.at.t);
    const minimumSourceTime = await this.sourceTime(candidate);
    candidate = { ...candidate, evidence: uniqueEvidence(candidate.evidence) };
    const identity = candidateKey(candidate, this.principalId!);
    const views = await this.candidateViews();
    let existing: MemoryCandidateView | undefined;
    let memory: PersonalMemory | undefined;
    for (const view of views.filter((view) => candidateKey(view.candidate, view.candidate.proposerId) === identity && view.status !== "rejected")) {
      if (view.status !== "accepted" || view.decision?.kind !== "accepted") { existing = view; break; }
      const current = await this.options.client.memoryById(view.decision.memoryId);
      if (current === undefined || current.currentness?.status === "superseded") continue;
      const currentKey = candidateKey({ ...candidate, ...current, extractor: candidate.extractor }, current.creatorId);
      if (currentKey !== identity) continue; // A human correction changed the claim; propose new evidence for review.
      existing = view; memory = current; break;
    }
    let proposed = 0;
    if (existing === undefined) {
      if (views.some((view) => view.candidate.id === candidate.id)) {
        candidate = { ...candidate, id: deterministicCandidateId(job.createdAt, `${job.id}:separate-claim`) };
        const jobs = await this.jobs();
        await jobs.put({ ...(await jobs.get(job.id))!, payload: { ...job.payload as ProposalPayload, candidate }, updatedAt: this.now() });
      }
      await this.options.client.proposeMemoryCandidate({ ...candidate, evidence: candidate.evidence.slice(0, 100) }, undefined, { stamp: await this.stamp(job, "proposal", minimumSourceTime) });
      proposed = 1;
      existing = (await this.candidateViews()).find((view) => view.candidate.id === candidate.id);
      if (existing === undefined) throw new Error("Proposed candidate is not yet visible");
    }
    let known = existing.candidate.evidence;
    if (existing.status === "accepted" && existing.decision?.kind === "accepted") {
      memory = await this.options.client.memoryById(existing.decision.memoryId);
      if (memory === undefined || memory.currentness?.status === "superseded") throw new JobDisposition("excluded", "accepted-memory-inactive");
      if (candidateKey({ ...candidate, ...memory, extractor: candidate.extractor }, memory.creatorId) !== identity) throw new Error("accepted-memory-claim-changed");
      known = memory.evidence ?? [];
    }
    const evidenceCoverage = await this.resolveEvidenceCoverage([...known, ...candidate.evidence]);
    const jobs = await this.jobs(); const currentJob = (await jobs.get(job.id))!;
    await jobs.put({ ...currentJob, payload: { ...currentJob.payload as ProposalPayload, evidenceCoverage }, updatedAt: this.now() });
    const keys = new Set(known.map(evidenceKey));
    const additions = candidate.evidence.filter((item) => !keys.has(evidenceKey(item)));
    for (let offset = 0; offset < additions.length; offset += 100) {
      const evidence = additions.slice(offset, offset + 100);
      const options: { stamp: EventStamp } = { stamp: await this.stamp(job, `support-${jobDigest(evidence.map(evidenceKey))}`, Math.max(minimumSourceTime, (memory?.updatedAt ?? existing.candidate.updatedAt ?? existing.candidate.proposedAt) + 1)) };
      if (memory === undefined) existing = { ...existing, candidate: (await this.options.client.contributeMemoryCandidateEvidence(existing.candidate.id, { evidence }, options)).candidate };
      else memory = (await this.options.client.contributeMemoryEvidence(memory.id, { evidence, expectedRevision: memory.revision }, options)).memory;
    }
    let promoted = 0;
    if (existing.status === "proposed" && witnessEvent !== undefined &&
      jobDigest(existing.candidate.content) === jobDigest(candidate.content) &&
      existing.candidate.id === candidate.id && (trajectoryEvent === undefined ? await this.eligibleHumanWitness(candidate, witnessEvent) : await this.eligibleCheckpointWitness(candidate, witnessEvent, trajectoryEvent))) {
      const minimum = (existing.candidate.updatedAt ?? existing.candidate.proposedAt) + 1;
      const decisionStamp = await this.stamp(job, "accept", minimum);
      await this.options.client.acceptMemoryCandidate(existing.candidate.id, {
        stamp: decisionStamp,
        memoryStamp: await this.stamp(job, "memory", decisionStamp.t + 1),
        memoryId: deterministicCandidateId(job.createdAt, `${job.id}:accepted-memory`),
      });
      promoted = 1;
    }
    return { proposed, promoted };
  }
  private async resolveEvidenceCoverage(input: readonly MemoryCandidateEvidence[]) {
    const evidence = uniqueEvidence(input);
    const pending = evidence.filter((ref) => ref.runId !== undefined && !this.sourceOrigins.has(evidenceKey(ref)));
    if (pending.length > 0 && typeof this.options.client.transcriptEvidenceOrigins === "function") {
      for (let offset = 0; offset < pending.length; offset += 100) {
        for (const origin of await this.options.client.transcriptEvidenceOrigins(pending.slice(offset, offset + 100))) {
          if (origin.verified) this.sourceOrigins.set(evidenceKey(origin.reference), origin.independenceKey);
        }
      }
    }
    const supports = new Set<string>(), opposes = new Set<string>(); let unresolvedOrigins = 0;
    for (const item of evidence) {
      const origin = item.runId === undefined ? `event:${item.eventId}` : this.sourceOrigins.get(evidenceKey(item));
      if (origin === undefined) { unresolvedOrigins++; continue; }
      (item.relation === "opposes" ? opposes : supports).add(origin);
    }
    return { citations: evidence.length, supportingSources: supports.size, opposingSources: opposes.size, unresolvedOrigins };
  }
  private async sourceTime(candidate: ExtractedCandidate): Promise<number> {
    let minimum = 0;
    for (const ref of candidate.sourceMemoryRefs ?? []) {
      const current = await this.options.client.memoryById(ref.memoryId);
      if (current === undefined || current.revision !== ref.revision || current.currentness?.status !== "current") throw new JobDisposition("excluded", "proposal-source-no-longer-current");
      minimum = Math.max(minimum, current.updatedAt + 1);
    }
    const missing: string[] = [];
    for (const id of new Set(candidate.evidence.map(({ eventId }) => eventId))) {
      const time = this.evidenceTimes.get(id);
      if (time === undefined) missing.push(id); else minimum = Math.max(minimum, time + 1);
    }
    for (let offset = 0; offset < missing.length; offset += 100) {
      const eventIds = missing.slice(offset, offset + 100);
      const times = new Map((await this.options.client.listEvents({ eventIds })).map(({ event }) => [event.id, event.at.t]));
      for (const eventId of eventIds) {
        const time = times.get(eventId);
        if (time === undefined) throw new JobDisposition("waiting", "canonical-evidence-unavailable");
        this.rememberEvidenceTime(eventId, time); minimum = Math.max(minimum, time + 1);
      }
    }
    return minimum;
  }
  private rememberEvidenceTime(id: string, time: number): void {
    this.evidenceTimes.set(id, time);
    if (this.evidenceTimes.size > 10_000) this.evidenceTimes.delete(this.evidenceTimes.keys().next().value!);
  }
  private async eligibleHumanWitness(candidate: ExtractedCandidate, event: FoldEvent): Promise<boolean> {
    if (!this.options.autoPromote || this.options.verifyCapturedEvent === undefined || candidate.source !== "live-human-decision" || applicability(candidate).kind !== "projects") return false;
    if (!candidate.evidence.some(({ eventId }) => eventId === event.id)) return false;
    for (const change of event.changes) {
      if (change.verb !== "create" || change.nodeKind !== "x.fold.activity-observation") continue;
      const data = change.after.data;
      if (data === null || typeof data !== "object" || Array.isArray(data)) continue;
      const acceptance = data.acceptance;
      if (acceptance === null || typeof acceptance !== "object" || Array.isArray(acceptance)) continue;
      const { taskId, attemptId, revisionId } = acceptance;
      if (typeof taskId !== "string" || typeof attemptId !== "string" || typeof revisionId !== "string") continue;
      // The exact event witness attests that capture matched these IDs against its current task and revision.
      return (await verifiedTaskAcceptance(event, { taskId, attemptId, revisionId }, this.options.verifyCapturedEvent))?.verdict === "success";
    }
    return false;
  }
  /** Unwitnessed candidates remain reviewable; a source label never conveys authority. */
  async promote(_candidates: readonly ExtractedCandidate[]): Promise<number> { return 0; }
  async processLiveEvent(event: FoldEvent): Promise<{ proposed: number; promoted: number }> {
    await this.enqueueCandidates(extractLiveMemoryCandidates(event), event); return this.drainJobs();
  }
  async promoteSuccessfulTrajectoryEvidence(event: FoldEvent): Promise<{ promoted: number; deferredReason?: string }> {
    const job = await (await this.jobs()).enqueue("verify-trajectory", [event.id, jobDigest(event), "attested-checkpoint-v1"], { event }, this.now());
    const result = await this.drainJobs();
    const current = await (await this.jobs()).get(job.id);
    return { promoted: result.promoted, ...(current?.reason === undefined ? {} : { deferredReason: current.reason }) };
  }
  private async attestedTrajectory(event: FoldEvent) {
    if (!this.options.autoPromote) throw new JobDisposition("excluded", "automatic-promotion-disabled");
    if (this.options.verifyCapturedTrajectory === undefined || this.options.verifyCapturedEvent === undefined) throw new JobDisposition("waiting", "trajectory-verifier-unavailable");
    if (!(await this.options.verifyCapturedTrajectory(event))) throw new JobDisposition("waiting", "trajectory-witness-unavailable");
    const records = trajectoryLogRecordsFromEvent(event).filter((record) => record.recordType === "trajectory");
    if (records.length !== 1) throw new JobDisposition("excluded", "trajectory-record-unavailable");
    const trajectory = records[0]!.trajectory;
    const manifest = trajectory.manifest;
    const final = manifest?.attempt.finalRevision;
    const acceptance = manifest?.attempt.acceptance;
    if (manifest === undefined || final?.fingerprintStatus !== "available" || final.revisionId === undefined || acceptance === undefined) throw new JobDisposition("excluded", "trajectory-revision-and-acceptance-required");
    if (trajectory.outcome !== "success" || acceptance.verdict !== "success" || acceptance.taskId !== trajectory.taskId || acceptance.attemptId !== trajectory.id || acceptance.revisionId !== final.revisionId ||
      manifest.attempt.attemptId !== trajectory.id || manifest.attempt.taskId !== trajectory.taskId) throw new JobDisposition("excluded", "trajectory-acceptance-join-mismatch");
    const acceptanceEvent = (await this.options.client.listEvents({ eventIds: [acceptance.eventId] }))[0]?.event;
    if (acceptanceEvent === undefined) throw new JobDisposition("waiting", "trajectory-acceptance-event-unavailable");
    const verified = await verifiedTaskAcceptance(acceptanceEvent, { taskId: trajectory.taskId, attemptId: trajectory.id, revisionId: final.revisionId }, this.options.verifyCapturedEvent);
    if (verified?.verdict !== "success" || verified.artifactId !== acceptance.artifactId || acceptanceEvent.at.t > event.at.t ||
      acceptanceEvent.capture.scope.workspace !== event.capture.scope.workspace || acceptanceEvent.capture.scope.space !== event.capture.scope.space ||
      !trajectory.steps.some((step) => step.role === "decision" && step.eventId === acceptance.eventId && step.artifactId === acceptance.artifactId)) throw new JobDisposition("waiting", "trajectory-acceptance-unverified");
    return { trajectory, acceptanceEvent };
  }
  private checkpointInTrajectory(candidate: ExtractedCandidate, event: FoldEvent, trajectoryEvent: FoldEvent,
    attested: Awaited<ReturnType<TranscriptMemoryWorker["attestedTrajectory"]>>): boolean {
    if (candidate.source !== "live-reasoning-checkpoint" || applicability(candidate).kind !== "projects" || event.at.t > attested.acceptanceEvent.at.t ||
      event.capture.scope.workspace !== trajectoryEvent.capture.scope.workspace || event.capture.scope.space !== trajectoryEvent.capture.scope.space ||
      event.capture.identity?.repo !== trajectoryEvent.capture.identity?.repo) return false;
    const observations = event.changes.filter((change) => change.verb === "create" && change.nodeKind === "x.fold.activity-observation" && change.after.observation === "reasoning_checkpoint");
    if (observations.length !== 1) return false;
    const observation = observations[0]!;
    if (observation.verb !== "create") return false;
    const data = observation.after.data;
    if (data === null || typeof data !== "object" || Array.isArray(data) || typeof data.summary !== "string" || typeof data.artifactId !== "string") return false;
    return attested.trajectory.steps.some((step) => step.role === "model_thought" && step.eventId === event.id && step.artifactId === data.artifactId &&
      step.content === data.summary && step.turnId === event.capture.identity?.turn) &&
      extractLiveMemoryCandidates(event).some((exact) => jobDigest(exact.content) === jobDigest(candidate.content) && exact.summary === candidate.summary);
  }
  private async eligibleCheckpointWitness(candidate: ExtractedCandidate, event: FoldEvent, trajectoryEvent: FoldEvent): Promise<boolean> {
    const attested = await this.attestedTrajectory(trajectoryEvent);
    return this.checkpointInTrajectory(candidate, event, trajectoryEvent, attested) && await this.options.verifyCapturedEvent!(event);
  }
  private async queueTrajectoryCheckpoints(event: FoldEvent): Promise<void> {
    const attested = await this.attestedTrajectory(event);
    const ids = [...new Set(attested.trajectory.steps.filter((step) => step.role === "model_thought" && step.eventId !== undefined).map((step) => step.eventId!))];
    for (let offset = 0; offset < ids.length; offset += 100) {
      const requested = ids.slice(offset, offset + 100);
      const events = new Map((await this.options.client.listEvents({ eventIds: requested })).map(({ event }) => [event.id, event]));
      for (const id of requested) {
        const checkpoint = events.get(id);
        if (checkpoint === undefined) throw new JobDisposition("waiting", "trajectory-checkpoint-event-unavailable");
        if (!(await this.options.verifyCapturedEvent!(checkpoint))) throw new JobDisposition("waiting", "trajectory-checkpoint-witness-unavailable");
        const candidates = extractLiveMemoryCandidates(checkpoint).filter((candidate) => this.checkpointInTrajectory(candidate, checkpoint, event, attested)).map((candidate) => ({
          ...candidate, evidence: uniqueEvidence([...candidate.evidence,
            { eventId: event.id, ...(checkpoint.capture.identity?.repo === undefined ? {} : { projectId: checkpoint.capture.identity.repo }) },
            { eventId: attested.acceptanceEvent.id, ...(checkpoint.capture.identity?.repo === undefined ? {} : { projectId: checkpoint.capture.identity.repo }) },
          ]),
        }));
        if (candidates.length > 0) await this.enqueueCandidates(candidates, checkpoint, event);
      }
    }
  }
  private async activeMemories(): Promise<PersonalMemory[]> {
    const memories: PersonalMemory[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.options.client.memoryPage({ limit: 100, ...(cursor === undefined ? {} : { cursor }) });
      memories.push(...page.memories.filter((memory) => memory.currentness?.status === "current" && applicability(memory).kind !== "unresolved"));
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return memories;
  }
  private async planSynthesis(event: Pick<FoldEvent, "id" | "kind" | "at">): Promise<WorkerJob | undefined> {
    if (!this.options.continuousCognition) return undefined;
    const every = this.options.cognitionEveryEvents ?? 25;
    if (!Number.isInteger(every) || every < 1 || every > 100_000) throw new TypeError("cognitionEveryEvents must be within [1,100000]");
    const seed = parseInt(jobDigest(event.id).slice(0, 8), 16);
    if (seed % every !== 0) return undefined;
    const jobs = await this.jobs();
    const provider = (await this.options.client.reasoningProviders()).providers.find((item) => this.options.cognitionProviderId === undefined ? item.isDefault : item.id === this.options.cognitionProviderId);
    if (provider?.kind !== "model" || !provider.configured || !provider.configRevision) throw new JobDisposition("waiting", "configured-model-provider-unavailable");
    const memories = (await this.activeMemories()).filter((memory) => memory.audience === (this.options.audience ?? "workspace") && memory.spaceId === this.options.spaceId)
      .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)).slice(0, 10);
    if (new Set(memories.flatMap(applicableProjects)).size < 2) return undefined;
    const prompt = PROMPTS[seed % PROMPTS.length]!;
    const refs = memories.map(({ id, revision }) => ({ memoryId: id, revision })).sort((a, b) => a.memoryId.localeCompare(b.memoryId));
    return jobs.enqueue("synthesis", ["cognition-v2", prompt, provider.id, provider.configRevision, refs],
      { prompt, memories, providerId: provider.id, providerRevision: provider.configRevision } satisfies SynthesisPayload, this.now());
  }
  private async applySynthesis(job: WorkerJob): Promise<void> {
    const jobs = await this.jobs();
    let payload = job.payload as SynthesisPayload;
    const provider = (await this.options.client.reasoningProviders()).providers.find(({ id }) => id === payload.providerId);
    if (provider === undefined || !provider.configured) throw new JobDisposition("waiting", "configured-model-provider-unavailable");
    if (provider.configRevision !== payload.providerRevision) throw new JobDisposition("excluded", "model-provider-configuration-changed");
    const refs = payload.memories.map(({ id, revision }) => ({ memoryId: id, revision }));
    for (const ref of refs) {
      const current = await this.options.client.memoryById(ref.memoryId);
      if (current === undefined || current.revision !== ref.revision || current.currentness?.status !== "current") throw new JobDisposition("excluded", "synthesis-source-no-longer-current");
    }
    if (payload.result === undefined) {
      if (this.closing) throw new JobDisposition("waiting", "worker-shutdown");
      const controller = new AbortController();
      this.modelRequests.add(controller);
      const timer = setTimeout(() => controller.abort(new Error("reasoning-timeout")), this.options.modelTimeoutMs ?? 30_000);
      const result = await this.options.client.askReasoning({ question: payload.prompt.question, memoryRefs: refs,
        providerId: payload.providerId, providerConfigRevision: payload.providerRevision }, { signal: controller.signal, timeoutMs: this.options.modelTimeoutMs ?? 30_000 })
        .finally(() => { clearTimeout(timer); this.modelRequests.delete(controller); });
      if (result.provider.kind !== "model") throw new JobDisposition("waiting", "model-reasoning-provider-unavailable");
      payload = { ...payload, result };
      await jobs.put({ ...job, payload, updatedAt: this.now() });
    }
    const result = payload.result!;
    for (const ref of refs) {
      const current = await this.options.client.memoryById(ref.memoryId);
      if (current === undefined || current.revision !== ref.revision || current.currentness?.status !== "current") throw new JobDisposition("excluded", "synthesis-source-no-longer-current");
    }
    if (!result.citationRefs?.length || result.citationRefs.some((ref) => !refs.some((expected) => expected.memoryId === ref.memoryId && expected.revision === ref.revision))) throw new JobDisposition("excluded", "invalid-synthesis-citation-revision");
    const cited = payload.memories.filter((memory) => result.citationRefs.some((ref) => ref.memoryId === memory.id));
    const projectIds = [...new Set(cited.flatMap(applicableProjects))].sort();
    if (projectIds.length < 2) throw new JobDisposition("excluded", "cross-project-citation-coverage-insufficient");
    const evidence = uniqueEvidence(cited.flatMap((memory) => memory.evidence ?? []));
    if (evidence.length === 0 || !result.answer.trim()) throw new JobDisposition("excluded", "synthesis-evidence-or-answer-empty");
    await this.enqueueCandidates([{
      id: deterministicCandidateId(job.createdAt, job.id), source: "continuous-cognition", projectIds,
      applicability: { kind: "projects", projectIds }, sourceMemoryRefs: result.citationRefs,
      summary: result.answer.replace(/\s+/g, " ").trim().slice(0, 500),
      content: { kind: payload.prompt.kind, synthesis: result.answer, provider: result.provider.id, jobId: job.id },
      evidence, tags: ["continuous-cognition", payload.prompt.kind], confidence: 0.65, salience: 0.75,
      extractor: { kind: "model", id: result.provider.id, version: "2" },
    }]);
  }
  async synthesizeAcrossProjects(event: Pick<FoldEvent, "id" | "kind" | "at">): Promise<{ proposed: number; skippedReason?: string }> {
    if (!this.options.continuousCognition) return { proposed: 0, skippedReason: "continuous cognition disabled" };
    const job = await (await this.jobs()).enqueue("cognition-plan", [event.id], { event }, this.now());
    await this.drainModelJobs();
    const result = await this.drainJobs();
    const current = await (await this.jobs()).get(job.id);
    return { proposed: result.proposed, ...(current?.reason === undefined ? {} : { skippedReason: current.reason }) };
  }
  private rememberEpisodeRun(run: TranscriptRun): void {
    this.episodeRuns.set(run.id, run);
    if (run.projectId !== undefined) this.episodeProjects.add(run.projectId);
    for (const segment of run.segments) if (segment.projectId !== undefined) this.episodeProjects.add(segment.projectId);
  }
  private episodePolicy(): string {
    return processingDigest({ scheduler: "episode-window-v1", audience: this.options.audience ?? "workspace", every: this.options.episodeEveryEvents ?? 25,
      elapsedMs: this.options.episodeElapsedMs ?? 300_000, capacity: EPISODE_CAPACITY, enabled: this.options.episodeFormation === true,
      sourceKinds: MEMORY_WORKER_EVENT_KINDS, publication: "content-limited-v1" });
  }
  /** Episode output is project-scoped workspace content; restricted sources never feed it. */
  private publishableSource(event: FoldEvent): boolean {
    const scope = event.capture?.scope;
    return (scope?.space === undefined || scope.space === this.options.spaceId) && scope?.creator === undefined;
  }
  private canPublishMemory(memory: PersonalMemory): boolean {
    return memory.audience === (this.options.audience ?? "workspace") && memory.spaceId === this.options.spaceId;
  }
  private async authorizedSource(eventId: string, expected?: FoldEvent): Promise<FoldEvent> {
    const authorized = await this.options.client.eventById(eventId);
    if (authorized === undefined) throw new JobDisposition("waiting", "source-event-unavailable");
    if (expected !== undefined && processingDigest(authorized) !== processingDigest(expected)) throw new JobDisposition("waiting", "source-event-changed");
    if (!this.publishableSource(authorized)) throw new JobDisposition("excluded", "source-publication-scope-incompatible");
    return authorized;
  }
  private async episodeProject(event: FoldEvent): Promise<string | undefined> {
    if ((this.options.audience ?? "workspace") !== "workspace") return undefined;
    const projects = new Set<string>();
    const repo = event.capture.identity?.repo;
    if (repo !== undefined && this.episodeProjects.has(repo)) projects.add(repo);
    const addRun = (run: TranscriptRun | undefined) => {
      if (run?.projectId !== undefined) projects.add(run.projectId);
      for (const segment of run?.segments ?? []) if (segment.projectId !== undefined) projects.add(segment.projectId);
    };
    for (const record of transcriptRecordsFromEvent(event)) {
      if (record.recordType === "run") { this.rememberEpisodeRun(record.run); addRun(record.run); }
      if (record.recordType === "chunk") addRun(this.episodeRuns.get(record.chunk.runId));
    }
    if (event.kind === "transcript.derivation-chunk-recorded") for (const change of event.changes) if (change.verb === "create") {
      const parsed = transcriptDerivationChunkSchema.safeParse(change.after.chunk);
      if (parsed.success) addRun(this.episodeRuns.get(parsed.data.runId));
    }
    for (const record of memoryLogRecordsFromEvent(event)) {
      const memoryId = record.recordType === "recorded" ? record.memory.id : record.memoryId;
      const memory = await this.options.client.memoryById(memoryId);
      if (memory === undefined || !this.canPublishMemory(memory)) return undefined;
      for (const projectId of applicableProjects(memory)) projects.add(projectId);
    }
    return projects.size === 1 ? [...projects][0] : undefined;
  }
  /** Opens the exact episode window scheduler inside the leased ledger; later opens reuse its checkpoint. */
  async openEpisodeScheduler(initialSequence = "0"): Promise<DurableWindowScheduler> {
    if (this.episodeScheduler !== undefined) return this.episodeScheduler;
    const jobs = await this.jobs();
    const policy = this.episodePolicy();
    const scheduler = new DurableWindowScheduler(jobs, policy, {
      every: this.options.episodeEveryEvents ?? 25, elapsedMs: this.options.episodeElapsedMs ?? 300_000, capacity: EPISODE_CAPACITY,
      deliver: (window, anchor) => jobs.enqueue("episode", [window.id, policy], { window, anchor } satisfies EpisodePayload, this.now()),
    });
    await scheduler.open(initialSequence);
    this.episodeScheduler = scheduler;
    return scheduler;
  }
  /**
   * Durably schedules all work derived from one delivered event before its transport acknowledgement.
   * Returns the number of newly admitted jobs; replays are idempotent.
   */
  async scheduleEvent(event: FoldEvent, ingestionSequence?: string): Promise<number> {
    const jobs = await this.jobs();
    let queued = 0;
    const admit = async (kind: WorkerJob["kind"], identity: unknown, payload: unknown) => {
      if (await jobs.get(jobs.identify(kind, identity)) !== undefined) return;
      await jobs.enqueue(kind, identity, payload, this.now()); queued++;
    };
    // Unscoped worker output must never carry evidence from a restricted transcript import.
    if (event.kind === "transcript.run-imported" && this.publishableSource(event)) {
      for (const record of transcriptRecordsFromEvent(event)) if (record.recordType === "run") {
        this.rememberEpisodeRun(record.run);
        await admit("extract-run", [record.run.id, record.run.artifactId, RULE_EXTRACTOR], { run: record.run, eventId: event.id } satisfies RunPayload);
      }
    } else if (event.kind === "terminal.observation") queued += await this.enqueueCandidates(extractLiveMemoryCandidates(event), event); else if (event.kind === "trajectory.recorded") await admit("verify-trajectory", [event.id, jobDigest(event), "attested-checkpoint-v1"], { event });
    if (COGNITION_TRIGGER_KINDS.includes(event.kind) && this.options.continuousCognition) await admit("cognition-plan", [event.id], { event });
    if (this.options.episodeFormation === true && ingestionSequence !== undefined) {
      const scheduler = await this.openEpisodeScheduler("0");
      const restricted = !this.publishableSource(event);
      const projectId = restricted ? undefined : await this.episodeProject(event);
      await scheduler.observe(ingestionSequence, projectId === undefined ? undefined : {
        event, projectId, partition: processingDigest({ projectId, workspace: event.capture.scope?.workspace, audience: this.options.audience ?? "workspace" }),
        completion: completionSignal(event),
      }, this.now(), restricted || projectId === undefined);
    }
    return queued;
  }
  /** Chosen-source episode formation: preview is read-only; queueing is idempotent per exact source set. */
  async queueEpisodeSources(eventIds: readonly string[], projectId: string, queue = false) {
    if (eventIds.length < 1 || eventIds.length > EPISODE_CAPACITY || new Set(eventIds).size !== eventIds.length || eventIds.some((id) => id.trim().length === 0) || projectId.trim().length === 0) throw new TypeError("Choose 1 to 200 distinct event IDs and one exact project ID");
    if (this.options.episodeFormation !== true || (this.options.audience ?? "workspace") !== "workspace") throw new TypeError("Episode queueing requires the enabled workspace publication policy");
    this.configureProjectRoots(await this.options.client.transcriptRuns());
    const events: FoldEvent[] = [];
    let sourceBytes = 0;
    const problems: { eventId: string; reason: string }[] = [];
    for (const id of [...eventIds].sort()) {
      try {
        const event = await this.authorizedSource(id);
        if (await this.episodeProject(event) !== projectId) { problems.push({ eventId: id, reason: "project is unresolved, ambiguous, or different" }); continue; }
        if (!(MEMORY_WORKER_EVENT_KINDS as readonly string[]).includes(event.kind)) { problems.push({ eventId: id, reason: "event kind is outside the episode source policy" }); continue; }
        sourceBytes += Buffer.byteLength(JSON.stringify(event));
        if (sourceBytes > 8_000_000) throw new TypeError("Chosen episode sources exceed the 8000000-byte queue admission budget; choose smaller explicit sets without omitting any sources");
        events.push(event);
      } catch (error) {
        if (error instanceof JobDisposition) problems.push({ eventId: id, reason: error.reason });
        else throw error;
      }
    }
    if (problems.length > 0) {
      if (queue) throw new TypeError("Episode queue refused: one or more chosen sources are unavailable or outside the requested publication scope; run preview");
      return { mode: "dry-run", eligible: false, projectId, selected: eventIds.length, problems };
    }
    const policy = this.episodePolicy();
    // Manual chosen sets have no transport cursor or elapsed-time deadline; zero times are explicit sentinels.
    const identity = { version: 1 as const, policy, partition: processingDigest({ projectId, workspace: events[0]!.capture.scope.workspace, audience: "workspace" }), projectId,
      trigger: "manual" as const, openedAt: 0, sealedAt: 0, sources: events.map((event) => ({ eventId: event.id, digest: processingDigest(event), sourceTime: event.at.t })) };
    const window: SchedulingWindow = { ...identity, id: processingDigest(identity) };
    let queued: boolean | undefined;
    if (queue) {
      const jobs = await this.jobs();
      queued = await jobs.get(jobs.identify("episode", [window.id, policy])) === undefined;
      if (queued) await jobs.enqueue("episode", [window.id, policy], { window, anchor: events.at(-1)! } satisfies EpisodePayload, this.now());
    }
    return { mode: queue ? "queue" : "dry-run", eligible: true, projectId, selected: events.length, windowId: window.id,
      ...(queued === undefined ? {} : { queued }), sourceEventIds: events.map((event) => event.id), coverage: "chosen authorized source events only; no consumer cursor change or model call" };
  }
  private async applyEpisode(job: WorkerJob): Promise<void> {
    const jobs = await this.jobs();
    let payload = job.payload as EpisodePayload;
    const save = async (next: EpisodePayload) => { payload = next; await jobs.put({ ...(await jobs.get(job.id) ?? job), payload: next, updatedAt: this.now() }); };
    try { validateSchedulingWindow(payload.window); } catch { throw new JobDisposition("blocked", "invalid-episode-window-checkpoint"); }
    const window = payload.window;
    if (window.policy !== this.episodePolicy()) throw new JobDisposition("blocked", "episode-policy-changed");
    if (window.projectId === undefined || window.sources.length > EPISODE_CAPACITY || window.sources.at(-1)?.eventId !== payload.anchor.id) throw new JobDisposition("blocked", "invalid-episode-job-scope");
    for (const source of window.sources) {
      const current = await this.authorizedSource(source.eventId);
      if (processingDigest(current) !== source.digest) throw new JobDisposition("waiting", "episode-source-changed-or-unavailable");
    }
    if (payload.episode === undefined) {
      if (payload.episodeContext === undefined) {
        const page = await this.options.client.episodePage({ projectId: window.projectId, limit: 20 });
        const context = page.items.filter((item) => item.projectId === window.projectId && item.audience === (this.options.audience ?? "workspace") && item.spaceId === undefined).slice(0, 5);
        await save({ ...payload, episodeContext: { ids: context.map((item) => item.episodeId), omitted: page.total > context.length } });
      }
      try {
        const episode = await this.options.client.synthesizeEpisodeWindow({ windowId: window.id, sourceEventIds: window.sources.map((source) => source.eventId),
          projectId: window.projectId, audience: this.options.audience ?? "workspace", trigger: window.trigger,
          contextEpisodeIds: payload.episodeContext!.ids,
          ...(window.parentWindowId === undefined ? {} : { parentWindowId: window.parentWindowId }) });
        episodeWindowInputSchema.parse(episode);
        // Persist the prepared model output before publication; a lost response republishes without a second model call.
        await save({ ...payload, episode });
      } catch (error) {
        if (!(error instanceof SuperBrainApiError) || error.status !== 413 || error.code !== "episode_input_too_large") throw error;
        if (payload.episodeContext!.ids.length > 0) {
          await save({ ...payload, episodeContext: { ids: [], omitted: true } });
          throw new JobDisposition("waiting", "episode input budget exceeded; retrying same sources without optional prior context");
        }
        if (window.sources.length === 1) throw new JobDisposition("blocked", "single episode source exceeds model input budget; preserve source and increase supported budget or add record-level splitting");
        const middle = Math.ceil(window.sources.length / 2);
        for (const sources of [window.sources.slice(0, middle), window.sources.slice(middle)]) {
          const { id: _id, ...previous } = window;
          const identity = { ...previous, parentWindowId: window.id, trigger: "capacity" as const, sources };
          const child: SchedulingWindow = { ...identity, id: processingDigest(identity) };
          const anchor = await this.authorizedSource(sources.at(-1)!.eventId);
          await jobs.enqueue("episode", [child.id, window.policy], { window: child, anchor } satisfies EpisodePayload, this.now());
        }
        return; // Split into two durable child windows after the model input budget refusal.
      }
    }
    const prepared = payload.episode!;
    if (prepared.sources.length !== window.sources.length || prepared.sources.some((source) => !window.sources.some((expected) => expected.eventId === source.eventId && expected.digest === source.sha256)) ||
      prepared.projectId !== window.projectId || prepared.windowId !== window.id || prepared.parentWindowId !== window.parentWindowId ||
      prepared.audience !== (this.options.audience ?? "workspace") || prepared.spaceId !== undefined) throw new JobDisposition("blocked", "episode-preparation-scope-changed");
    try { await this.options.client.publishEpisodeWindow(prepared); }
    catch (error) {
      // A concurrent revision invalidates the prepared output; the next attempt re-prepares from current context.
      if (error instanceof SuperBrainApiError && error.status === 409) { const { episode: _episode, episodeContext: _context, ...rest } = payload; await save(rest); }
      throw error;
    }
  }
  /** Historical transcript inventory: dry-run reads nothing locally; queueing is idempotent with watch/reconcile. */
  async queueTranscriptBackfill(queue = false, limit?: number) {
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) throw new TypeError("Backfill limit must be a positive integer");
    const archive = await this.archiveRuns();
    const results: { runId: string; status: "eligible" | "queued" | "existing" | "unavailable" }[] = [];
    for (const run of limit === undefined ? archive.runs : archive.runs.slice(0, limit)) {
      const eventId = archive.eventIds.get(run.id);
      if (eventId === undefined) { results.push({ runId: run.id, status: "unavailable" }); continue; }
      if (!queue) { results.push({ runId: run.id, status: "eligible" }); continue; }
      const jobs = await this.jobs();
      const identity = [run.id, run.artifactId, RULE_EXTRACTOR];
      const existing = await jobs.get(jobs.identify("extract-run", identity));
      if (existing === undefined) await this.enqueueRun(run, eventId);
      results.push({ runId: run.id, status: existing === undefined ? "queued" : "existing" });
    }
    return { mode: queue ? "queue" : "dry-run", runs: results.length,
      counts: Object.fromEntries((["eligible", "queued", "existing", "unavailable"] as const).map((status) => [status, results.filter((item) => item.status === status).length])),
      coverage: "authorized run inventory; artifact availability is checked during processing", results };
  }
  /** Restores candidate evidence missing from accepted memories through attributed, idempotent contributions. */
  async repairAcceptedEvidence(apply = false): Promise<{ readonly inspected: number; readonly missingMemories: number; readonly repairable: number; readonly repaired: number }> {
    const accepted = (await repairRequest(() => this.candidateViews())).filter((view) => view.status === "accepted");
    let missingMemories = 0, repairable = 0, repaired = 0;
    for (const view of accepted) {
      if (view.decision?.kind !== "accepted") continue;
      const memoryId = view.decision.memoryId;
      const memory = await repairRequest(() => this.options.client.memoryById(memoryId));
      if (memory === undefined) { missingMemories += 1; continue; }
      const known = new Set((memory.evidence ?? []).map(evidenceKey));
      const missing = uniqueEvidence(view.candidate.evidence).filter((item) => !known.has(evidenceKey(item)));
      if (missing.length === 0) continue;
      repairable += 1;
      if (!apply) continue;
      let current = memory;
      for (let offset = 0; offset < missing.length; offset += 100) {
        const evidence = missing.slice(offset, offset + 100);
        const t = Math.max(this.now(), current.updatedAt + 1);
        // Deterministic per exact repair so a replayed command is idempotent server-side.
        const stamp = { id: `memory-worker-repair-${jobDigest([current.id, current.revision, evidence.map(evidenceKey)])}`, t, worldDate: new Date(t).toISOString().slice(0, 10) };
        const base = current;
        current = (await repairRequest(() => this.options.client.contributeMemoryEvidence(base.id, { evidence, expectedRevision: base.revision }, { stamp }))).memory;
      }
      repaired += 1;
    }
    return { inspected: accepted.length, missingMemories, repairable, repaired };
  }
  async archiveRuns(): Promise<{ runs: readonly TranscriptRun[]; eventIds: ReadonlyMap<string, string> }> {
    const [runs, entries] = await Promise.all([this.options.client.transcriptRuns(), this.options.client.listEvents({ kinds: ["transcript.run-imported"] })]);
    this.configureProjectRoots(runs);
    const eventIds = new Map<string, string>();
    for (const { event } of entries) {
      if (!this.publishableSource(event)) continue; // Restricted imports are reported as unavailable, never extracted.
      for (const record of transcriptRecordsFromEvent(event)) if (record.recordType === "run") eventIds.set(record.run.id, event.id);
    }
    for (const { event } of entries) this.rememberEvidenceTime(event.id, event.at.t);
    return { runs, eventIds };
  }
  async enqueueRun(run: TranscriptRun, eventId: string): Promise<void> {
    await (await this.jobs()).enqueue("extract-run", [run.id, run.artifactId, RULE_EXTRACTOR], { run, eventId } satisfies RunPayload, this.now());
  }
  async processRun(run: TranscriptRun, runEventId: string, write: boolean): Promise<RunExtraction & { proposed: number }> {
    if (!write) return { ...await this.extractRun(run, runEventId), proposed: 0 };
    await this.enqueueRun(run, runEventId);
    return { run, source: run.source, candidates: [], proposed: (await this.drainJobs()).proposed };
  }
  async reconcile(): Promise<void> {
    const archive = await this.archiveRuns();
    for (const run of archive.runs) { const eventId = archive.eventIds.get(run.id); if (eventId !== undefined) await this.enqueueRun(run, eventId); }
  }
  drainJobs(): Promise<{ proposed: number; promoted: number }> {
    if (this.draining === undefined) this.draining = this.drain().finally(() => { this.draining = undefined; });
    return this.draining;
  }
  private async drain(): Promise<{ proposed: number; promoted: number }> {
    const jobs = await this.jobs();
    let proposed = 0, promoted = 0;
    for (const kind of ["extract-run", "extract-turn", "verify-trajectory", "propose"] as const) {
      const pending = (await jobs.active()).filter((job) => job.kind === kind && job.state !== "blocked" && job.nextAttemptAt <= this.now()).slice(0, this.options.maxCandidatesPerRun ?? 25);
      for (const job of pending) {
        if (this.closing) break;
        try {
          if (kind === "extract-run") {
            const { run, eventId } = job.payload as RunPayload;
            const detail = await this.options.client.transcriptRun(run.id);
            if (detail === undefined) throw new JobDisposition("waiting", "canonical-artifact-metadata-unavailable");
            const result = await readVaultEvidence(this.options.vaultRoot, run, { artifact: detail.artifact,
              canonicalTurns: detail.chunks.flatMap(({ turns }) => turns),
              ...(this.options.vaultEncryptionKey === undefined ? {} : { encryptionKey: this.options.vaultEncryptionKey }) });
            if (result.status !== "ready") {
              if (result.status === "retry") throw new Error(result.reason);
              throw new JobDisposition(result.status, result.reason);
            }
            const turns = new Map<string, VaultMessage[]>();
            for (const message of result.messages) { const messages = turns.get(message.turnId) ?? []; messages.push(message); turns.set(message.turnId, messages); }
            for (const turn of detail.chunks.flatMap(({ turns }) => turns)) if (!turns.has(turn.id)) turns.set(turn.id, []);
            for (const [turnId, messages] of turns) await jobs.enqueue("extract-turn", [run.artifactId, run.id, turnId, detail.artifact.parser, RULE_EXTRACTOR], { run, eventId, messages } satisfies TurnPayload, this.now());
            await jobs.put({ ...job, payload: { ...job.payload as RunPayload, coverage: result.coverage }, updatedAt: this.now() });
          } else if (kind === "extract-turn") {
            const { run, eventId, messages } = job.payload as TurnPayload; await this.enqueueCandidates(extractMemoryCandidates(run, eventId, messages));
          } else if (kind === "verify-trajectory") await this.queueTrajectoryCheckpoints((job.payload as { event: FoldEvent }).event);
          else { const result = await this.applyProposal(job); proposed += result.proposed; promoted += result.promoted; }
          await jobs.put({ ...(await jobs.get(job.id))!, state: "completed", updatedAt: this.now() });
        } catch (error) {
          await this.failJob(job, error);
        } finally { this.sourceOrigins.clear(); }
      }
    }
    if (this.options.reportCoverage !== undefined) {
      try { await this.options.reportCoverage(await jobs.coverage()); }
      catch { this.options.reportWarning?.("Coverage reporting failed; local durable state is retained"); }
    }
    await this.publishStatus(this.closing ? "stopped" : "running");
    return { proposed, promoted };
  }
  /** A separately scheduled, single-owner lane keeps slow providers away from extraction. */
  drainModelJobs(): Promise<void> {
    if (this.modelDraining === undefined) this.modelDraining = this.drainModels().finally(async () => { await this.publishStatus(this.closing ? "stopped" : "running"); this.modelDraining = undefined; });
    return this.modelDraining;
  }
  private async drainModels(): Promise<void> {
    const jobs = await this.jobs();
    for (const kind of ["cognition-plan", "synthesis", "episode"] as const) {
      const pending = (await jobs.active()).filter((job) => job.kind === kind && job.state !== "blocked" && job.nextAttemptAt <= this.now()).slice(0, kind === "synthesis" ? 1 : kind === "episode" ? 5 : 25);
      for (const job of pending) {
        if (this.closing) return;
        try {
          if (kind === "cognition-plan") await this.planSynthesis((job.payload as { event: FoldEvent }).event);
          else if (kind === "episode") await this.applyEpisode(job);
          else await this.applySynthesis(job);
          await jobs.put({ ...(await jobs.get(job.id))!, state: "completed", updatedAt: this.now() });
        } catch (error) { await this.failJob(job, error); }
      }
    }
  }
  private async failJob(job: WorkerJob, error: unknown): Promise<void> {
    const jobs = await this.jobs();
    const latest = await jobs.get(job.id) ?? job;
    const disposition = error instanceof JobDisposition ? error : undefined;
    const forbidden = error instanceof SuperBrainApiError && [401, 403].includes(error.status);
    const unavailableProvider = error instanceof SuperBrainApiError && ["reasoning_provider_unavailable", "reasoning_provider_not_found"].includes(error.code);
    const invalid = error instanceof SuperBrainApiError && [400, 422].includes(error.status);
    let state: WorkerJobState = disposition?.state ?? (forbidden || unavailableProvider || this.closing ? "waiting" : invalid ? "excluded" : "retry");
    const attempts = latest.attempts + (state === "retry" ? 1 : 0);
    let reason = disposition?.reason ?? (this.closing ? "worker-shutdown" : error instanceof SuperBrainApiError ? error.code : "processing-error");
    if (state === "retry" && job.kind === "synthesis" && attempts >= (this.options.maxModelAttempts ?? 3)) { state = "exhausted"; reason = "model-attempts-exhausted"; }
    // Episode windows own their exact sources; exhausted model attempts stay preserved for explicit operator retry.
    if (state === "retry" && job.kind === "episode" && attempts >= (this.options.maxModelAttempts ?? 3)) { state = "blocked"; reason = "model-attempts-exhausted"; }
    const delay = Math.min(60 * 60_000, (this.options.retryBaseMs ?? 1_000) * 2 ** Math.min(Math.max(attempts - 1, 0), 12));
    await jobs.put({ ...latest, state, attempts, updatedAt: this.now(), nextAttemptAt: this.now() + delay, reason });
    this.options.reportWarning?.(`Processing job ${job.id} is ${state}: ${reason}`);
  }
  async coverage(): Promise<ProcessingCoverage> { return (await this.jobs()).coverage(); }
  /** Sanitized window-scheduler aggregates (no source identifiers). */
  async schedulingCoverage() { return readSchedulingCoverage(await this.jobs()); }
  /** Explicit operator recovery for blocked, waiting and retrying work. */
  async retryBlocked(): Promise<number> { return (await this.jobs()).retryBlocked(this.now()); }
  async retryJob(id: string): Promise<void> {
    const jobs = await this.jobs();
    const original = await jobs.get(id);
    if (original === undefined) throw new TypeError("Unknown processing job");
    await jobs.enqueue(original.kind, ["explicit-reprocess", original.id, this.now()], original.payload, this.now());
  }
  async watch(options: { consumerId: string; replay?: "tail" | "all"; signal?: AbortSignal }): Promise<void> {
    await this.jobs();
    if (this.options.episodeFormation === true) {
      this.configureProjectRoots(await this.options.client.transcriptRuns());
      // A new scheduler policy starts at the subscriber's current ingestion position, never reinterpreting history.
      const initial = (await this.options.client.ingestionConsumerStatus(options.consumerId, { kinds: MEMORY_WORKER_EVENT_KINDS })).cursor?.sequence ?? "0";
      await this.openEpisodeScheduler(initial);
    }
    const controller = new AbortController();
    this.watchController = controller;
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    let lastReconciliation = -Infinity;
    const pause = () => new Promise<void>((resolve) => {
      const finish = () => { clearTimeout(timer); controller.signal.removeEventListener("abort", finish); resolve(); };
      const timer = setTimeout(finish, this.options.pollIntervalMs ?? 1_000);
      controller.signal.addEventListener("abort", finish, { once: true });
      if (controller.signal.aborted) finish();
    });
    const modelRunner = (async () => {
      while (!controller.signal.aborted && !this.closing) { await this.drainModelJobs(); await pause(); }
    })();
    const runner = (async () => {
      while (!controller.signal.aborted && !this.closing) {
        if (this.now() - lastReconciliation >= (this.options.reconciliationIntervalMs ?? 60_000)) {
          try { await this.reconcile(); lastReconciliation = this.now(); }
          catch { this.options.reportWarning?.("Artifact reconciliation will retry independently"); }
        }
        if (controller.signal.aborted || this.closing) break;
        try { await this.episodeScheduler?.tick(this.now()); }
        catch { this.options.reportWarning?.("Episode window sealing will retry independently"); }
        await this.drainJobs();
        await pause();
      }
    })();
    const consumer = this.options.client.consumeEvents({ consumerId: options.consumerId, replay: options.replay ?? "tail", signal: controller.signal,
        kinds: MEMORY_WORKER_EVENT_KINDS,
        // Every delivered event is durably scheduled before onEvent returns, so acknowledgements may be batched.
        checkpointEvery: 100,
        onEvent: async ({ entry, cursor }) => {
          let paused = false;
          for (;;) {
            if (this.closing) throw new Error("Worker is closing");
            try { await this.scheduleEvent(entry.event, cursor?.sequence); return; }
            catch (error) {
              if (!(error instanceof ProcessingBackpressureError)) throw error;
              if (!paused) this.options.reportWarning?.("Processing capacity reached; intake is paused while durable jobs drain");
              paused = true;
              await delay(this.options.pollIntervalMs ?? 1_000, undefined, { signal: controller.signal });
            }
          }
        },
      });
    this.background = [runner, modelRunner, consumer];
    try {
      await Promise.race(this.background);
    } finally {
      controller.abort(); options.signal?.removeEventListener("abort", abort);
      await this.close(); await Promise.allSettled([runner, modelRunner]);
    }
  }
}
