import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { parseEvent, type FoldEvent } from "@_89/fold";
import { effectiveMemoryApplicability, equivalentMemoryCandidateMeaning, mergeMemoryCandidateEvidence, memoryLogRecordsFromEvent, episodeWindowInputSchema, type EpisodeWindowInput, type MemoryCandidateView, type PersonalMemory } from "@_89/fold-epistemic";
import { transcriptRecordsFromEvent, transcriptDerivationChunkSchema, type TranscriptRun } from "@_89/fold-transcript";
import { trajectoryLogRecordsFromEvent } from "@_89/fold-trajectory";
import { SuperBrainApiError, SuperBrainClient } from "@_89/super-brain-client";

import { deterministicCandidateId, extractLiveMemoryCandidates, extractMemoryCandidatePage, RULE_EXTRACTOR, LIVE_EXTRACTOR, type ExtractionCursor } from "./extractor.js";
import { ProcessingBackpressureError, ProcessingJobStore, processingDigest, type ProcessingJob } from "./jobs.js";
import type { ExtractedCandidate, RunExtraction } from "./types.js";
import { readVaultMessages } from "./vault.js";
import { MEMORY_WORKER_EVENT_KINDS } from "./subscription.js";
import { DurableWindowScheduler, validateSchedulingWindow, type SchedulingWindow } from "./scheduler.js";

export interface WorkerOptions {
  readonly client: SuperBrainClient;
  readonly vaultRoot: string;
  readonly vaultEncryptionKey?: Uint8Array;
  readonly maxCandidatesPerRun?: number;
  readonly audience?: "personal" | "workspace";
  readonly autoPromote?: boolean;
  readonly continuousCognition?: boolean;
  readonly cognitionEveryEvents?: number;
  readonly cognitionElapsedMs?: number;
  readonly episodeFormation?: boolean;
  readonly episodeEveryEvents?: number;
  readonly episodeElapsedMs?: number;
  readonly reportWarning?: (message: string) => void;
  readonly processingRoot?: string;
  readonly credentialFingerprint?: string;
}

interface PreparedSynthesis {
  readonly candidate: ExtractedCandidate;
  readonly dependencies: readonly { readonly memoryId: string; readonly digest: string }[];
  readonly identity: string;
}
interface ExtractionProgress {
  readonly cursor?: ExtractionCursor;
  readonly sourceDigest?: string;
  readonly messages?: number;
  readonly candidatesProcessed?: number;
  readonly batch?: { readonly candidates: readonly ExtractedCandidate[]; readonly next?: ExtractionCursor };
  readonly synthesis?: PreparedSynthesis;
  readonly episode?: EpisodeWindowInput;
  readonly episodeContext?: { readonly ids: readonly string[]; readonly omitted: boolean };
}
class WaitingProcessingError extends Error {}
class ExcludedProcessingError extends Error {}

function validateProgress(value: unknown): void {
  if (value === undefined) return;
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid extraction progress");
  const progress = value as ExtractionProgress;
  if (progress.episode !== undefined) episodeWindowInputSchema.parse(progress.episode);
  if (progress.episodeContext !== undefined && (progress.episodeContext === null || !Array.isArray(progress.episodeContext.ids) || progress.episodeContext.ids.length > 5 || progress.episodeContext.ids.some(id => typeof id !== "string" || id.length === 0) || new Set(progress.episodeContext.ids).size !== progress.episodeContext.ids.length || typeof progress.episodeContext.omitted !== "boolean")) throw new Error("Invalid episode context checkpoint");
  const cursorValid = (cursor: ExtractionCursor | undefined) => cursor === undefined ||
    (cursor !== null && Number.isSafeInteger(cursor.message) && cursor.message >= 0 && Number.isSafeInteger(cursor.candidate) && cursor.candidate >= 0);
  if (!cursorValid(progress.cursor) || (progress.sourceDigest !== undefined && !/^[a-f0-9]{64}$/.test(progress.sourceDigest)) ||
    [progress.messages, progress.candidatesProcessed].some((count) => count !== undefined && (!Number.isSafeInteger(count) || count < 0)) ||
    (progress.batch !== undefined && (progress.batch === null || !Array.isArray(progress.batch.candidates) || progress.batch.candidates.length > 500 || !cursorValid(progress.batch.next))) ||
    (progress.synthesis !== undefined && (progress.synthesis === null || !Array.isArray(progress.synthesis.dependencies) ||
      !/^[a-f0-9]{64}$/.test(progress.synthesis.identity) || progress.synthesis.candidate === null || typeof progress.synthesis.candidate !== "object" ||
      progress.synthesis.dependencies.some((item) => item === null || typeof item.memoryId !== "string" || !/^[a-f0-9]{64}$/.test(item.digest))))) {
    throw new Error("Invalid extraction progress; inspect the preserved job before resuming");
  }
}

const COGNITION_PROMPTS = [
  { kind: "synthesis", question: "What reusable principle is supported across otherwise separate projects? Cite only the supplied memories." },
  { kind: "contradiction", question: "Which accepted memories across projects appear to conflict or require a scope qualification? Cite only the supplied memories." },
  { kind: "procedure", question: "What repeatable cross-project procedure can be derived from the accepted evidence? Cite only the supplied memories." },
  { kind: "investigation", question: "What high-value unresolved cross-project investigation is warranted by the accepted evidence? Cite only the supplied memories." },
] as const;

function digestInteger(value: string): number {
  return createHash("sha256").update(value).digest().readUInt32BE(0);
}

