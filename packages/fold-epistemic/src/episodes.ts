import { parseEvent, type FoldEvent, type JsonValue } from "@_89/fold";
import { z } from "zod";
import { memoryLogRecordsFromEvent } from "./events.js";
import { rebuildMemories } from "./project.js";
import type { PersonalMemory } from "./types.js";

const id = z.string().trim().min(1).max(500);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const EPISODE_WINDOW_KIND = "work.episode-window-recorded";
export const EPISODE_WINDOW_NODE_KIND = "x.fold.episode-window";
export const episodeSourceSchema = z.object({ eventId: id, sha256: hash, memorySnapshot: z.object({ memoryId: id, revision: z.number().int().nonnegative(), sha256: hash }).strict().optional() }).strict();
export const episodeCitationSchema = z.object({ eventId: id, recordOrdinal: z.number().int().nonnegative().optional(), line: z.number().int().positive().optional() }).strict();
export const episodeClaimSchema = z.object({ text: z.string().trim().min(1).max(4000), citations: z.array(episodeCitationSchema).min(1).max(200) }).strict();
export const episodePublicationSchema = z.object({ projectId: id.nullable(), spaceId: id.optional(), audience: z.enum(["personal", "workspace"]) }).strict();
export const workEpisodeProposalSchema = z.object({
  episodeId: id, previousRevision: id.nullable(), title: z.string().trim().min(1).max(300),
  objective: episodeClaimSchema, summary: episodeClaimSchema,
  decisions: z.array(episodeClaimSchema).max(30), blockers: z.array(episodeClaimSchema).max(30),
  checks: z.array(episodeClaimSchema).max(30), openQuestions: z.array(episodeClaimSchema).max(30),
  memberEventIds: z.array(id).min(1).max(200),
  grouping: z.object({ reason: episodeClaimSchema, confidence: z.enum(["low", "medium", "high"]), uncertainties: z.array(z.string().trim().min(1).max(2000)).max(30) }).strict(),
  continuations: z.array(z.object({ episodeId: id, revision: id, reason: episodeClaimSchema }).strict()).max(20),
}).strict();
export const episodeWindowInputSchema = episodePublicationSchema.extend({
  schemaVersion: z.literal(1), windowId: id, parentWindowId: id.optional(),
  sources: z.array(episodeSourceSchema).min(1).max(200),
  trigger: z.enum(["count", "elapsed", "completion", "capacity", "manual"]),
  producer: z.object({ id, version: id, model: id.optional() }).strict(),
  contextEpisodes: z.array(z.object({ episodeId: id, revision: id }).strict()).max(20).optional(),
  episodes: z.array(workEpisodeProposalSchema).max(20),
  ungrouped: z.array(z.object({ eventId: id, reason: z.string().trim().min(1).max(2000) }).strict()).max(200),
}).strict().superRefine((window, context) => {
  const sourceIds = new Set(window.sources.map(source => source.eventId));
  const seen = new Set<string>();
  const issue = (message: string) => context.addIssue({ code: z.ZodIssueCode.custom, message });
  if (window.projectId === null && window.episodes.length > 0) issue("Unresolved project sources can only record ungrouped coverage");
  if (sourceIds.size !== window.sources.length) issue("duplicate window source");
  if (new Set(window.episodes.map(episode => episode.episodeId)).size !== window.episodes.length) issue("duplicate episode");
  for (const episode of window.episodes) {
    const members = new Set(episode.memberEventIds);
    if (members.size !== episode.memberEventIds.length) issue("duplicate episode member");
    for (const eventId of members) { if (!sourceIds.has(eventId)) issue("episode member is outside window"); seen.add(eventId); }
    const claims = [episode.objective, episode.summary, episode.grouping.reason, ...episode.decisions, ...episode.blockers, ...episode.checks, ...episode.openQuestions, ...episode.continuations.map(link => link.reason)];
    for (const claim of claims) for (const citation of claim.citations) if (!members.has(citation.eventId)) issue("claim citation is outside episode membership");
  }
  const ungrouped = new Set<string>();
  for (const item of window.ungrouped) {
    if (!sourceIds.has(item.eventId) || seen.has(item.eventId) || ungrouped.has(item.eventId)) issue("invalid ungrouped coverage");
    ungrouped.add(item.eventId);
  }
  if ([...sourceIds].some(eventId => !seen.has(eventId) && !ungrouped.has(eventId))) issue("window source coverage is incomplete");
});
export type EpisodeSource = z.infer<typeof episodeSourceSchema>;
export type EpisodeClaim = z.infer<typeof episodeClaimSchema>;
export type EpisodeCitation = z.infer<typeof episodeCitationSchema>;
export type EpisodePublication = z.infer<typeof episodePublicationSchema>;
export type WorkEpisodeProposal = z.infer<typeof workEpisodeProposalSchema>;
export type EpisodeWindowInput = z.infer<typeof episodeWindowInputSchema>;
export interface EpisodeWindowRecord {
  readonly input: EpisodeWindowInput; readonly inputHash: string;
  readonly revision: string; readonly recordedAt: number; readonly workspaceId: string;
  readonly actorId: string; readonly status: "proposed";
}
export interface WorkEpisodeRevision extends WorkEpisodeProposal {
  readonly revision: string; readonly windowId: string; readonly recordedAt: number;
  readonly projectId: string | null; readonly spaceId?: string; readonly audience: "personal" | "workspace";
  readonly actorId: string; readonly status: "proposed"; readonly sources: readonly EpisodeSource[];
}

