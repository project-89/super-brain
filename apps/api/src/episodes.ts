import { z } from "zod";
import { episodeWindowInputSchema } from "@_89/fold-epistemic";
import type { FoldSdk, FoldSdkAccessContext } from "@_89/fold-sdk";
import type { Author } from "@_89/fold";
import { derivationHash } from "@_89/fold-transcript";

export class EpisodeHttpError extends Error { constructor(readonly status: number, readonly code: string, message: string) { super(message); } }

function page<T>(items: readonly T[], url: URL, context: string, key: (item: T) => string, sourcePage = false) {
  const limit = z.coerce.number().int().min(1).max(sourcePage ? 1 : 1000).parse(url.searchParams.get("limit") ?? (sourcePage ? 1 : 100));
  const cursor = url.searchParams.get("pageCursor");
  let start = 0;
  if (cursor !== null) {
    let parsed: { context: string; id: string };
    try { parsed = z.object({ context: z.string(), id: z.string() }).strict().parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))); }
    catch { throw new EpisodeHttpError(400, "invalid_cursor", "Episode cursor is invalid"); }
    if (parsed.context !== context) throw new EpisodeHttpError(409, "episode_cursor_stale", "Episode cursor no longer matches this view");
    const index = items.findIndex(item => key(item) === parsed.id);
    if (index < 0) throw new EpisodeHttpError(409, "episode_cursor_stale", "Episode cursor no longer matches this view");
    start = index + 1;
  }
  const result = items.slice(start, start + limit); const last = result.at(-1);
  return { items: result, total: items.length, coverage: "authorized-current-only", ...(last === undefined || start + result.length >= items.length ? {} : { nextCursor: Buffer.from(JSON.stringify({ context, id: key(last) })).toString("base64url") }) };
}

export async function handleEpisodeRecords(options: { sdk: FoldSdk; access: FoldSdkAccessContext; author: Author; method: string; segments: readonly string[]; url: URL; input?: unknown }) {
  const { sdk, access, method, segments, url } = options;
  const resource = segments[0]; const id = segments[1] === undefined ? undefined : decodeURIComponent(segments[1]);
  const missing = () => { throw new EpisodeHttpError(404, "episode_unavailable", "Episode data is unavailable"); };
  if (method === "POST" && resource === "work-episodes" && id === "windows" && segments.length === 2) {
    return { status: 201, body: await sdk.publishEpisodeWindow({ access, author: options.author }, episodeWindowInputSchema.parse(options.input)) };
  }
  if (method !== "GET" || segments.length > 3) return missing();
  const projects = await sdk.transcriptProjects(access);
  const name = (id: string | null) => projects.find(item => item.project.id === id)?.project.name;
  const episodeMeta = <T extends { projectId: string | null }>(value: T) => ({ ...value, projectName: name(value.projectId), freshness: "current" as const });
  const selectedSources = <T extends { eventId: string }>(sources: readonly T[], revision: string): readonly T[] => {
    const expected = url.searchParams.get("revision");
    if (expected !== null && expected !== revision) throw new EpisodeHttpError(409, "episode_cursor_stale", "Episode revision changed");
    const eventId = url.searchParams.get("eventId");
    if (eventId === null) return sources;
    const source = sources.find(item => item.eventId === eventId); if (source === undefined) return missing();
    return [source];
  };
  const enrich = async (sources: readonly { eventId: string; sha256: string }[], publication: { projectId: string | null; spaceId?: string | undefined; audience: "personal" | "workspace" }) => {
    if (sources.length === 0) return [];
    const verified = await sdk.episodeSources(access, sources.map(source => source.eventId), publication);
    if (derivationHash(verified.sources) !== derivationHash(sources)) throw new EpisodeHttpError(409, "episode_sources_changed", "Episode sources changed while loading evidence");
    return sources.map(source => ({ ...source, event: verified.events.find(event => event.id === source.eventId), quality: verified.evidenceQuality.find(item => item.eventId === source.eventId)?.quality, memory: verified.assembledMemories.find(item => item.eventId === source.eventId)?.memory }));
  };
  if (resource === "work-episode-windows") {
    if (segments.length > 3 || (segments.length === 3 && segments[2] !== "sources")) return missing();
    if (id !== undefined) {
      const window = await sdk.episodeWindow(access, id); if (window === undefined) return missing();
      if (segments[2] === "sources") {
        const result = page(selectedSources(window.input.sources, window.revision), url, `window-sources:${id}:${window.revision}:${url.searchParams.get("eventId") ?? "all"}`, row => row.eventId, true);
        return { status: 200, body: { ...result, items: await enrich(result.items, window.input), revision: window.revision } };
      }
      return { status: 200, body: { ...window, projectName: name(window.input.projectId), freshness: "current" } };
    }
    const projectId = url.searchParams.get("projectId");
    const windows = (await sdk.episodeWindows(access)).filter(window => projectId === null || window.input.projectId === projectId);
    const summaries = windows.map(window => ({ windowId: window.input.windowId, revision: window.revision, projectId: window.input.projectId, projectName: name(window.input.projectId),
      recordedAt: window.recordedAt, sourceCount: window.input.sources.length, episodeCount: window.input.episodes.length, ungroupedCount: window.input.ungrouped.length, producer: window.input.producer, status: "proposed", freshness: "current" }));
    return { status: 200, body: page(summaries, url, `windows:${projectId ?? "all"}`, row => row.revision) };
  }
  if (id === undefined) {
    const projectId = url.searchParams.get("projectId");
    const episodes = (await sdk.workEpisodes(access)).filter(episode => projectId === null || episode.projectId === projectId);
    return { status: 200, body: page(episodes.map(episodeMeta), url, `episodes:${projectId ?? "all"}`, row => `${row.episodeId}:${row.revision}`) };
  }
  const episode = await sdk.workEpisode(access, id); if (episode === undefined) return missing();
  if (segments.length === 2) return { status: 200, body: episodeMeta(episode) };
  const history = await sdk.episodeHistory(access, id);
  if (segments[2] === "history") return { status: 200, body: page([...history].reverse().map(episodeMeta), url, `history:${id}:${episode.revision}`, row => row.revision) };
  if (segments[2] === "sources") {
    const sources = [...new Map(history.flatMap(revision => revision.sources).map(source => [source.eventId, source])).values()];
    const result = page(selectedSources(sources, episode.revision), url, `sources:${id}:${episode.revision}:${url.searchParams.get("eventId") ?? "all"}`, row => row.eventId, true);
    const enriched = [];
    for (let offset = 0; offset < result.items.length; offset += 200) enriched.push(...await enrich(result.items.slice(offset, offset + 200), episode));
    return { status: 200, body: { ...result, items: enriched, revision: episode.revision } };
  }
  return missing();
}
