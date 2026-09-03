import type { FoldEvent } from "@_89/fold";
import type { MemoryCandidateView } from "@_89/fold-epistemic";
import { transcriptRecordsFromEvent, type TranscriptRun } from "@_89/fold-transcript";
import { trajectoryLogRecordsFromEvent } from "@_89/fold-trajectory";
import { SuperBrainApiError, SuperBrainClient } from "@_89/super-brain-client";

import { extractLiveMemoryCandidates, extractMemoryCandidates } from "./extractor.js";
import type { ExtractedCandidate, RunExtraction } from "./types.js";
import { readVaultMessages } from "./vault.js";

export interface WorkerOptions {
  readonly client: SuperBrainClient;
  readonly vaultRoot: string;
  readonly vaultEncryptionKey?: Uint8Array;
  readonly maxCandidatesPerRun?: number;
  readonly audience?: "personal" | "workspace";
  readonly autoPromote?: boolean;
}

export class TranscriptMemoryWorker {
  private readonly knownCandidateIds = new Set<string>();
  private readonly knownCandidateKeys = new Set<string>();
  private readonly candidatesByKey = new Map<string, MemoryCandidateView>();
  private readonly acceptedCandidateIds = new Set<string>();
  private initialized = false;
  private projectRoots: Array<{ readonly root: string; readonly projectId: string }> = [];

  constructor(private readonly options: WorkerOptions) {}

  private rememberCandidate(view: MemoryCandidateView): void {
    this.knownCandidateIds.add(view.candidate.id);
    const key = this.candidateKey(view.candidate);
    this.knownCandidateKeys.add(key);
    const current = this.candidatesByKey.get(key);
    if (current === undefined || (current.status !== "accepted" && view.status === "accepted")) {
      this.candidatesByKey.set(key, view);
    }
    if (view.status === "accepted") this.acceptedCandidateIds.add(view.candidate.id);
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
    if ((candidate.projectIds?.length ?? 0) > 0 || candidate.source !== "claude-mem-observation") return candidate;
    if (candidate.content === null || typeof candidate.content !== "object" || Array.isArray(candidate.content)) return candidate;
    const files = Array.isArray(candidate.content.files)
      ? candidate.content.files.filter((file): file is string => typeof file === "string")
      : [];
    const projectIds = new Set<string>();
    for (const file of files) {
      const match = this.projectRoots.find(({ root }) => file === root || file.startsWith(`${root}/`));
      if (match !== undefined) projectIds.add(match.projectId);
    }
    return projectIds.size === 0 ? candidate : { ...candidate, projectIds: [...projectIds].sort() };
  }

  private candidateKey(candidate: Pick<ExtractedCandidate, "source" | "summary" | "projectIds">): string {
    return JSON.stringify([
      candidate.source,
      candidate.summary.toLocaleLowerCase().replace(/\s+/g, " ").trim(),
      [...(candidate.projectIds ?? [])].sort(),
    ]);
  }

  async extractRun(run: TranscriptRun, runEventId: string): Promise<RunExtraction> {
    const messages = await readVaultMessages(this.options.vaultRoot, run, this.options.vaultEncryptionKey);
    if (messages === undefined) return { run, source: run.source, candidates: [], skippedReason: "vault artifact unavailable" };
    return {
      run,
      source: run.source,
      candidates: extractMemoryCandidates(run, runEventId, messages, this.options.maxCandidatesPerRun ?? 25)
        .map((candidate) => this.resolveCandidateProjects(candidate)),
    };
  }

  async propose(candidates: readonly ExtractedCandidate[]): Promise<number> {
    await this.initialize();
    const pending: ExtractedCandidate[] = [];
    const pendingKeys = new Set<string>();
    for (const candidate of candidates) {
      const key = this.candidateKey(candidate);
      if (this.knownCandidateIds.has(candidate.id)) continue;
      const existing = this.candidatesByKey.get(key);
      if (existing !== undefined) {
        await this.consolidateEvidence(existing, candidate);
        continue;
      }
      if (this.knownCandidateKeys.has(key)) continue;
      if (pendingKeys.has(key)) continue;
      pendingKeys.add(key);
      pending.push(candidate);
    }
    let proposed = 0;
    for (let offset = 0; offset < pending.length; offset += 100) {
      const batch = pending.slice(offset, offset + 100);
      try {
        await this.options.client.proposeMemoryCandidates(batch, { audience: this.options.audience ?? "workspace" });
        for (const candidate of batch) {
          this.knownCandidateIds.add(candidate.id);
          this.knownCandidateKeys.add(this.candidateKey(candidate));
        }
        proposed += batch.length;
      } catch (error) {
        if (!(error instanceof SuperBrainApiError) || error.status !== 409) throw error;
        for (const view of await this.candidateViews()) this.rememberCandidate(view);
        const retry = batch.filter((candidate) => !this.knownCandidateIds.has(candidate.id));
        if (retry.length > 0) {
          await this.options.client.proposeMemoryCandidates(retry, { audience: this.options.audience ?? "workspace" });
          for (const candidate of retry) {
            this.knownCandidateIds.add(candidate.id);
            this.knownCandidateKeys.add(this.candidateKey(candidate));
          }
          proposed += retry.length;
        }
      }
    }
    return proposed;
  }

