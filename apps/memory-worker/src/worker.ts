import { homedir } from "node:os";
import { join } from "node:path";
import type { FoldEvent } from "@_89/fold";
import type { MemoryCandidateEvidence, MemoryCandidateView, PersonalMemory } from "@_89/fold-epistemic";
import { transcriptRecordsFromEvent, type TranscriptRun } from "@_89/fold-transcript";
import { trajectoryLogRecordsFromEvent } from "@_89/fold-trajectory";
import { SuperBrainApiError, SuperBrainClient, type EventStamp } from "@_89/super-brain-client";
import { deterministicCandidateId, extractedClaimContent, extractLiveMemoryCandidates, extractMemoryCandidates, RULE_EXTRACTOR } from "./extractor.js";
import { DurableWorkerJobs, jobDigest, type ProcessingCoverage, type WorkerJob, type WorkerJobState } from "./jobs.js";
import type { ExtractedCandidate, RunExtraction, VaultMessage } from "./types.js";
import { readVaultEvidence } from "./vault.js";
import { verifiedTaskAcceptance } from "./authority.js";

export interface WorkerOptions {
  readonly client: SuperBrainClient;
  readonly vaultRoot: string;
  readonly vaultEncryptionKey?: Uint8Array;
  readonly stateRoot?: string;
  /** Per-kind dispatch budget, never a source extraction limit. */
  readonly maxCandidatesPerRun?: number;
  readonly audience?: "personal" | "workspace";
  readonly spaceId?: string;
  readonly autoPromote?: boolean;
  readonly continuousCognition?: boolean;
  readonly cognitionEveryEvents?: number;
  readonly cognitionProviderId?: string;
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
class JobDisposition extends Error {
  constructor(readonly state: "waiting" | "excluded", readonly reason: string) { super(reason); }
}

export class TranscriptMemoryWorker {
  private store: DurableWorkerJobs | undefined;
  private opening: Promise<DurableWorkerJobs> | undefined;
  private principalId: string | undefined;
  private draining: Promise<{ proposed: number; promoted: number }> | undefined;
  private modelDraining: Promise<void> | undefined;
  private readonly modelRequests = new Set<AbortController>();
  private closing = false;
  private watchController: AbortController | undefined;
  private background: Promise<unknown>[] = [];
  private projectRoots: Array<{ root: string; projectId: string }> = [];
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
      const namespace = JSON.stringify([identity.organizationId ?? "local", identity.workspaceId, identity.principalId,
        RULE_EXTRACTOR, this.options.audience ?? "workspace", this.options.spaceId ?? ""]);
      const store = new DurableWorkerJobs(this.options.stateRoot ?? join(homedir(), ".local", "state", "super-brain", "memory-worker", "jobs"), namespace);
      await store.open(); this.store = store; return store;
    })().catch((error) => { this.opening = undefined; throw error; });
    return this.opening;
  }
  async close(): Promise<void> {
    this.closing = true;
    this.watchController?.abort();
    for (const controller of this.modelRequests) controller.abort(new Error("worker-closed"));
    await Promise.allSettled([...this.background, this.draining, this.modelDraining, this.opening]);
    await this.store?.close(); this.store = undefined; this.opening = undefined;
  }
  configureProjectRoots(runs: readonly TranscriptRun[]): void {
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
  private async enqueueCandidates(candidates: readonly ExtractedCandidate[], witnessEvent?: FoldEvent, trajectoryEvent?: FoldEvent): Promise<void> {
    const jobs = await this.jobs();
    const merged = consolidateCandidateEvidence(candidates.map((candidate) => this.resolveCandidate(candidate)), {
      principalId: this.principalId!, audience: this.options.audience ?? "workspace",
      ...(this.options.spaceId === undefined ? {} : { spaceId: this.options.spaceId }),
    });
    for (const candidate of merged) await jobs.enqueue("propose", [candidateKey(candidate, this.principalId!),
      candidate.evidence.map(evidenceKey).sort(), candidate.extractor, ...(trajectoryEvent === undefined ? [] : [trajectoryEvent.id])], {
      candidate, ...(witnessEvent === undefined ? {} : { witnessEvent }), ...(trajectoryEvent === undefined ? {} : { trajectoryEvent }),
    } satisfies ProposalPayload, this.now());
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
  async archiveRuns(): Promise<{ runs: readonly TranscriptRun[]; eventIds: ReadonlyMap<string, string> }> {
    const [runs, entries] = await Promise.all([this.options.client.transcriptRuns(), this.options.client.listEvents({ kinds: ["transcript.run-imported"] })]);
    this.configureProjectRoots(runs);
    const eventIds = new Map<string, string>();
    for (const { event } of entries) for (const record of transcriptRecordsFromEvent(event)) if (record.recordType === "run") eventIds.set(record.run.id, event.id);
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
      const pending = (await jobs.active()).filter((job) => job.kind === kind && job.nextAttemptAt <= this.now()).slice(0, this.options.maxCandidatesPerRun ?? 25);
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
    return { proposed, promoted };
  }
  /** A separately scheduled, single-owner lane keeps slow providers away from extraction. */
  drainModelJobs(): Promise<void> {
    if (this.modelDraining === undefined) this.modelDraining = this.drainModels().finally(() => { this.modelDraining = undefined; });
    return this.modelDraining;
  }
  private async drainModels(): Promise<void> {
    const jobs = await this.jobs();
    for (const kind of ["cognition-plan", "synthesis"] as const) {
      const pending = (await jobs.active()).filter((job) => job.kind === kind && job.nextAttemptAt <= this.now()).slice(0, kind === "synthesis" ? 1 : 25);
      for (const job of pending) {
        if (this.closing) return;
        try {
          if (kind === "cognition-plan") await this.planSynthesis((job.payload as { event: FoldEvent }).event);
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
    const delay = Math.min(60 * 60_000, (this.options.retryBaseMs ?? 1_000) * 2 ** Math.min(Math.max(attempts - 1, 0), 12));
    await jobs.put({ ...latest, state, attempts, updatedAt: this.now(), nextAttemptAt: this.now() + delay, reason });
    this.options.reportWarning?.(`Processing job ${job.id} is ${state}: ${reason}`);
  }
  async coverage(): Promise<ProcessingCoverage> { return (await this.jobs()).coverage(); }
  async retryJob(id: string): Promise<void> {
    const jobs = await this.jobs();
    const original = await jobs.get(id);
    if (original === undefined) throw new TypeError("Unknown processing job");
    await jobs.enqueue(original.kind, ["explicit-reprocess", original.id, this.now()], original.payload, this.now());
  }
  async watch(options: { consumerId: string; replay?: "tail" | "all"; signal?: AbortSignal }): Promise<void> {
    await this.jobs();
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
        await this.drainJobs();
        await pause();
      }
    })();
    const consumer = this.options.client.consumeEvents({ consumerId: options.consumerId, replay: options.replay ?? "tail", signal: controller.signal,
        kinds: ["transcript.run-imported", "terminal.observation", "trajectory.recorded", "memory.recorded", "memory.revised"],
        onEvent: async ({ entry }) => {
          if (this.closing) throw new Error("Worker is closing");
          const event = entry.event;
          if (event.kind === "transcript.run-imported") {
            for (const record of transcriptRecordsFromEvent(event)) if (record.recordType === "run") await this.enqueueRun(record.run, event.id);
          } else if (event.kind === "terminal.observation") await this.enqueueCandidates(extractLiveMemoryCandidates(event), event);
          else if (event.kind === "trajectory.recorded") await (await this.jobs()).enqueue("verify-trajectory", [event.id, jobDigest(event), "attested-checkpoint-v1"], { event }, this.now());
          if (["trajectory.recorded", "memory.recorded", "memory.revised"].includes(event.kind) && this.options.continuousCognition) {
            await (await this.jobs()).enqueue("cognition-plan", [event.id], { event }, this.now());
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
