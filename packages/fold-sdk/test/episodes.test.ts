import { describe, expect, it } from "vitest";
import { vi } from "vitest";
import { episodeWindowInputSchema, rebuildWorkEpisodes, type EpisodeWindowInput } from "@_89/fold-epistemic";
import { makeTranscriptProjectEvent } from "@_89/fold-transcript";
import { FoldSdk } from "../src/index.js";
import { EpisodeService } from "../src/episodes.js";
import { access, event, MEMORY_A, MEMORY_B, MemoryStore, memoryContext, stamp } from "./helpers.js";

async function fixture() {
  const store = new MemoryStore(); const sdk = new FoldSdk(store); const acl = access();
  await sdk.append(acl, makeTranscriptProjectEvent({ author: { kind: "ingest", id: "import" }, capture: { scope: { workspace: acl.workspaceId }, identity: { source: "codex" } } }, stamp("project", 1), { id: "project-a", name: "Project A", identityKeyHash: "a".repeat(64), resolution: "resolved", roots: ["/project-a"] }));
  for (const [index, id] of [MEMORY_A, MEMORY_B].entries()) await sdk.recordMemory(memoryContext({ audience: "workspace" }), stamp(`source-${index}`, index + 2), { id, audience: "workspace", source: "test", projectIds: ["project-a"], summary: `Observed check ${index}`, content: { result: "pass" } });
  const publication = { projectId: "project-a", audience: "workspace" as const };
  const prepared = await sdk.episodeSources(acl, ["source-0", "source-1"], publication);
  const claim = { text: "Check validated the implementation", citations: [{ eventId: "source-0" }] };
  const input: EpisodeWindowInput = { schemaVersion: 1, windowId: "window-1", ...publication, sources: prepared.sources, trigger: "count", producer: { id: "test-model", version: "1", model: "fixture" },
    episodes: [{ episodeId: "episode-1", previousRevision: null, title: "Validate implementation", objective: claim, summary: claim, decisions: [], blockers: [], checks: [claim], openQuestions: [], memberEventIds: ["source-0"], grouping: { reason: claim, confidence: "medium", uncertainties: ["Task completion not confirmed"] }, continuations: [] }],
    ungrouped: [{ eventId: "source-1", reason: "Unrelated check" }] };
  return { sdk, store, acl, input, context: { access: acl, author: { kind: "agent" as const, id: "worker-author-not-principal" } } };
}