  private async consolidateEvidence(existing: MemoryCandidateView, incoming: ExtractedCandidate): Promise<void> {
    if (existing.status !== "accepted" || existing.decision?.kind !== "accepted") return;
    const memory = await this.options.client.memoryById(existing.decision.memoryId);
    if (memory === undefined) return;
    const evidence = [...(memory.evidence ?? existing.candidate.evidence)];
    const evidenceKey = (item: (typeof evidence)[number]) => JSON.stringify([
      item.eventId,
      item.projectId ?? "",
      item.runId ?? "",
      item.turnId ?? "",
    ]);
    const keys = new Set(evidence.map(evidenceKey));
    for (const item of incoming.evidence) {
      const key = evidenceKey(item);
      if (keys.has(key)) continue;
      keys.add(key);
      evidence.push(item);
    }
    if (evidence.length === (memory.evidence ?? existing.candidate.evidence).length) return;
    await this.options.client.reviseMemory(
      memory.id,
      { evidence },
      incoming.evidence.map(({ eventId }) => eventId),
    );
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
    await this.initialize();
    const eligibleIds = new Set(candidates
      .filter((candidate) => this.autoPromotionEligible(candidate) && !this.acceptedCandidateIds.has(candidate.id))
      .map(({ id }) => id));
    if (eligibleIds.size === 0) return 0;
    return this.acceptCandidateIds(eligibleIds);
  }

  async processLiveEvent(event: FoldEvent): Promise<{ readonly proposed: number; readonly promoted: number }> {
    const candidates = extractLiveMemoryCandidates(event);
    if (candidates.length === 0) return { proposed: 0, promoted: 0 };
    const proposed = await this.propose(candidates);
    const promoted = await this.promote(candidates);
    return { proposed, promoted };
  }

  async promoteSuccessfulTrajectoryEvidence(event: FoldEvent): Promise<number> {
    if (this.options.autoPromote !== true || event.kind !== "trajectory.recorded") return 0;
    const successfulEvidence = new Set(trajectoryLogRecordsFromEvent(event)
      .filter((record) => record.recordType === "trajectory" && record.trajectory.outcome === "success")
      .flatMap((record) => record.recordType === "trajectory"
        ? record.trajectory.steps.flatMap((step) => step.eventId === undefined ? [] : [step.eventId])
        : []));
    if (successfulEvidence.size === 0) return 0;
    const candidateIds = new Set((await this.candidateViews("proposed"))
      .filter(({ candidate }) => candidate.source === "live-reasoning-checkpoint")
      .filter(({ candidate }) => candidate.evidence.some(({ eventId }) => successfulEvidence.has(eventId)))
      .map(({ candidate }) => candidate.id));
    return this.acceptCandidateIds(candidateIds);
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

  async processRun(run: TranscriptRun, runEventId: string, write: boolean): Promise<RunExtraction & { readonly proposed: number }> {
    const extraction = await this.extractRun(run, runEventId);
    const proposed = write ? await this.propose(extraction.candidates) : 0;
    if (write) await this.promote(extraction.candidates);
    return { ...extraction, proposed };
  }

  async watch(options: { readonly consumerId: string; readonly replay?: "tail" | "all"; readonly signal?: AbortSignal }): Promise<void> {
    await this.initialize();
    this.configureProjectRoots(await this.options.client.transcriptRuns());
    await this.options.client.consumeEvents({
      consumerId: options.consumerId,
      replay: options.replay ?? "tail",
      kinds: ["transcript.run-imported", "terminal.observation", "trajectory.recorded"],
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      onEvent: async ({ entry }) => {
        if (entry.event.kind === "transcript.run-imported") {
          const record = transcriptRecordsFromEvent(entry.event)[0];
          if (record?.recordType === "run") await this.processRun(record.run, entry.event.id, true);
        } else if (entry.event.kind === "terminal.observation") {
          await this.processLiveEvent(entry.event);
        } else if (entry.event.kind === "trajectory.recorded") {
          await this.promoteSuccessfulTrajectoryEvidence(entry.event);
        }
      },
    });
  }
}