export function episodeWindowFromEvent(event: FoldEvent): EpisodeWindowRecord | undefined {
  const reserved = event.id.startsWith("episode-window:") || event.changes.some(change => change.subject.startsWith("urn:fold:episode-window:") || (change.verb === "create" && change.nodeKind === EPISODE_WINDOW_NODE_KIND));
  if (event.kind !== EPISODE_WINDOW_KIND) { if (reserved) throw new TypeError("Reserved episode namespace"); return undefined; }
  const change = event.changes[0];
  if (event.changes.length !== 1 || change?.verb !== "create" || change.nodeKind !== EPISODE_WINDOW_NODE_KIND || change.subject !== `urn:fold:${event.id}` || change.provenance?.basis !== "derived") throw new TypeError("Invalid episode envelope");
  const input = episodeWindowInputSchema.parse(change.after.input);
  const inputHash = hash.parse(change.after.inputHash);
  const actorId = id.parse(change.after.actorId);
  if (change.after.status !== "proposed" || event.id !== `episode-window:${inputHash}` || event.capture.scope.space !== input.spaceId || event.capture.scope.creator !== (input.audience === "personal" ? actorId : undefined)) throw new TypeError("Invalid episode publication");
  return { input, inputHash, revision: event.id, recordedAt: event.at.t, workspaceId: event.capture.scope.workspace, actorId, status: "proposed" };
}

export function makeEpisodeWindowEvent(context: { workspaceId: string; principalId: string; author: FoldEvent["author"] }, input: EpisodeWindowInput, inputHash: string, t: number): FoldEvent {
  const event = parseEvent({ specVersion: "0.7", id: `episode-window:${inputHash}`, kind: EPISODE_WINDOW_KIND,
    title: "Proposed work episodes", at: { t, worldDate: new Date(t).toISOString().slice(0, 10), granularity: "session" },
    author: context.author, capture: { scope: { workspace: context.workspaceId, ...(input.spaceId === undefined ? {} : { space: input.spaceId }), ...(input.audience === "personal" ? { creator: context.principalId } : {}) } },
    changes: [{ verb: "create", subject: `urn:fold:episode-window:${inputHash}`, nodeKind: EPISODE_WINDOW_NODE_KIND,
      after: { input: input as unknown as JsonValue, inputHash, status: "proposed", actorId: context.principalId }, provenance: { basis: "derived", method: { kind: "system", id: input.producer.id } } }],
  });
  episodeWindowFromEvent(event);
  return event;
}

