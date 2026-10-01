export interface EpisodeCitation { eventId: string; recordOrdinal?: number; line?: number }
export interface EpisodeClaim { text: string; citations: EpisodeCitation[] }
export interface EpisodeSource { eventId: string; sha256: string; memorySnapshot?: { memoryId: string; revision: number; sha256: string } }
export interface Episode {
  episodeId: string; previousRevision: string | null; revision: string; windowId: string; recordedAt: number;
  projectId: string | null; projectName?: string; audience: "personal" | "workspace"; spaceId?: string;
  title: string; objective: EpisodeClaim; summary: EpisodeClaim; decisions: EpisodeClaim[]; blockers: EpisodeClaim[];
  checks: EpisodeClaim[]; openQuestions: EpisodeClaim[]; memberEventIds: string[]; sources: EpisodeSource[];
  grouping: { reason: EpisodeClaim; confidence: "low" | "medium" | "high"; uncertainties: string[] };
  continuations: { episodeId: string; revision: string; reason: EpisodeClaim }[];
  freshness: "current"; status: "proposed";
}
export interface EpisodeWindowSummary {
  windowId: string; revision: string; projectId: string | null; projectName?: string; recordedAt: number;
  sourceCount: number; episodeCount: number; ungroupedCount: number; freshness: "current";
  producer: { id: string; version: string; model?: string };
}
export interface EpisodeWindow {
  revision: string; recordedAt: number; projectName?: string; freshness: "current";
  input: { windowId: string; parentWindowId?: string; projectId: string | null; audience: "personal" | "workspace"; trigger: string;
    sources: EpisodeSource[]; episodes: Episode[]; ungrouped: { eventId: string; reason: string }[];
    producer: EpisodeWindowSummary["producer"]; contextEpisodes?: { episodeId: string; revision: string }[] };
}
export interface EpisodeSourceRecord extends EpisodeSource {
  quality: "memory-derived" | "checkpoint" | "direct-transcript" | "metadata-only";
  event: unknown; memory?: unknown;
}
export interface EpisodePage<T> { items: T[]; total: number; nextCursor?: string; revision?: string; coverage: "authorized-current-only" }
