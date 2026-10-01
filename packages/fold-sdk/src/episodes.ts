import type { Author, FoldEvent, FoldLogEntry } from "@_89/fold";
import { episodeWindowInputSchema, episodeWindowFromEvent, episodeEvidenceQuality, makeEpisodeWindowEvent, rebuildWorkEpisodes, validateEpisodeSourceScope, validateEpisodeCitations,
  type EpisodePublication, type EpisodeWindowInput, type WorkEpisodeRevision } from "@_89/fold-epistemic";
import { rebuildMemories, memoryLogRecordsFromEvent } from "@_89/fold-epistemic";
import { derivationHash, rebuildTranscriptCatalog } from "@_89/fold-transcript";
import { authorizeEventAccess, FoldSdkAccessError } from "./access.js";
import type { FoldSdkAccessContext } from "./types.js";

export class EpisodeConflictError extends Error {}
export class EpisodeSourceBudgetError extends Error { constructor(readonly maxBytes: number) { super("Episode source window exceeds its byte budget; split without dropping sources"); } }
export class EpisodeService {
  private context: Promise<FoldEvent[]> | undefined;
  private readonly sourceCache = new Map<string, Promise<FoldLogEntry | undefined>>();
  private metadata: Promise<{ projects: string[]; memories: ReturnType<typeof rebuildMemories>["memories"] }> | undefined;
  private projected: Promise<ReturnType<typeof rebuildWorkEpisodes>> | undefined;
  constructor(private readonly entries: () => Promise<readonly FoldLogEntry[]>, private readonly lookup: (id: string) => Promise<FoldLogEntry | undefined>, private readonly append: (event: FoldEvent) => Promise<unknown>, private readonly access: FoldSdkAccessContext) {}

  private async events() {
    return this.context ??= this.entries().then(entries => entries.filter(entry => entry.status === "canon" && authorizeEventAccess(entry.event, this.access).allowed).map(entry => entry.event));
  }

