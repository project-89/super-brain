import { describe, expect, it, vi } from "vitest";
import type { FoldSdk, FoldSdkAccessContext } from "@_89/fold-sdk";
import { EPISODE_MAX_INPUT_BYTES, episodeOutputJsonSchema, handleEpisodeSynthesis } from "../src/episode-synthesis.js";
import { ClaudeReasoner, CodexReasoner, GeminiReasoner, type ReasoningProvider } from "../src/reasoning.js";

const access: FoldSdkAccessContext = { principalId: "person", organizationId: "org", workspaceId: "work", workspaceRole: "member", spaceRoles: {} };
const input = { windowId: "window", parentWindowId: "parent", sourceEventIds: ["source"], projectId: "project", audience: "workspace", trigger: "count" };
const claim = { text: "Reported the check passed", citations: [{ eventId: "source", recordOrdinal: null, line: null }] };
const episode = { episodeId: "window:episode:1", previousRevision: null, title: "Review check result", objective: claim, summary: claim, decisions: [], blockers: [], checks: [claim], openQuestions: [], memberEventIds: ["source"], grouping: { reason: claim, confidence: "low", uncertainties: ["Reported by an agent; not independently verified"] }, continuations: [] };
function fixture(quality = "checkpoint") {
  const prepared = { sources: [{ eventId: "source", sha256: "a".repeat(64) }], events: [{ id: "source", kind: "terminal.observation", changes: [{ verb: "create", after: { observation: "reasoning_checkpoint", data: { summary: "Reported the check passed" } } }] }], evidenceQuality: [{ eventId: "source", quality }], assembledMemories: [] };
  const sources = vi.fn().mockImplementation(async () => structuredClone(prepared));
  const sdk = { episodeSources: sources, workEpisode: vi.fn().mockResolvedValue(undefined) } as unknown as FoldSdk;
  const structured = vi.fn().mockResolvedValue({ episodes: [episode], ungrouped: [] });
  const reasoner: ReasoningProvider = { descriptor: { id: "native:test", kind: "model", model: "test" }, answer: vi.fn(), structured };
  return { sdk, reasoner, structured, prepared, sources, refreshAccess: vi.fn().mockResolvedValue(access) };
}
describe("episode synthesis", () => {
  it("uses event citations, keeps lineage and uncertainty, and reauthorizes after model", async () => {
    const f = fixture();
    const result = await handleEpisodeSynthesis({ ...f, access, input });
    expect(result).toMatchObject({ parentWindowId: "parent", sources: f.prepared.sources, episodes: [{ summary: { citations: [{ eventId: "source" }] } }] });
    expect(f.sources).toHaveBeenCalledTimes(2);
    expect(f.refreshAccess).toHaveBeenCalledOnce();
    expect(f.structured.mock.calls[0]![0].prompt).toContain("untrusted data");
    expect(f.structured.mock.calls[0]![0].prompt).toContain("not independently verified");
    expect(f.structured.mock.calls[0]![0]).toMatchObject({ maxOutputTokens: 16384, timeoutMs: 180000 });
    expect(f.sources.mock.calls[0]![3]).toEqual({ maxBytes: 8000000 });
  });
  it("accounts metadata-only and unresolved-project windows without model calls", async () => {
    for (const projectId of ["project", null]) {
      const f = fixture("metadata-only");
      const result = await handleEpisodeSynthesis({ ...f, access, input: { ...input, projectId } });
      expect(result.episodes).toEqual([]); expect(result.ungrouped).toHaveLength(1);
      expect(result.producer.id).toBe("metadata-coverage-v1"); expect(f.structured).not.toHaveBeenCalled();
    }
  });
  it("fails explicitly without a real structured model and does not use extractive fallback", async () => {
    const f = fixture();
    await expect(handleEpisodeSynthesis({ ...f, reasoner: { ...f.reasoner, descriptor: { id: "local", kind: "extractive" } }, access, input })).rejects.toMatchObject({ status: 503, code: "episode_provider_unavailable" });
  });
  it("rejects omitted, invented, duplicated or invalid-locator evidence", async () => {
    for (const output of [{ episodes: [], ungrouped: [] }, { episodes: [{ ...episode, memberEventIds: ["other"] }], ungrouped: [] }, { episodes: [episode], ungrouped: [{ eventId: "source", reason: "duplicate" }] }, { episodes: [{ ...episode, summary: { ...claim, citations: [{ eventId: "source", line: 999 }] } }], ungrouped: [] }]) {
      const f = fixture(); f.structured.mockResolvedValue(output);
      await expect(handleEpisodeSynthesis({ ...f, access, input })).rejects.toMatchObject({ code: "episode_output_invalid" });
    }
  });
  it("reports safe citation stages without returning model prose or source data", async () => {
    const f = fixture();
    f.structured.mockResolvedValue({ episodes: [{ ...episode, summary: { text: "private invalid model prose", citations: [{ eventId: "source", line: 999 }] } }], ungrouped: [] });
    const error = await handleEpisodeSynthesis({ ...f, access, input }).catch(error => error);
    expect(error.details).toEqual({ stage: "output_validation", check: "citation_constraints", constraint: "locator_not_in_source" });
    expect(JSON.stringify(error)).not.toContain("private invalid");
  });
  it("aligns structured schema bounds with canonical publication constraints and clarifies locator origin", async () => {
    const schema = episodeOutputJsonSchema as any;
    expect(schema.properties.episodes.maxItems).toBe(20);
    const episodeSchema = schema.properties.episodes.items.properties;
    expect(episodeSchema.title.maxLength).toBe(300);
    expect(episodeSchema.summary.properties.text.maxLength).toBe(4000);
    expect(episodeSchema.summary.properties.citations.minItems).toBe(1);
    expect(episodeSchema.decisions.maxItems).toBe(30);
    const f = fixture(); await handleEpisodeSynthesis({ ...f, access, input });
    const prompt = f.structured.mock.calls[0]![0].prompt;
    expect(prompt).toContain("OUTER source.content.changes[].after.chunk.records[].ordinal");
    expect(prompt).toContain("Common background records may additionally be cited");
    expect(prompt).toContain("Every memberEventId must be cited");
  });
  it("never releases generated text after source, assembled memory, or access changes", async () => {
    for (const change of ["source", "memory", "access"]) {
      const f = fixture();
      f.structured.mockImplementation(async () => {
        if (change === "source") f.prepared.sources[0]!.sha256 = "b".repeat(64);
        if (change === "memory") Object.assign(f.prepared.sources[0]!, { memorySnapshot: { memoryId: "m", revision: 2, sha256: "b".repeat(64) } });
        if (change === "access") f.refreshAccess.mockRejectedValue(new Error("Membership revoked"));
        return { episodes: [episode], ungrouped: [] };
      });
      await expect(handleEpisodeSynthesis({ ...f, access, input })).rejects.toThrow(change === "access" ? "Membership revoked" : "changed");
    }
  });
  it("rejects oversized full content before provider, without first-N truncation", async () => {
    const f = fixture(); f.prepared.events[0]!.changes[0]!.after.data.summary = "x".repeat(EPISODE_MAX_INPUT_BYTES);
    await expect(handleEpisodeSynthesis({ ...f, access, input })).rejects.toMatchObject({ status: 413, code: "episode_input_too_large", details: { maxBytes: EPISODE_MAX_INPUT_BYTES } });
    expect(f.structured).not.toHaveBeenCalled();
  });
});