export function rebuildWorkEpisodes(events: readonly FoldEvent[]) {
  const windows = new Map<string, EpisodeWindowRecord>();
  const episodes = new Map<string, WorkEpisodeRevision>();
  const history = new Map<string, WorkEpisodeRevision[]>();
  const pending = events.flatMap(event => { const record = episodeWindowFromEvent(event); return record === undefined ? [] : [record]; });
  // Revision links, rather than source timestamps, order late or replayed windows.
  while (pending.length > 0) {
    const index = pending.findIndex(window => (window.input.contextEpisodes ?? []).every(link => history.get(link.episodeId)?.some(item => item.revision === link.revision)) && window.input.episodes.every(episode => (episodes.get(episode.episodeId)?.revision ?? null) === episode.previousRevision && episode.continuations.every(link => history.get(link.episodeId)?.some(item => item.revision === link.revision))));
    if (index < 0) throw new TypeError("Conflicting or missing episode revision");
    const window = pending.splice(index, 1)[0]!;
    if (windows.has(window.input.windowId)) throw new TypeError("Episode window already exists");
    windows.set(window.input.windowId, window);
    for (const link of window.input.contextEpisodes ?? []) {
      const target = history.get(link.episodeId)?.find(item => item.revision === link.revision);
      if (target === undefined || target.projectId !== window.input.projectId || target.audience !== window.input.audience || target.spaceId !== window.input.spaceId || (target.audience === "personal" && target.actorId !== window.actorId)) throw new TypeError("Episode context is unavailable or incompatible");
    }
    for (const proposal of window.input.episodes) {
      const prior = episodes.get(proposal.episodeId);
      if (prior !== undefined && (prior.projectId !== window.input.projectId || prior.audience !== window.input.audience || prior.spaceId !== window.input.spaceId || (prior.audience === "personal" && prior.actorId !== window.actorId))) throw new TypeError("Episode publication scope is immutable");
      for (const link of proposal.continuations) {
        const target = history.get(link.episodeId)?.find(item => item.revision === link.revision);
        if (target === undefined || target.projectId !== window.input.projectId || target.audience !== window.input.audience || target.spaceId !== window.input.spaceId || (target.audience === "personal" && target.actorId !== window.actorId)) throw new TypeError("Episode continuation target is unavailable or incompatible");
      }
      const value: WorkEpisodeRevision = { ...proposal, revision: window.revision, recordedAt: window.recordedAt, windowId: window.input.windowId, projectId: window.input.projectId,
        ...(window.input.spaceId === undefined ? {} : { spaceId: window.input.spaceId }), audience: window.input.audience, actorId: window.actorId, status: "proposed", sources: window.input.sources.filter(source => proposal.memberEventIds.includes(source.eventId)) };
      episodes.set(proposal.episodeId, value);
      history.set(proposal.episodeId, [...(history.get(proposal.episodeId) ?? []), value]);
    }
  }
  return { windows, episodes, history };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function episodeEvidenceQuality(event: FoldEvent): "memory-derived" | "checkpoint" | "direct-transcript" | "metadata-only" {
  if (["memory.recorded", "memory.revised"].includes(event.kind)) return "memory-derived";
  for (const change of event.changes) if (change.verb === "create") {
    const data = object(change.after.data);
    if (event.kind === "terminal.observation" && ["reasoning_checkpoint", "human_decision"].includes(String(change.after.observation)) && typeof data?.summary === "string" && data.summary.trim().length > 0) return "checkpoint";
    if (event.kind === "terminal.observation" && change.after.observation === "verification_result" && typeof data?.category === "string" && ["success", "failure"].includes(String(data.status))) return "checkpoint";
    const records = object(change.after.chunk)?.records;
    if (event.kind === "transcript.derivation-chunk-recorded" && Array.isArray(records) && records.some(record => {
      const item = object(record); const data = object(item?.data);
      return item !== undefined && ["agent-message", "tool-result", "web-search"].includes(String(item.kind)) && data !== undefined && Object.keys(data).length > 0;
    })) return "direct-transcript";
  }
  return "metadata-only";
}

export function validateEpisodeSourceScope(source: FoldEvent, publication: EpisodePublication, workspaceId: string, actorId: string,
  knownProjectIds: readonly string[], memoryEvents: readonly FoldEvent[], currentMemories?: ReadonlyMap<string, PersonalMemory>): void {
  if (source.capture.scope.workspace !== workspaceId || source.capture.scope.space !== publication.spaceId || source.capture.scope.creator !== (publication.audience === "personal" ? actorId : undefined)) throw new TypeError("Episode source publication scope mismatch");
  const projects = new Set(episodeSourceProjectIds(source, knownProjectIds, memoryEvents, currentMemories));
  if (publication.projectId === null ? projects.size !== 0 : projects.size !== 1 || !projects.has(publication.projectId)) throw new TypeError("Episode source project is unresolved, ambiguous, or different");
}

export function episodeSourceProjectIds(source: FoldEvent, knownProjectIds: readonly string[], contextEvents: readonly FoldEvent[], currentMemories?: ReadonlyMap<string, PersonalMemory>): string[] {
  const projects = new Set<string>();
  const repo = source.capture.identity?.repo;
  if (repo !== undefined && knownProjectIds.includes(repo)) projects.add(repo);
  const related = [source];
  if (["transcript.derivation-chunk-recorded", "transcript.chunk-imported"].includes(source.kind)) {
    const runIds = source.changes.flatMap(change => change.verb === "create" && typeof object(change.after.chunk)?.runId === "string" ? [object(change.after.chunk)!.runId as string] : []);
    related.push(...contextEvents.filter(event => event.kind === "transcript.run-imported" && event.changes.some(change => change.verb === "create" && runIds.includes(String(object(change.after.run)?.id)))));
    if (related.length === 1) throw new TypeError("Transcript episode source run unavailable");
  }
  for (const event of related) for (const change of event.changes) if (change.verb === "create" && event.kind === "transcript.run-imported") {
    const run = object(change.after.run);
    if (typeof run?.projectId === "string") projects.add(run.projectId);
    if (Array.isArray(run?.segments)) for (const segment of run.segments) { const projectId = object(segment)?.projectId; if (typeof projectId === "string") projects.add(projectId); }
  }
  const records = memoryLogRecordsFromEvent(source);
  if (records.length > 0) {
    const current = currentMemories ?? rebuildMemories(contextEvents.filter(event => ["memory.recorded", "memory.revised", "memory.forgotten"].includes(event.kind))).memories;
    for (const record of records) {
      const memoryId = record.recordType === "recorded" ? record.memory.id : record.memoryId;
      const memory = current.get(memoryId);
      if (memory === undefined) throw new TypeError("Episode memory source is forgotten");
      for (const projectId of memory.projectIds) projects.add(projectId);
    }
  }
  if (projects.size > 1 || [...projects].some(projectId => !knownProjectIds.includes(projectId))) throw new TypeError("Episode source contains unverified or ambiguous project identities");
  return [...projects];
}

export function validateEpisodeCitations(input: EpisodeWindowInput, sources: ReadonlyMap<string, FoldEvent>): void {
  const shared = new Set(input.sources.filter(source => input.episodes.filter(episode => episode.memberEventIds.includes(source.eventId)).length > 1).map(source => source.eventId));
  const claimedRecords = new Map<string, Map<string, Set<number>>>();
  for (const episode of input.episodes) {
    for (const eventId of episode.memberEventIds) if (episodeEvidenceQuality(sources.get(eventId)!) === "metadata-only") throw new TypeError("Metadata-only episode evidence must remain ungrouped");
    const claims = [episode.objective, episode.summary, episode.grouping.reason, ...episode.decisions, ...episode.blockers, ...episode.checks, ...episode.openQuestions, ...episode.continuations.map(link => link.reason)];
    for (const eventId of episode.memberEventIds) if (!claims.some(claim => claim.citations.some(citation => citation.eventId === eventId))) throw new TypeError("Every grouped source must support a cited claim or grouping reason");
    for (const claim of claims) for (const citation of claim.citations) {
      if (shared.has(citation.eventId) && (sources.get(citation.eventId)?.kind !== "transcript.derivation-chunk-recorded" || (citation.recordOrdinal === undefined && citation.line === undefined))) throw new TypeError("Shared chunk sources require distinct record-level citations");
      if (citation.recordOrdinal === undefined && citation.line === undefined) continue;
      const source = sources.get(citation.eventId)!;
      const records = source.changes.flatMap(change => change.verb === "create" && Array.isArray(object(change.after.chunk)?.records) ? object(change.after.chunk)!.records as unknown[] : []);
      const index = records.findIndex(record => { const item = object(record); return item !== undefined && (citation.recordOrdinal === undefined || item.ordinal === citation.recordOrdinal) && (citation.line === undefined || item.line === citation.line); });
      if (index < 0) throw new TypeError("Episode citation locator does not exist in its source");
      if (shared.has(citation.eventId)) {
        let memberships = claimedRecords.get(citation.eventId);
        if (memberships === undefined) { memberships = new Map(); claimedRecords.set(citation.eventId, memberships); }
        let records = memberships.get(episode.episodeId);
        if (records === undefined) { records = new Set(); memberships.set(episode.episodeId, records); }
        records.add(index);
      }
    }
  }
  for (const memberships of claimedRecords.values()) for (const [episodeId, records] of memberships) {
    const hasUniqueWitness = [...records].some(record => [...memberships].every(([otherId, otherRecords]) => otherId === episodeId || !otherRecords.has(record)));
    if (!hasUniqueWitness) throw new TypeError("Each episode sharing a chunk requires a distinct supporting record");
  }
}