  async sources(ids: readonly string[], publication: EpisodePublication, options: { readonly maxBytes?: number } = {}) {
    if (ids.length < 1 || ids.length > 200 || new Set(ids).size !== ids.length) throw new TypeError("Episode sources must contain 1 to 200 unique event IDs");
    const context = await this.events();
    const { projects, memories } = await (this.metadata ??= Promise.resolve({ projects: [...rebuildTranscriptCatalog(context.filter(event => event.kind === "transcript.project-recorded")).projects.keys()], memories: rebuildMemories(context.filter(event => ["memory.recorded", "memory.revised", "memory.forgotten"].includes(event.kind))).memories }));
    const events: FoldEvent[] = [];
    let bytes = 0;
    const maxBytes = options.maxBytes ?? 8_000_000;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 8_000_000) throw new TypeError("Episode source byte budget must be within [1, 8000000]");
    for (const id of ids) {
      let read = this.sourceCache.get(id);
      if (read === undefined) { read = this.lookup(id); this.sourceCache.set(id, read); }
      const entry = await read;
      if (entry?.status !== "canon" || !authorizeEventAccess(entry.event, this.access).allowed) throw new FoldSdkAccessError("Episode source unavailable");
      validateEpisodeSourceScope(entry.event, publication, this.access.workspaceId, this.access.principalId, projects, context, memories);
      {
        bytes += Buffer.byteLength(JSON.stringify(entry.event));
        for (const record of memoryLogRecordsFromEvent(entry.event)) {
          const memory = memories.get(record.recordType === "recorded" ? record.memory.id : record.memoryId);
          if (memory !== undefined) bytes += Buffer.byteLength(JSON.stringify(memory));
        }
        if (bytes > maxBytes) throw new EpisodeSourceBudgetError(maxBytes);
      }
      events.push(entry.event);
    }
    const assembledMemories = events.flatMap(event => memoryLogRecordsFromEvent(event).flatMap(record => {
      const memory = memories.get(record.recordType === "recorded" ? record.memory.id : record.memoryId);
      return memory === undefined ? [] : [{ eventId: event.id, memory }];
    }));
    return { events, assembledMemories, sources: events.map(event => {
      const memory = assembledMemories.find(item => item.eventId === event.id)?.memory;
      return { eventId: event.id, sha256: derivationHash(event), ...(memory === undefined ? {} : { memorySnapshot: { memoryId: memory.id, revision: memory.revision, sha256: derivationHash(memory) } }) };
    }), evidenceQuality: events.map(event => ({ eventId: event.id, quality: episodeEvidenceQuality(event) })) };
  }

  private async projection() {
    return this.projected ??= this.loadProjection();
  }
  private async loadProjection() {
    const events = await this.events();
    for (const event of events) { const record = episodeWindowFromEvent(event); if (record !== undefined && record.inputHash !== derivationHash({ input: record.input, workspaceId: record.workspaceId, actorId: record.actorId })) throw new EpisodeConflictError("Stored episode digest mismatch"); }
    return rebuildWorkEpisodes(events);
  }

  private async available(revision: WorkEpisodeRevision, projection: Awaited<ReturnType<EpisodeService["projection"]>>, visited = new Set<string>()): Promise<boolean> {
    const key = `${revision.episodeId}:${revision.revision}`;
    if (visited.has(key)) return true;
    visited.add(key);
    // A revised summary may depend on any earlier evidence. Retain and check all
    // revisions and explicit continuation dependencies, not just the latest window.
    for (const prior of projection.history.get(revision.episodeId) ?? []) {
      if (prior.audience === "personal" && !this.access.platformDataAccess && prior.actorId !== this.access.principalId) return false;
      try {
        const sources = await this.sources(prior.sources.map(source => source.eventId), prior);
        if (derivationHash(sources.sources) !== derivationHash(prior.sources)) return false;
      } catch (error) { if (error instanceof TypeError || error instanceof FoldSdkAccessError) return false; throw error; }
      const windowContext = projection.windows.get(prior.windowId)?.input.contextEpisodes ?? [];
      for (const link of [...prior.continuations, ...windowContext]) {
        const dependency = projection.history.get(link.episodeId)?.find(item => item.revision === link.revision);
        if (dependency === undefined || !await this.available(dependency, projection, visited)) return false;
      }
    }
    return true;
  }

  async list() {
    const projection = await this.projection();
    const result: WorkEpisodeRevision[] = [];
    for (const episode of projection.episodes.values()) if (await this.available(episode, projection)) result.push(episode);
    return result.sort((a, b) => b.recordedAt - a.recordedAt || a.episodeId.localeCompare(b.episodeId));
  }
  async get(id: string) {
    const projection = await this.projection(); const episode = projection.episodes.get(id);
    return episode !== undefined && await this.available(episode, projection) ? episode : undefined;
  }
  async history(id: string) {
    const projection = await this.projection(); const episode = projection.episodes.get(id);
    return episode !== undefined && await this.available(episode, projection) ? projection.history.get(id) ?? [] : [];
  }
  async window(id: string) {
    const projection = await this.projection(); const window = projection.windows.get(id);
    if (window === undefined) return undefined;
    try {
      const sources = await this.sources(window.input.sources.map(source => source.eventId), window.input);
      if (derivationHash(sources.sources) !== derivationHash(window.input.sources)) return undefined;
      for (const proposal of window.input.episodes) {
        const episode = projection.history.get(proposal.episodeId)?.find(item => item.revision === window.revision);
        if (episode === undefined || !await this.available(episode, projection)) return undefined;
      }
      return window;
    } catch (error) { if (error instanceof TypeError || error instanceof FoldSdkAccessError) return undefined; throw error; }
  }
  async windows() {
    const projection = await this.projection();
    const result = [];
    for (const id of projection.windows.keys()) { const window = await this.window(id); if (window !== undefined) result.push(window); }
    return result.sort((a,b) => b.recordedAt - a.recordedAt || a.input.windowId.localeCompare(b.input.windowId));
  }
  async publish(author: Author, value: EpisodeWindowInput) {
    if (this.access.platformDataAccess) throw new FoldSdkAccessError("Episode publication requires write access");
    const input = episodeWindowInputSchema.parse(value);
    if (input.spaceId !== undefined && !["admin", "writer"].includes(this.access.spaceRoles[input.spaceId] ?? "")) throw new FoldSdkAccessError("Episode publication requires space write access");
    const events = await this.events(); const projection = rebuildWorkEpisodes(events);
    const inputHash = derivationHash({ input, workspaceId: this.access.workspaceId, actorId: this.access.principalId });
    const existing = projection.windows.get(input.windowId);
    if (existing !== undefined) {
      if (existing.inputHash !== inputHash) throw new EpisodeConflictError("Episode window retry changed its input or output");
      const available = await this.window(input.windowId);
      if (available === undefined) throw new FoldSdkAccessError("Episode source unavailable");
      return available;
    }
    const verified = await this.sources(input.sources.map(source => source.eventId), input);
    if (derivationHash(verified.sources) !== derivationHash(input.sources)) throw new EpisodeConflictError("Episode sources changed");
    validateEpisodeCitations(input, new Map(verified.events.map(event => [event.id, event])));
    for (const link of input.contextEpisodes ?? []) {
      const target = projection.episodes.get(link.episodeId);
      if (target?.revision !== link.revision || target.projectId !== input.projectId || target.spaceId !== input.spaceId || target.audience !== input.audience || (target.audience === "personal" && target.actorId !== this.access.principalId) || !await this.available(target, projection)) throw new FoldSdkAccessError("Episode context changed or is unavailable");
    }
    for (const proposal of input.episodes) {
      const prior = projection.episodes.get(proposal.episodeId);
      if ((prior?.revision ?? null) !== proposal.previousRevision) throw new EpisodeConflictError("Episode revision changed");
      if (prior !== undefined && !await this.available(prior, projection)) throw new FoldSdkAccessError("Episode prior dependencies unavailable");
      for (const link of proposal.continuations) {
        const target = projection.history.get(link.episodeId)?.find(item => item.revision === link.revision);
        if (target === undefined || !await this.available(target, projection)) throw new FoldSdkAccessError("Episode continuation unavailable");
      }
    }
    const t = Math.max(Date.now(), ...[...projection.windows.values()].map(window => window.recordedAt + 1));
    const event = makeEpisodeWindowEvent({ workspaceId: this.access.workspaceId, principalId: this.access.principalId, author }, input, inputHash, t);
    const globalWindows = (await this.entries()).filter(entry => entry.status === "canon" && entry.event.capture.scope.workspace === this.access.workspaceId && entry.event.kind === "work.episode-window-recorded").map(entry => entry.event);
    try { rebuildWorkEpisodes([...globalWindows, event]); }
    catch { throw new EpisodeConflictError("Episode or window identity conflicts with existing records"); }
    await this.append(event);
    return episodeWindowFromEvent(event)!;
  }
}