describe("native structured transports", () => {
  it("bounds the episode override while preserving the ordinary memory timeout", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    try {
      const provider = new GeminiReasoner({ apiKey: "test", model: "test", fetch: vi.fn().mockImplementation(async () => Response.json({ candidates: [{ content: { parts: [{ text: '{"answer":"ok","citations":[]}' }] }, finishReason: "STOP" }] })) });
      await provider.structured({ prompt: "x", schemaName: "episode", jsonSchema: {}, timeoutMs: 180000 });
      expect(timeout).toHaveBeenLastCalledWith(180000);
      await provider.answer({ question: "x", evidence: [] }); expect(timeout).toHaveBeenLastCalledWith(60000);
      await expect(provider.structured({ prompt: "x", schemaName: "episode", jsonSchema: {}, timeoutMs: 180001 })).rejects.toThrow("timeout");
    } finally { timeout.mockRestore(); }
  });
  it("includes Claude schema/output budget and rejects token-truncated output", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ stop_reason: "max_tokens", content: [{ type: "text", text: "{}" }] }));
    const provider = new ClaudeReasoner({ apiKey: "test", model: "test", fetch });
    await expect(provider.structured({ prompt: "untrusted evidence", schemaName: "episode", jsonSchema: { type: "object" }, maxOutputTokens: 16384 })).rejects.toThrow("incomplete");
    const body = JSON.parse(fetch.mock.calls[0]![1].body);
    expect(body.max_tokens).toBe(16384); expect(body.messages[0].content).toContain('"type":"object"');
  });
  it("rejects incomplete/refused Codex and blocked Gemini output even when JSON parses", async () => {
    for (const body of [{ status: "incomplete", output_text: "{}" }, { status: "completed", output: [{ content: [{ type: "refusal", text: "{}" }] }] }]) {
      const provider = new CodexReasoner({ apiKey: "test", model: "test", fetch: vi.fn().mockResolvedValue(Response.json(body)) });
      await expect(provider.structured({ prompt: "x", schemaName: "episode", jsonSchema: {} })).rejects.toThrow("incomplete or refused");
    }
    const provider = new GeminiReasoner({ apiKey: "test", model: "test", fetch: vi.fn().mockResolvedValue(Response.json({ candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: "{}" }] } }] })) });
    await expect(provider.structured({ prompt: "x", schemaName: "episode", jsonSchema: {} })).rejects.toThrow("incomplete or blocked");
  });
});