describe("cited proposed work episodes", () => {
  it("stops assembling sources at the byte budget before looking up another event", async () => {
    const lookup = vi.fn(async (id: string) => ({ event: event({ id, t: 1 }), status: "canon" as const }));
    const service = new EpisodeService(async () => [], lookup, async () => undefined, access());
    await expect(service.sources(["first", "second"], { projectId: null, audience: "workspace" }, { maxBytes: 10 })).rejects.toThrow(/byte budget/);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("rejects hidden personal logical ID collisions without corrupting either scope", async () => {
    const { sdk, acl, input, context } = await fixture();
    for (const [index, owner] of ["user-a", "user-b"].entries()) await sdk.recordMemory(memoryContext({ principalId: owner }), stamp(`personal-${owner}`, 10 + index), { id: `01890f47-7c02-7000-8000-00000000000${index + 3}`, source: "test", projectIds: ["project-a"], summary: "Private work" });
    const privateInput = async (owner: string, windowId: string) => {
      const publication = { projectId: "project-a", audience: "personal" as const };
      const prepared = await sdk.episodeSources(access({ principalId: owner }), [`personal-${owner}`], publication);
      const claim = { text: "Private work", citations: [{ eventId: `personal-${owner}` }] };
      return { ...input, ...publication, windowId, sources: prepared.sources, ungrouped: [], episodes: [{ ...input.episodes[0]!, summary: claim, objective: claim, checks: [], memberEventIds: [`personal-${owner}`], grouping: { reason: claim, confidence: "low" as const, uncertainties: [] } }] };
    };
    await sdk.publishEpisodeWindow(context, await privateInput("user-a", "private-window"));
    const other = { ...context, access: access({ principalId: "user-b" }) };
    await expect(sdk.publishEpisodeWindow(other, await privateInput("user-b", "other-private-window"))).rejects.toThrow(/identity conflicts/);
    await expect(sdk.publishEpisodeWindow(other, { ...input, windowId: "public-window" })).rejects.toThrow(/identity conflicts/);
    await expect(sdk.publishEpisodeWindow(other, { ...input, windowId: "private-window", episodes: [{ ...input.episodes[0]!, episodeId: "different-episode" }] })).rejects.toThrow(/identity conflicts/);
    expect(await sdk.workEpisodes(acl)).toHaveLength(1);
    expect(await sdk.workEpisodes(other.access)).toHaveLength(0);
  });
  it("keeps personal episodes private when the agent author differs from the owning principal", async () => {
    const { sdk, acl, input, context } = await fixture();
    await sdk.recordMemory(memoryContext(), stamp("personal-source", 10), { id: "01890f47-7c02-7000-8000-000000000003", source: "test", projectIds: ["project-a"], summary: "Private task" });
    const publication = { projectId: "project-a", audience: "personal" as const };
    const prepared = await sdk.episodeSources(acl, ["personal-source"], publication);
    const claim = { text: "Private task", citations: [{ eventId: "personal-source" }] };
    const result = await sdk.publishEpisodeWindow(context, { ...input, ...publication, sources: prepared.sources, ungrouped: [], episodes: [{ ...input.episodes[0]!, objective: claim, summary: claim, checks: [], memberEventIds: ["personal-source"], grouping: { reason: claim, confidence: "low", uncertainties: [] } }] });
    expect(result.actorId).toBe(acl.principalId);
    expect(await sdk.workEpisode(acl, "episode-1")).toBeDefined();
    expect(await sdk.workEpisode(access({ principalId: "user-b" }), "episode-1")).toBeUndefined();
  });
  it("uses one current semantic snapshot for historical recorded and revised memory anchors", async () => {
    const { sdk, acl, input, context } = await fixture();
    await sdk.reviseMemory(memoryContext({ audience: "workspace" }), stamp("revised-source", 20), MEMORY_A, { summary: "Corrected check" });
    const prepared = await sdk.episodeSources(acl, ["source-0", "revised-source"], input);
    expect(prepared.sources[0]!.memorySnapshot).toEqual(prepared.sources[1]!.memorySnapshot);
    expect(prepared.assembledMemories.map(item => item.memory.summary)).toEqual(["Corrected check", "Corrected check"]);
    const record = await sdk.publishEpisodeWindow(context, { ...input, sources: prepared.sources, ungrouped: [{ eventId: "revised-source", reason: "Correlated source from same memory" }] });
    expect(record.input.sources).toHaveLength(2);
    await sdk.reviseMemory(memoryContext({ audience: "workspace" }), stamp("later-revision", Date.now() + 1000), MEMORY_A, { summary: "Later correction" });
    expect(await sdk.workEpisode(acl, "episode-1")).toBeUndefined();
  });

  it("replays continuations topologically and retains their historical dependencies", async () => {
    const { sdk, store, acl, input, context } = await fixture();
    const first = await sdk.publishEpisodeWindow(context, input);
    const next = { ...input, windowId: "continuation-window", episodes: [{ ...input.episodes[0]!, episodeId: "continuation", continuations: [{ episodeId: "episode-1", revision: first.revision, reason: input.episodes[0]!.grouping.reason }] }] };
    const second = await sdk.publishEpisodeWindow(context, next);
    expect(rebuildWorkEpisodes([...store.entries].reverse().map(entry => entry.event)).episodes.get("continuation")?.revision).toBe(second.revision);
    await expect(sdk.publishEpisodeWindow(context, { ...next, windowId: "missing-context", episodes: [], ungrouped: input.sources.map(source => ({ eventId: source.eventId, reason: "No task" })), contextEpisodes: [{ episodeId: "absent", revision: "missing" }] })).rejects.toThrow(/context/);
    expect(await sdk.workEpisodes(acl)).toHaveLength(2);
  });

  it("publishes atomic coverage, retries exactly, and keeps separate principal attribution", async () => {
    const { sdk, store, acl, input, context } = await fixture();
    expect(input.sources[0]?.memorySnapshot).toMatchObject({ memoryId: MEMORY_A, revision: 0 });
    const published = await sdk.publishEpisodeWindow(context, input);
    expect(published.actorId).toBe(acl.principalId);
    expect(await sdk.publishEpisodeWindow(context, input)).toEqual(published);
    expect(store.entries.filter(entry => entry.event.kind.startsWith("work."))).toHaveLength(1);
    expect(await sdk.workEpisode(acl, "episode-1")).toMatchObject({ status: "proposed", sources: [input.sources[0]], revision: published.revision });
    await expect(sdk.publishEpisodeWindow(context, { ...input, ungrouped: [{ eventId: "source-1", reason: "Changed output" }] })).rejects.toThrow(/retry changed/);
    await expect(sdk.append(acl, store.entries.at(-1)!.event)).rejects.toThrow(/publication API/);
    await expect(sdk.append(acl, event({ id: "episode-window:poison", t: 5 }))).rejects.toThrow(/Reserved/);
  });

  it("rejects omitted/duplicate/foreign citations and metadata-only inference", async () => {
    const { sdk, acl, input, context } = await fixture();
    expect(() => episodeWindowInputSchema.parse({ ...input, ungrouped: [] })).toThrow(/coverage/);
    await expect(sdk.publishEpisodeWindow(context, { ...input, episodes: [...input.episodes, { ...input.episodes[0]!, episodeId: "duplicate" }] })).rejects.toThrow(/distinct record-level/);
    expect(() => episodeWindowInputSchema.parse({ ...input, episodes: [{ ...input.episodes[0], summary: { text: "Invented", citations: [{ eventId: "source-1" }] } }] })).toThrow(/outside episode/);
    await sdk.append(acl, event({ id: "metadata", t: 10 }));
    const prepared = await sdk.episodeSources(acl, ["metadata"], { projectId: null, audience: "workspace" });
    const metadata = { ...input, windowId: "metadata-window", projectId: null, sources: prepared.sources, episodes: [], ungrouped: [{ eventId: "metadata", reason: "insufficient_content" }] };
    expect((await sdk.publishEpisodeWindow(context, metadata)).input.episodes).toEqual([]);
    await expect(sdk.episodeSources(acl, ["metadata"], { projectId: "project-a", audience: "workspace" })).rejects.toThrow(/unresolved/);
  });

  it("enforces revisions and invalidates old/current summaries after a retained source changes", async () => {
    const { sdk, store, acl, input, context } = await fixture();
    const first = await sdk.publishEpisodeWindow(context, input);
    const revision = { ...input, windowId: "window-2", episodes: [{ ...input.episodes[0]!, previousRevision: first.revision }] };
    const second = await sdk.publishEpisodeWindow({ ...context, access: access({ principalId: "second-worker" }) }, revision);
    expect(second.revision).not.toBe(first.revision);
    expect(rebuildWorkEpisodes([...store.entries].reverse().map(entry => entry.event)).episodes.get("episode-1")?.revision).toBe(second.revision);
    await expect(sdk.publishEpisodeWindow(context, { ...revision, windowId: "stale" })).rejects.toThrow(/revision changed/);
    await sdk.reviseMemory(memoryContext({ audience: "workspace" }), stamp("memory-correction", Date.now() + 1000), MEMORY_A, { summary: "Earlier check was wrong" });
    expect(await sdk.workEpisode(acl, "episode-1")).toBeUndefined();
    expect(await sdk.episodeWindow(acl, "window-1")).toBeUndefined();
    // An identical publication is an idempotent retry of the recorded command and returns its receipt;
    // a new publication revalidates its retained sources.
    await expect(sdk.publishEpisodeWindow(context, input)).resolves.toEqual(first);
    await expect(sdk.publishEpisodeWindow(context, { ...input, windowId: "window-3" })).rejects.toThrow(/unavailable|changed/);
  });

  it("fails closed across workspace, creator, spaces, stale source hashes and unsupported locators", async () => {
    const { sdk, acl, input, context } = await fixture();
    await expect(sdk.episodeSources(access({ workspaceId: "foreign" }), ["source-0"], input)).rejects.toThrow(/unavailable/);
    await expect(sdk.episodeSources(acl, ["source-0"], { ...input, audience: "personal" })).rejects.toThrow(/scope/);
    await expect(sdk.publishEpisodeWindow(context, { ...input, sources: [{ ...input.sources[0]!, sha256: "f".repeat(64) }, input.sources[1]!] })).rejects.toThrow(/changed/);
    await expect(sdk.publishEpisodeWindow(context, { ...input, episodes: [{ ...input.episodes[0]!, summary: { text: "Wrong record", citations: [{ eventId: "source-0", recordOrdinal: 9 }] } }] })).rejects.toThrow(/locator/);
    await expect(sdk.publishEpisodeWindow({ ...context, access: { ...acl, spaceRoles: { secret: "reader" } } }, { ...input, spaceId: "secret" })).rejects.toThrow(/write access/);
  });
});