function completionSignal(event: FoldEvent): boolean {
  return trajectoryLogRecordsFromEvent(event).some(record =>
    record.recordType === "outcome" ? record.outcome !== "unknown" : record.recordType === "trajectory" && record.trajectory.outcome !== "unknown");
}

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
  private readonly schedulers = new WeakMap<ProcessingJobStore, DurableWindowScheduler>();
  private readonly episodeSchedulers = new WeakMap<ProcessingJobStore, DurableWindowScheduler>();
  private readonly episodeRuns = new Map<string, TranscriptRun>();
  private readonly episodeProjects = new Set<string>();
  private readonly knownCandidateIds = new Set<string>();
  private readonly unrefreshedProposalIds = new Map<string, Set<string>>();
  private readonly proposalInputs = new Map<string, ExtractedCandidate>();
  private readonly candidateViewsById = new Map<string, MemoryCandidateView>();
  private readonly candidatesByKey = new Map<string, Map<string, MemoryCandidateView>>();
  private readonly acceptedCandidateIds = new Set<string>();
  private readonly runningJobs = new Set<string>();
  private proposalQueue: Promise<void> = Promise.resolve();
  private initialized = false;
  private cognitionUnavailableReason: string | undefined;
  private projectRoots: Array<{ readonly root: string; readonly projectId: string }> = [];

  constructor(private readonly options: WorkerOptions) {}

  private rememberCandidate(view: MemoryCandidateView): void {
    this.candidateViewsById.set(view.candidate.id, view);
    this.knownCandidateIds.add(view.candidate.id);
    const key = this.candidateKey(view.candidate);
    this.unrefreshedProposalIds.get(key)?.delete(view.candidate.id);
    let views = this.candidatesByKey.get(key);
    if (views === undefined) { views = new Map(); this.candidatesByKey.set(key, views); }
    views.set(view.candidate.id, view);
    if (view.status === "accepted") this.acceptedCandidateIds.add(view.candidate.id);
  }

  private rememberProposal(candidate: ExtractedCandidate): void {
    this.proposalInputs.set(candidate.id, candidate);
    this.knownCandidateIds.add(candidate.id);
    const key = this.candidateKey(candidate);
    let ids = this.unrefreshedProposalIds.get(key);
    if (ids === undefined) { ids = new Set(); this.unrefreshedProposalIds.set(key, ids); }
    ids.add(candidate.id);
  }

  private async candidateViews(status?: MemoryCandidateView["status"]): Promise<readonly MemoryCandidateView[]> {
    const views: MemoryCandidateView[] = [];
    const limit = 1_000;
    for (let offset = 0; ; offset += limit) {
      const page = await this.options.client.memoryCandidates({ ...(status === undefined ? {} : { status }), offset, limit });
      views.push(...page);
      if (page.length < limit) return views;
    }
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;
    for (const view of await this.candidateViews()) {
      this.rememberCandidate(view);
    }
    this.initialized = true;
  }

  configureProjectRoots(runs: readonly TranscriptRun[]): void {
    const roots = new Map<string, string>();
    for (const run of runs) {
      this.episodeRuns.set(run.id, run);
      if (run.projectId !== undefined) this.episodeProjects.add(run.projectId);
      for (const segment of run.segments) if (segment.projectId !== undefined) this.episodeProjects.add(segment.projectId);
      for (const segment of run.segments) {
        if (
          segment.projectId !== undefined &&
          segment.cwd !== undefined &&
          !segment.cwd.includes("/.claude-mem/observer-sessions")
        ) {
          roots.set(segment.cwd.replace(/\/$/, ""), segment.projectId);
        }
      }
    }
    this.projectRoots = [...roots].map(([root, projectId]) => ({ root, projectId }))
      .sort((left, right) => right.root.length - left.root.length);
  }

  private resolveCandidateProjects(candidate: ExtractedCandidate): ExtractedCandidate {
    if (candidate.applicability === "general" || (candidate.projectIds?.length ?? 0) > 0 || candidate.source !== "claude-mem-observation") return candidate;
    if (candidate.content === null || typeof candidate.content !== "object" || Array.isArray(candidate.content)) return candidate;
    const files = Array.isArray(candidate.content.files)
      ? candidate.content.files.filter((file): file is string => typeof file === "string")
      : [];
    const projectIds = new Set<string>();
    for (const file of files) {
      const match = this.projectRoots.find(({ root }) => file === root || file.startsWith(`${root}/`));
      if (match !== undefined) projectIds.add(match.projectId);
    }
    return projectIds.size === 0 ? candidate : { ...candidate, applicability: "project", projectIds: [...projectIds].sort() };
  }

  private candidateKey(candidate: Pick<ExtractedCandidate, "source" | "summary" | "projectIds" | "applicability">): string {
    return JSON.stringify([
      candidate.source,
      effectiveMemoryApplicability({ ...candidate, projectIds: candidate.projectIds ?? [] }),
      candidate.summary.toLocaleLowerCase().replace(/\s+/g, " ").trim(),
      [...(candidate.projectIds ?? [])].sort(),
    ]);
  }

  async extractRun(run: TranscriptRun, runEventId: string): Promise<RunExtraction> {
    const messages = await readVaultMessages(this.options.vaultRoot, run, this.options.vaultEncryptionKey);
    if (messages === undefined) return { run, source: run.source, candidates: [], skippedReason: "vault artifact unavailable" };
    const candidates: ExtractedCandidate[] = [];
    let cursor: ExtractionCursor | undefined;
    do {
      const page = extractMemoryCandidatePage(run, runEventId, messages, cursor, this.options.maxCandidatesPerRun ?? 25);
      candidates.push(...page.candidates.map((candidate) => this.resolveCandidateProjects(candidate)));
      cursor = page.next;
    } while (cursor !== undefined);
    return { run, source: run.source, candidates };
  }

  async propose(candidates: readonly ExtractedCandidate[]): Promise<number> {
    const result = this.proposalQueue.then(() => this.proposeSerially(candidates));
    this.proposalQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async proposeSerially(candidates: readonly ExtractedCandidate[], retries = 3): Promise<number> {
    await this.initialize();
    const pending: ExtractedCandidate[] = [];
    for (const original of candidates) {
      let candidate = original;
      const knownView = this.candidateViewsById.get(candidate.id);
      const previous = knownView?.candidate ?? this.proposalInputs.get(candidate.id) ?? pending.find((item) => item.id === candidate.id);
      if (previous !== undefined && (!this.sameMeaning(previous, candidate) ||
        (knownView !== undefined && (knownView.candidate.audience !== (this.options.audience ?? "workspace") || knownView.candidate.spaceId !== undefined)))) {
        candidate = this.variantCandidate(candidate);
      }
      const key = this.candidateKey(candidate);
      let duplicate = false;
      const existingViews = [...(this.candidatesByKey.get(key)?.values() ?? [])]
        .sort((left, right) => Number(right.status === "accepted") - Number(left.status === "accepted"));
      for (const existing of existingViews) {
        if (await this.consolidateEvidence(existing, candidate)) { duplicate = true; break; }
      }
      if (duplicate) continue;
      if (this.knownCandidateIds.has(candidate.id)) {
        const known = this.candidateViewsById.get(candidate.id)?.candidate ?? this.proposalInputs.get(candidate.id);
        if (known === undefined || !this.sameMeaning(known, candidate)) throw new Error("Candidate identity collision requires review");
        if (mergeMemoryCandidateEvidence(known.evidence, candidate.evidence).length === known.evidence.length) continue;
        candidate = this.variantCandidate(candidate, true);
        if (this.knownCandidateIds.has(candidate.id)) continue;
      }
      for (const id of this.unrefreshedProposalIds.get(key) ?? []) {
        const previous = this.proposalInputs.get(id);
        if (previous !== undefined && this.sameMeaning(previous, candidate)) {
          if (mergeMemoryCandidateEvidence(previous.evidence, candidate.evidence).length === previous.evidence.length) { duplicate = true; break; }
          if (await this.addPendingSupport(id, candidate)) { duplicate = true; break; }
        }
      }
      if (duplicate) continue;
      const pendingIndex = pending.findIndex((previous) => this.candidateKey(previous) === key && this.sameMeaning(previous, candidate));
      if (pendingIndex >= 0) {
        const previous = pending[pendingIndex]!;
        pending[pendingIndex] = { ...previous, evidence: mergeMemoryCandidateEvidence(previous.evidence, candidate.evidence) };
        continue;
      }
      pending.push(candidate);
    }
    let proposed = 0;
    for (let offset = 0; offset < pending.length; offset += 100) {
      const fullBatch = pending.slice(offset, offset + 100);
      const batch = fullBatch.map((candidate) => ({ ...candidate, evidence: candidate.evidence.slice(0, 100) }));
      try {
        await this.options.client.proposeMemoryCandidates(batch, { audience: this.options.audience ?? "workspace" });
        for (const candidate of batch) {
          this.rememberProposal(candidate);
        }
        proposed += batch.length;
        for (const candidate of fullBatch) {
          for (let supportOffset = 100; supportOffset < candidate.evidence.length; supportOffset += 1000) {
            if (!await this.addPendingSupport(candidate.id, { ...candidate, evidence: candidate.evidence.slice(supportOffset, supportOffset + 1000) })) {
              proposed += await this.proposeSerially([{ ...candidate, id: this.variantCandidate(candidate, true).id }], retries);
              break;
            }
          }
        }
      } catch (error) {
        if (!(error instanceof SuperBrainApiError) || error.status !== 409) throw error;
        if (retries === 0) throw error;
        for (const view of await this.candidateViews()) this.rememberCandidate(view);
        proposed += await this.proposeSerially(fullBatch, retries - 1);
      }
    }
    return proposed;
  }

  private variantCandidate(candidate: ExtractedCandidate, includeEvidence = false): ExtractedCandidate {
    const meaning = [candidate.source, candidate.summary, candidate.content, candidate.applicability ?? effectiveMemoryApplicability({ ...candidate, projectIds: candidate.projectIds ?? [] }),
      [...(candidate.projectIds ?? [])].sort(), [...(candidate.tags ?? [])].sort(), candidate.entities ?? [], candidate.confidence, candidate.salience,
      candidate.extractor, this.options.audience ?? "workspace", ...(includeEvidence ? [candidate.evidence] : [])];
    const timestamp = Number.parseInt(candidate.id.replaceAll("-", "").slice(0, 12), 16);
    return { ...candidate, id: deterministicCandidateId(Number.isSafeInteger(timestamp) ? timestamp : 0,
      `candidate-variant-v1:${candidate.id}:${processingDigest(meaning)}`) };
  }

  private sameMeaning(left: ExtractedCandidate, right: ExtractedCandidate): boolean {
    return equivalentMemoryCandidateMeaning(
      { ...left, audience: this.options.audience ?? "workspace" },
      { ...right, audience: this.options.audience ?? "workspace" },
    );
  }

  private async addPendingSupport(candidateId: string, incoming: ExtractedCandidate): Promise<boolean> {
    try {
      const result = await this.options.client.addMemoryCandidateEvidence(candidateId, {
        ...incoming, audience: this.options.audience ?? "workspace",
      });
      this.rememberCandidate({ candidate: result.candidate, status: "proposed" });
      return true;
    } catch (error) {
      if (!(error instanceof SuperBrainApiError) || ![404, 409].includes(error.status)) throw error;
      const current = (await this.candidateViews()).find(({ candidate }) => candidate.id === candidateId);
      if (current === undefined) throw error;
      this.rememberCandidate(current);
      // A raced review is handled using its current result, never treated as successful support.
      if (current.status === "proposed") throw error;
      return this.consolidateEvidence(current, incoming);
    }
  }

  private async consolidateEvidence(existing: MemoryCandidateView, incoming: ExtractedCandidate): Promise<boolean> {
    if (existing.candidate.audience !== (this.options.audience ?? "workspace") || existing.candidate.spaceId !== undefined) return false;
    if (!this.sameMeaning(existing.candidate, incoming)) return false;
    if (existing.status === "proposed") {
      if (mergeMemoryCandidateEvidence(existing.candidate.evidence, incoming.evidence).length === existing.candidate.evidence.length) return true;
      return this.addPendingSupport(existing.candidate.id, incoming);
    }
    if (existing.status !== "accepted" || existing.decision?.kind !== "accepted") return false;
    const memory = await this.options.client.memoryById(existing.decision.memoryId);
    if (memory === undefined) return true;
    // The immutable proposal may no longer describe the user's revised memory.
    if (this.candidateKey(memory) !== this.candidateKey(incoming) ||
      memory.audience !== existing.candidate.audience || memory.spaceId !== existing.candidate.spaceId ||
      processingDigest(memory.content) !== processingDigest(incoming.content)) return false;
    const evidence = [...(memory.evidence ?? [])];
    const evidenceKey = (item: (typeof evidence)[number]) => JSON.stringify([
      item.eventId,
      item.projectId ?? "",
      item.runId ?? "",
      item.turnId ?? "",
    ]);
    const keys = new Set(evidence.map(evidenceKey));
    for (const item of [...existing.candidate.evidence, ...incoming.evidence]) {
      const key = evidenceKey(item);
      if (keys.has(key)) continue;
      keys.add(key);
      evidence.push(item);
    }
    if (evidence.length === (memory.evidence?.length ?? 0)) return true;
    await this.options.client.reviseMemory(
      memory.id,
      { evidence },
      [...new Set(incoming.evidence.map(({ eventId }) => eventId))],
    );
    return true;
  }

  async repairAcceptedEvidence(apply = false): Promise<{
    readonly inspected: number;
    readonly missingMemories: number;
    readonly repairable: number;
    readonly repaired: number;
  }> {
    const accepted = await repairRequest(() => this.candidateViews("accepted"));
    let missingMemories = 0;
    let repairable = 0;
    let repaired = 0;
    for (const view of accepted) {
      if (view.decision?.kind !== "accepted") continue;
      const memoryId = view.decision.memoryId;
      const memory = await repairRequest(() => this.options.client.memoryById(memoryId));
      if (memory === undefined) { missingMemories += 1; continue; }
      const key = (item: NonNullable<PersonalMemory["evidence"]>[number]) =>
        JSON.stringify([item.eventId, item.projectId ?? "", item.runId ?? "", item.turnId ?? ""]);
      const evidence = new Map((memory.evidence ?? []).map((item) => [key(item), item]));
      for (const item of view.candidate.evidence) evidence.set(key(item), item);
      if (evidence.size === (memory.evidence?.length ?? 0)) continue;
      repairable += 1;
      if (!apply) continue;
      const acceptanceEventId = view.decision.eventId;
      await repairRequest(() => this.options.client.reviseMemory(memory.id, { evidence: [...evidence.values()] }, [acceptanceEventId]));
      repaired += 1;
    }
    return { inspected: accepted.length, missingMemories, repairable, repaired };
  }

  private autoPromotionEligible(candidate: ExtractedCandidate): boolean {
    return this.options.autoPromote === true &&
      (
        (candidate.source === "claude-mem-observation" && candidate.confidence >= 0.95) ||
        candidate.source === "live-human-decision"
      ) &&
      (candidate.projectIds?.length ?? 0) > 0;
  }

  private async acceptCandidateIds(candidateIds: ReadonlySet<string>): Promise<number> {
    if (this.options.autoPromote !== true || candidateIds.size === 0) return 0;
    const proposed = await this.candidateViews("proposed");
    const pending = proposed
      .filter(({ candidate }) => candidateIds.has(candidate.id))
      .filter(({ candidate }) => candidate.audience === (this.options.audience ?? "workspace"));
    let promoted = 0;
    for (let offset = 0; offset < pending.length; offset += 100) {
      const batch = pending.slice(offset, offset + 100);
      await this.options.client.acceptMemoryCandidates(batch.map(({ candidate }) => candidate.id), {
        audience: this.options.audience ?? "workspace",
      });
      batch.forEach(({ candidate }) => this.acceptedCandidateIds.add(candidate.id));
      promoted += batch.length;
    }
    if (promoted > 0) {
      for (const view of await this.candidateViews("accepted")) this.rememberCandidate(view);
    }
    return promoted;
  }

  async promote(candidates: readonly ExtractedCandidate[]): Promise<number> {
    const result = this.proposalQueue.then(() => this.promoteSerially(candidates));
    this.proposalQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async promoteSerially(candidates: readonly ExtractedCandidate[]): Promise<number> {
    await this.initialize();
    const eligibleIds = new Set(candidates
      .filter((candidate) => this.autoPromotionEligible(candidate) && !this.acceptedCandidateIds.has(candidate.id))
      .map(({ id }) => id));
    if (eligibleIds.size === 0) return 0;
    return this.acceptCandidateIds(eligibleIds);
  }

  async processLiveEvent(event: FoldEvent): Promise<{ readonly proposed: number; readonly promoted: number }> {
    await this.authorizedSource(event.id, event);
    const candidates = extractLiveMemoryCandidates(event);
    if (candidates.length === 0) return { proposed: 0, promoted: 0 };
    const proposed = await this.propose(candidates);
    const promoted = await this.promote(candidates);
    return { proposed, promoted };
  }

  async synthesizeAcrossProjects(event: Pick<FoldEvent, "id" | "kind" | "at">, prepare?: (result: PreparedSynthesis) => Promise<void>, windowId?: string): Promise<{
    readonly proposed: number;
    readonly skippedReason?: string;
  }> {
    if (this.options.continuousCognition !== true) return { proposed: 0, skippedReason: "continuous cognition disabled" };
    if (this.cognitionUnavailableReason !== undefined) {
      return { proposed: 0, skippedReason: this.cognitionUnavailableReason };
    }
    const seed = windowId ?? event.id;
    const prompt = COGNITION_PROMPTS[digestInteger(`${seed}:kind`) % COGNITION_PROMPTS.length]!;
    const accepted = [...await this.candidateViews("accepted")].sort((left, right) =>
      right.candidate.salience - left.candidate.salience ||
      right.candidate.confidence - left.candidate.confidence ||
      right.candidate.proposedAt - left.candidate.proposedAt ||
      left.candidate.id.localeCompare(right.candidate.id)
    );
    accepted.forEach((view) => this.rememberCandidate(view));
    const acceptedByMemoryId = new Map(accepted.flatMap((view) =>
      view.decision?.kind === "accepted" ? [[view.decision.memoryId, view] as const] : []
    ));
    const memoryByProject = new Map<string, string>();
    for (const view of accepted) {
      if (view.decision?.kind !== "accepted") continue;
      for (const projectId of view.candidate.projectIds) {
        if (!memoryByProject.has(projectId)) memoryByProject.set(projectId, view.decision.memoryId);
      }
    }
    let memoryIds = [...new Map([...memoryByProject]
      .sort(([left], [right]) => digestInteger(`${seed}:${left}`) - digestInteger(`${seed}:${right}`))
      .map(([, memoryId]) => [memoryId, memoryId]))
      .values()].slice(0, 10);
    if (memoryByProject.size < 2 || memoryIds.length < 2) {
      return { proposed: 0, skippedReason: "cross-project evidence unavailable" };
    }
    const before = await Promise.all(memoryIds.map((id) => this.options.client.memoryById(id)));
    if (before.some((memory) => memory === undefined)) return { proposed: 0, skippedReason: "source memory unavailable" };
    const eligible = before.filter((memory): memory is PersonalMemory => memory !== undefined && this.canPublishMemory(memory));
    memoryIds = eligible.map((memory) => memory.id);
    if (memoryIds.length < 2 || new Set(eligible.flatMap((memory) => memory.projectIds)).size < 2) {
      return { proposed: 0, skippedReason: "cross-project evidence with compatible publication scope unavailable" };
    }
    const dependencies = eligible.map((memory) => ({ memoryId: memory.id, digest: processingDigest(memory) }));
    let result: Awaited<ReturnType<SuperBrainClient["askReasoning"]>>;
    try {
      result = await this.options.client.askReasoning({ question: prompt.question, memoryIds });
    } catch (error) {
      if (error instanceof SuperBrainApiError && error.status === 403 && error.code === "credential_scope_denied") {
        this.cognitionUnavailableReason = "reasoning access unavailable";
        this.options.reportWarning?.(
          "Continuous cognition is disabled for this process because its credential lacks reasoning:read",
        );
        return { proposed: 0, skippedReason: this.cognitionUnavailableReason };
      }
      throw error;
    }
    if (result.provider.kind !== "model") return { proposed: 0, skippedReason: "model reasoning provider unavailable" };
    if (result.citations.some((id) => !memoryIds.includes(id))) throw new Error("Synthesis cited memory outside the prepared evidence set");
    const memories = (await Promise.all(result.citations.map((memoryId) => this.options.client.memoryById(memoryId))))
      .filter((memory): memory is PersonalMemory => memory !== undefined);
    if (memories.length !== result.citations.length || memories.some((memory) => dependencies.find((item) => item.memoryId === memory.id)?.digest !== processingDigest(memory))) {
      throw new WaitingProcessingError("Synthesis source changed during model execution");
    }
    const projectIds = [...new Set(memories.flatMap((memory) => memory.projectIds))].sort();
    if (projectIds.length < 2) return { proposed: 0, skippedReason: "cross-project evidence unavailable" };
    const evidence = [...new Map(memories
      .flatMap((memory) => memory.evidence ?? acceptedByMemoryId.get(memory.id)?.candidate.evidence ?? [])
      .map((item) => [JSON.stringify([item.eventId, item.projectId ?? "", item.runId ?? "", item.turnId ?? ""]), item]))
      .values()].slice(0, 20);
    if (evidence.length === 0) return { proposed: 0, skippedReason: "canonical evidence unavailable" };
    const summary = result.answer.replace(/\s+/g, " ").trim().slice(0, 500);
    if (summary.length === 0) return { proposed: 0, skippedReason: "model returned an empty synthesis" };
    const candidate: ExtractedCandidate = {
      id: deterministicCandidateId(
        event.at.t,
        `continuous-cognition-v1\0${prompt.kind}\0${result.provider.id}\0${result.citations.join("\0")}\0${result.answer}`,
      ),
      projectIds,
      applicability: "project",
      source: "continuous-cognition",
      summary,
      content: {
        kind: prompt.kind,
        synthesis: result.answer,
        citations: [...result.citations],
        provider: result.provider.id,
        triggerEventId: event.id,
        ...(windowId === undefined ? {} : { triggerWindowId: windowId }),
      },
      tags: ["continuous-cognition", "cross-project", prompt.kind],
      evidence,
      confidence: 0.65,
      salience: 0.75,
      extractor: { kind: "model", id: result.provider.id, version: "1" },
    };
    if (prepare !== undefined) {
      await prepare({ candidate, dependencies, identity: processingDigest({ dependencies, prompt, provider: result.provider, policy: "continuous-cognition-v1" }) });
      return { proposed: 0 };
    }
    return { proposed: await this.propose([candidate]) };
  }

  async archiveRuns(): Promise<{ readonly runs: readonly TranscriptRun[]; readonly eventIds: ReadonlyMap<string, string> }> {
    const [runs, entries] = await Promise.all([
      this.options.client.transcriptRuns(),
      this.options.client.listEvents({ kinds: ["transcript.run-imported"] }),
    ]);
    this.configureProjectRoots(runs);
    const eventIds = new Map<string, string>();
    for (const { event } of entries) {
      const record = transcriptRecordsFromEvent(event)[0];
      if (record?.recordType === "run") eventIds.set(record.run.id, event.id);
    }
    return { runs, eventIds };
  }

  async processRun(run: TranscriptRun, runEventId: string, write: boolean): Promise<RunExtraction & { readonly proposed: number; readonly promoted: number }> {
    try {
      const source = await this.authorizedSource(runEventId);
      const record = transcriptRecordsFromEvent(source)[0];
      if (record?.recordType !== "run" || processingDigest(record.run) !== processingDigest(run)) throw new Error("Run does not match its authorized source event");
    } catch (error) {
      if (!(error instanceof WaitingProcessingError) && !(error instanceof ExcludedProcessingError)) throw error;
      return { run, source: run.source, candidates: [], proposed: 0, promoted: 0, skippedReason: error.message };
    }
    const extraction = await this.extractRun(run, runEventId);
    const proposed = write ? await this.propose(extraction.candidates) : 0;
    const promoted = write ? await this.promote(extraction.candidates) : 0;
    return { ...extraction, proposed, promoted };
  }

  async openScheduler(store: ProcessingJobStore, initialSequence: string): Promise<DurableWindowScheduler> {
    const existing = this.schedulers.get(store);
    if (existing !== undefined) return existing;
    const policy = processingDigest(this.processingPolicy("synthesis"));
    const scheduler = new DurableWindowScheduler(store, policy, {
      every: this.options.cognitionEveryEvents ?? 25,
      elapsedMs: this.options.cognitionElapsedMs ?? 300_000,
      deliver: (window, event) => store.enqueue("synthesis", [window.id, policy], event, policy, window),
    });
    await scheduler.open(initialSequence);
    this.schedulers.set(store, scheduler);
    return scheduler;
  }

  async openEpisodeScheduler(store: ProcessingJobStore, initialSequence: string): Promise<DurableWindowScheduler> {
    const existing = this.episodeSchedulers.get(store);
    if (existing !== undefined) return existing;
    const policy = processingDigest(this.processingPolicy("episode"));
    const scheduler = new DurableWindowScheduler(store, policy, {
      every: this.options.episodeEveryEvents ?? 25, elapsedMs: this.options.episodeElapsedMs ?? 300_000, capacity: 200,
      deliver: (window, event) => store.enqueue("episode", [window.id, policy], event, policy, window),
    });
    await scheduler.open(initialSequence); this.episodeSchedulers.set(store, scheduler); return scheduler;
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
      if (record.recordType === "run") {
        this.episodeRuns.set(record.run.id, record.run);
        if (record.run.projectId !== undefined) this.episodeProjects.add(record.run.projectId);
        for (const segment of record.run.segments) if (segment.projectId !== undefined) this.episodeProjects.add(segment.projectId);
        addRun(record.run);
      }
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
      for (const projectId of memory.projectIds) projects.add(projectId);
    }
    return projects.size === 1 ? [...projects][0] : undefined;
  }

  async scheduleEvent(store: ProcessingJobStore, event: FoldEvent, ingestionSequence?: string): Promise<number> {
    let queued = 0;
    const enqueue = async (kind: ProcessingJob["kind"]) => {
      const policy = this.processingPolicy(kind);
      if (await store.enqueue(kind, [event.id, policy], event, processingDigest(policy))) queued++;
    };
    if (event.kind === "transcript.run-imported") await enqueue("transcript");
    else if (event.kind === "terminal.observation" && extractLiveMemoryCandidates(event).length > 0) await enqueue("live");
    if (this.options.continuousCognition === true && ingestionSequence !== undefined) {
      const scheduler = await this.openScheduler(store, "0");
      const eligible = ["trajectory.recorded", "memory.recorded", "memory.revised", "trajectory.outcome-recorded"].includes(event.kind);
      const restricted = event.capture.scope?.space !== undefined || event.capture.scope?.creator !== undefined;
      await scheduler.observe(ingestionSequence, !eligible || restricted ? undefined : {
        event, partition: processingDigest({ workspace: event.capture.scope?.workspace, audience: this.options.audience ?? "workspace" }),
        completion: completionSignal(event),
      }, Date.now(), eligible && restricted);
    } else if (this.options.continuousCognition === true && ["trajectory.recorded", "memory.recorded", "memory.revised", "trajectory.outcome-recorded"].includes(event.kind)) {
      throw new TypeError("Continuous scheduling requires an ingestion sequence; use synthesizeAcrossProjects for an explicit on-demand request");
    }
    if (this.options.episodeFormation === true && ingestionSequence !== undefined) {
      const scheduler = await this.openEpisodeScheduler(store, "0");
      const restricted = event.capture.scope?.space !== undefined || event.capture.scope?.creator !== undefined;
      const projectId = restricted ? undefined : await this.episodeProject(event);
      await scheduler.observe(ingestionSequence, projectId === undefined ? undefined : {
        event, projectId, partition: processingDigest({ projectId, workspace: event.capture.scope?.workspace, audience: this.options.audience ?? "workspace" }),
        completion: completionSignal(event),
      }, Date.now(), restricted || projectId === undefined);
    }
    return queued;
  }

  async queueTranscriptBackfill(store?: ProcessingJobStore, limit?: number) {
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) throw new TypeError("Backfill limit must be a positive integer");
    const archive = await this.archiveRuns();
    const results: { runId: string; status: "eligible" | "queued" | "existing" | "excluded" | "unavailable" }[] = [];
    for (const run of limit === undefined ? archive.runs : archive.runs.slice(0, limit)) {
      const eventId = archive.eventIds.get(run.id);
      if (eventId === undefined) { results.push({ runId: run.id, status: "unavailable" }); continue; }
      let event: FoldEvent;
      try { event = await this.authorizedSource(eventId); }
      catch (error) {
        if (error instanceof WaitingProcessingError || error instanceof ExcludedProcessingError) {
          results.push({ runId: run.id, status: error instanceof ExcludedProcessingError ? "excluded" : "unavailable" });
          continue;
        }
        throw error;
      }
      const record = transcriptRecordsFromEvent(event)[0];
      if (record?.recordType !== "run" || processingDigest(record.run) !== processingDigest(run)) throw new Error("Run changed during backfill inventory; retry without discarding queued jobs");
      results.push({ runId: run.id, status: store === undefined ? "eligible" : await this.scheduleEvent(store, event) > 0 ? "queued" : "existing" });
    }
    return { mode: store === undefined ? "dry-run" : "queue", runs: results.length,
      counts: Object.fromEntries((["eligible", "queued", "existing", "excluded", "unavailable"] as const).map((status) => [status, results.filter((item) => item.status === status).length])),
      coverage: "authorized run inventory; artifact availability is checked during processing", results };
  }

  async queueEpisodeSources(eventIds: readonly string[], projectId: string, store?: ProcessingJobStore) {
    if (eventIds.length < 1 || eventIds.length > 200 || new Set(eventIds).size !== eventIds.length || eventIds.some(id => id.trim().length === 0) || projectId.trim().length === 0) throw new TypeError("Choose 1 to 200 distinct event IDs and one exact project ID");
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
        if (error instanceof WaitingProcessingError || error instanceof ExcludedProcessingError) problems.push({ eventId: id, reason: error.message });
        else throw error;
      }
    }
    if (problems.length > 0) {
      if (store !== undefined) throw new TypeError("Episode queue refused: one or more chosen sources are unavailable or outside the requested publication scope; run preview");
      return { mode: "dry-run", eligible: false, projectId, selected: eventIds.length, problems };
    }
    const policy = processingDigest(this.processingPolicy("episode"));
    // Manual chosen sets have no transport cursor or elapsed-time deadline; zero times are explicit sentinels.
    const identity = { version: 1 as const, policy, partition: processingDigest({ projectId, workspace: events[0]!.capture.scope.workspace, audience: "workspace" }), projectId,
      trigger: "manual" as const, openedAt: 0, sealedAt: 0, sources: events.map(event => ({ eventId: event.id, digest: processingDigest(event), sourceTime: event.at.t })) };
    const window = { ...identity, id: processingDigest(identity) };
    const queued = store === undefined ? undefined : await store.enqueue("episode", [window.id, policy], events.at(-1)!, policy, window);
    return { mode: store === undefined ? "dry-run" : "queue", eligible: true, projectId, selected: events.length, windowId: window.id,
      ...(queued === undefined ? {} : { queued }), sourceEventIds: events.map(event => event.id), coverage: "chosen authorized source events only; no consumer cursor change or model call" };
  }

  private processingPolicy(kind: ProcessingJob["kind"]) {
    if (kind === "episode") return { scheduler: "episode-window-v1", audience: this.options.audience ?? "workspace", every: this.options.episodeEveryEvents ?? 25,
      elapsedMs: this.options.episodeElapsedMs ?? 300_000, capacity: 200, enabled: this.options.episodeFormation === true, sourceKinds: MEMORY_WORKER_EVENT_KINDS, publication: "content-limited-v1" };
    return { extractor: kind === "live" ? LIVE_EXTRACTOR : RULE_EXTRACTOR, audience: this.options.audience ?? "workspace", autoPromote: this.options.autoPromote === true,
      ...(kind === "synthesis" ? {} : { deliveryPolicy: "candidate-support-v2" }),
      ...(kind === "synthesis" ? { prompts: COGNITION_PROMPTS, enabled: this.options.continuousCognition === true, every: this.options.cognitionEveryEvents ?? 25,
        elapsedMs: this.options.cognitionElapsedMs ?? 300_000, scheduler: "exact-window-v1", capacity: 1_000 } : {}) };
  }

  private canPublishMemory(memory: PersonalMemory): boolean {
    return memory.audience === (this.options.audience ?? "workspace") && memory.spaceId === undefined;
  }

  private async authorizedSource(eventId: string, expected?: FoldEvent): Promise<FoldEvent> {
    const authorized = await this.options.client.eventById(eventId);
    if (authorized === undefined) throw new WaitingProcessingError("source event unavailable");
    if (expected !== undefined && processingDigest(authorized) !== processingDigest(expected)) throw new Error("Source event changed after scheduling");
    if (authorized.capture.scope?.space !== undefined || authorized.capture.scope?.creator !== undefined) {
      throw new ExcludedProcessingError("source publication scope incompatible with unscoped worker output");
    }
    return authorized;
  }

  async drainProcessingJobs(store: ProcessingJobStore, now = Date.now(), lane: "all" | "extraction" | "synthesis" = "all"): Promise<void> {
    for (const initial of store.due(now, 25, lane)) {
      if (this.runningJobs.has(initial.id)) continue;
      let job = initial;
      const save = async (patch: Partial<ProcessingJob>) => {
        const updated = { ...job, ...patch, updatedAt: now };
        await store.save(updated);
        job = updated;
      };
      try { parseEvent(initial.input); validateProgress(initial.progress); if (initial.triggerWindow !== undefined) validateSchedulingWindow(initial.triggerWindow); }
      catch {
        await save({ status: "blocked", reason: "invalid source or processing checkpoint; inspect preserved job" });
        continue;
      }
      if (job.status === "complete" || job.status === "excluded") { await store.save(job); continue; }
      this.runningJobs.add(initial.id);
      try {
        if (job.configuration !== processingDigest(this.processingPolicy(job.kind))) {
          await save({ status: "blocked", reason: "processing policy changed; restore or explicitly migrate the saved job policy" });
          continue;
        }
        const event = job.input as FoldEvent;
        await this.authorizedSource(event.id, event);
        let progress = (job.progress ?? {}) as ExtractionProgress;
        if (job.kind === "transcript") {
          const record = transcriptRecordsFromEvent(event)[0];
          if (record?.recordType !== "run") throw new Error("Transcript job has no run record");
          const messages = await readVaultMessages(this.options.vaultRoot, record.run, this.options.vaultEncryptionKey);
          if (messages === undefined) throw new WaitingProcessingError("vault artifact unavailable");
          const sourceDigest = processingDigest(messages);
          if (progress.sourceDigest !== undefined && progress.sourceDigest !== sourceDigest) throw new Error("Vault evidence changed after extraction checkpoint");
          if (progress.batch === undefined) {
            const page = extractMemoryCandidatePage(record.run, event.id, messages, progress.cursor, this.options.maxCandidatesPerRun ?? 25);
            progress = { ...progress, sourceDigest, messages: page.messages, batch: { candidates: page.candidates.map((candidate) => this.resolveCandidateProjects(candidate)), ...(page.next === undefined ? {} : { next: page.next }) } };
            await save({ progress });
          }
          await this.propose(progress.batch!.candidates);
          await this.promote(progress.batch!.candidates);
          const next = progress.batch!.next;
          const completed = (progress.candidatesProcessed ?? 0) + progress.batch!.candidates.length;
          progress = { sourceDigest, messages: messages.length, candidatesProcessed: completed, ...(next === undefined ? {} : { cursor: next }) };
          await save({ progress, attempts: 0, status: next === undefined ? "complete" : "pending", nextAttemptAt: 0 });
        } else if (job.kind === "live") {
          await this.processLiveEvent(event);
          await save({ status: "complete", nextAttemptAt: 0 });
        } else if (job.kind === "episode") {
          validateSchedulingWindow(job.triggerWindow);
          const window = job.triggerWindow;
          if (window.policy !== job.configuration || window.projectId === undefined || window.sources.length > 200 || window.sources.at(-1)?.eventId !== event.id) throw new Error("Invalid episode job scope");
          for (const source of window.sources) {
            const current = await this.authorizedSource(source.eventId);
            if (processingDigest(current) !== source.digest) throw new WaitingProcessingError("episode source changed or unavailable");
          }
          if (progress.episode === undefined) {
            if (progress.episodeContext === undefined) {
              const page = await this.options.client.episodePage({ projectId: window.projectId, limit: 20 });
              const context = page.items.filter(item => item.projectId === window.projectId && item.audience === (this.options.audience ?? "workspace") && item.spaceId === undefined).slice(0, 5);
              progress = { ...progress, episodeContext: { ids: context.map(item => item.episodeId), omitted: page.total > context.length } };
              await save({ progress });
            }
            try {
              const episode = await this.options.client.synthesizeEpisodeWindow({ windowId: window.id, sourceEventIds: window.sources.map(source => source.eventId),
                projectId: window.projectId, audience: this.options.audience ?? "workspace", trigger: window.trigger,
                contextEpisodeIds: progress.episodeContext!.ids,
                ...(window.parentWindowId === undefined ? {} : { parentWindowId: window.parentWindowId }) });
              episodeWindowInputSchema.parse(episode);
              progress = { ...progress, episode }; await save({ progress });
            } catch (error) {
              if (!(error instanceof SuperBrainApiError) || error.status !== 413 || error.code !== "episode_input_too_large") throw error;
              if (progress.episodeContext!.ids.length > 0) {
                progress = { ...progress, episodeContext: { ids: [], omitted: true } }; await save({ progress });
                throw new WaitingProcessingError("episode input budget exceeded; retrying same sources without optional prior context");
              }
              if (window.sources.length === 1) { await save({ status: "blocked", reason: "single episode source exceeds model input budget; preserve source and increase supported budget or add record-level splitting", nextAttemptAt: 0 }); continue; }
              const middle = Math.ceil(window.sources.length / 2);
              for (const sources of [window.sources.slice(0, middle), window.sources.slice(middle)]) {
                const { id: _id, ...previous } = window;
                const identity = { ...previous, parentWindowId: window.id, trigger: "capacity" as const, sources };
                const child = { ...identity, id: processingDigest(identity) };
                const anchor = await this.authorizedSource(sources.at(-1)!.eventId);
                await store.enqueue("episode", [child.id, window.policy], anchor, window.policy, child);
              }
              await save({ status: "complete", reason: "split into two durable child windows after model input budget refusal", nextAttemptAt: 0 }); continue;
            }
          }
          const preparedEpisode = progress.episode!;
          if (preparedEpisode.sources.length !== window.sources.length || preparedEpisode.sources.some(source => !window.sources.some(expected => expected.eventId === source.eventId && expected.digest === source.sha256)) || preparedEpisode.projectId !== window.projectId || preparedEpisode.windowId !== window.id || preparedEpisode.parentWindowId !== window.parentWindowId || preparedEpisode.audience !== (this.options.audience ?? "workspace") || preparedEpisode.spaceId !== undefined) throw new Error("Episode preparation changed its source window or publication scope");
          try { await this.options.client.publishEpisodeWindow(progress.episode!); }
          catch (error) {
            if (error instanceof SuperBrainApiError && error.status === 409) await save({ progress: {} });
            throw error;
          }
          await save({ status: "complete", nextAttemptAt: 0 });
        } else {
          if (job.triggerWindow === undefined) throw new Error("Synthesis job requires exact scheduling provenance");
          const window = job.triggerWindow as SchedulingWindow;
          if (window.policy !== job.configuration || window.sources.at(-1)?.eventId !== event.id) throw new Error("Synthesis scheduling provenance changed");
          for (const source of window.sources) {
            const current = await this.authorizedSource(source.eventId);
            if (processingDigest(current) !== source.digest) throw new WaitingProcessingError("synthesis trigger source changed or unavailable");
          }
          if (progress.synthesis === undefined) {
            const result = await this.synthesizeAcrossProjects(event, async (synthesis) => {
              progress = { synthesis: { ...synthesis, candidate: { ...synthesis.candidate, content: { synthesisContent: synthesis.candidate.content ?? null, triggerWindow: { ...window, sources: window.sources.map(source => ({ ...source })) } } }, identity: processingDigest({ output: synthesis.identity, window: window.id }) } };
              await save({ progress });
            }, window.id);
            if (result.skippedReason !== undefined) {
              if (result.skippedReason === "continuous cognition disabled" || result.skippedReason.startsWith("not selected")) {
                await save({ status: "excluded", reason: result.skippedReason });
                continue;
              }
              throw new WaitingProcessingError(result.skippedReason);
            }
          }
          if (progress.synthesis === undefined) throw new Error("Synthesis did not persist its result");
          for (const dependency of progress.synthesis.dependencies) {
            const memory = await this.options.client.memoryById(dependency.memoryId);
            if (memory === undefined || !this.canPublishMemory(memory) || processingDigest(memory) !== dependency.digest) {
              await save({ progress: {} });
              throw new WaitingProcessingError("synthesis dependency revised or unavailable; result invalidated");
            }
          }
          await this.propose([progress.synthesis.candidate]);
          await save({ status: "complete", nextAttemptAt: 0 });
        }
      } catch (error) {
        if (error instanceof ExcludedProcessingError) {
          await save({ status: "excluded", reason: error.message, nextAttemptAt: 0 });
          continue;
        }
        const waiting = error instanceof WaitingProcessingError;
        const attempts = job.attempts + 1;
        // Receipts intentionally omit arbitrary exception text, which can include credentials or transcript content.
        const reason = waiting ? error.message : error instanceof SuperBrainApiError ? `API ${error.status}: ${error.code}` : "processing failed; source, vault, or delivery requires retry";
        await save({ status: waiting ? "waiting" : attempts >= 8 ? "blocked" : "retry", attempts, reason, nextAttemptAt: now + Math.min(900_000, 1_000 * 2 ** Math.min(attempts, 10)) });
      } finally {
        this.runningJobs.delete(initial.id);
      }
    }
  }

  async watch(options: { readonly consumerId: string; readonly replay?: "tail" | "all"; readonly signal?: AbortSignal }): Promise<void> {
    if (this.options.processingRoot === undefined) throw new TypeError("watch requires processingRoot for durable jobs before subscriber checkpointing");
    await this.initialize();
    this.configureProjectRoots(await this.options.client.transcriptRuns());
    const store = new ProcessingJobStore(this.options.processingRoot, this.options.credentialFingerprint);
    await store.open();
    let scheduler: DurableWindowScheduler | undefined;
    let episodeScheduler: DurableWindowScheduler | undefined;
    try {
      if (this.options.continuousCognition === true || this.options.episodeFormation === true) {
        const initial = (await this.options.client.ingestionConsumerStatus(options.consumerId)).cursor?.sequence ?? "0";
        if (this.options.continuousCognition === true) scheduler = await this.openScheduler(store, initial);
        if (this.options.episodeFormation === true) episodeScheduler = await this.openEpisodeScheduler(store, initial);
      }
    } catch (error) { await store.close(); throw error; }
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted === true) abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    let failure: unknown;
    const pump = Promise.all((["extraction", "synthesis"] as const).map((lane) => (async () => {
      while (!controller.signal.aborted) {
        if (lane === "extraction") { await scheduler?.tick(); await episodeScheduler?.tick(); }
        await this.drainProcessingJobs(store, Date.now(), lane);
        await delay(250, undefined, { signal: controller.signal }).catch((error) => { if (!controller.signal.aborted) throw error; });
      }
    })().catch((error: unknown) => { failure = error; controller.abort(error); })));
    try { await this.options.client.consumeEvents({
      consumerId: options.consumerId,
      replay: options.replay ?? "tail",
      kinds: MEMORY_WORKER_EVENT_KINDS,
      checkpointEvery: 100,
      signal: controller.signal,
      onEvent: async ({ entry, cursor }) => {
        let paused = false;
        for (;;) {
          try { await this.scheduleEvent(store, entry.event, cursor?.sequence); break; }
          catch (error) {
            if (!(error instanceof ProcessingBackpressureError)) throw error;
            if (!paused) this.options.reportWarning?.("Processing capacity reached; intake is paused while durable jobs drain");
            paused = true;
            await delay(250, undefined, { signal: controller.signal });
          }
        }
      },
    }); } finally {
      controller.abort();
      options.signal?.removeEventListener("abort", abort);
      await pump;
      await store.close();
    }
    if (failure !== undefined) throw failure;
  }
}
