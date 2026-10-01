import { describe, expect, it } from "vitest";
import { parseEvent } from "@_89/fold";
import { episodeWindowInputSchema, validateEpisodeCitations, type EpisodeWindowInput } from "../src/index.js";

describe("work episode source-event coverage", () => {
  it("permits separate tasks in one chunk only with distinct valid record citations", () => {
    const source = parseEvent({ specVersion: "0.7", id: "chunk", kind: "transcript.derivation-chunk-recorded", title: "Evidence", at: { t: 1, worldDate: "2026-09-15", granularity: "session" }, author: { kind: "ingest", id: "import" }, capture: { scope: { workspace: "workspace" } }, changes: [{ verb: "create", subject: "urn:fold:chunk", nodeKind: "x.fold.transcript-derivation-chunk", after: { chunk: { records: [{ ordinal: 0, line: 10, kind: "agent-message", data: { text: "Fix login" } }, { ordinal: 1, line: 11, kind: "agent-message", data: { text: "Update report" } }] } } }] });
    const episodes = [0, 1].map(index => {
      const claim = { text: index === 0 ? "Fix login" : "Update report", citations: [{ eventId: "chunk", recordOrdinal: index, line: index + 10 }] };
      return { episodeId: `task-${index}`, previousRevision: null, title: claim.text, objective: claim, summary: claim, decisions: [], blockers: [], checks: [], openQuestions: [], memberEventIds: ["chunk"], grouping: { reason: claim, confidence: "medium" as const, uncertainties: [] }, continuations: [] };
    });
    const input: EpisodeWindowInput = { schemaVersion: 1, windowId: "window", projectId: "project", audience: "workspace", sources: [{ eventId: "chunk", sha256: "a".repeat(64) }], trigger: "count", producer: { id: "model", version: "1" }, episodes, ungrouped: [] };
    expect(episodeWindowInputSchema.parse(input).episodes).toHaveLength(2);
    expect(() => validateEpisodeCitations(input, new Map([[source.id, source]]))).not.toThrow();
    expect(() => validateEpisodeCitations({ ...input, episodes: [episodes[0]!, { ...episodes[1]!, summary: episodes[0]!.summary }] }, new Map([[source.id, source]]))).toThrow(/distinct supporting record/);
    const backgroundSource = parseEvent({ ...source, changes: [{ verb: "create", subject: "urn:fold:chunk", nodeKind: "x.fold.transcript-derivation-chunk", after: { chunk: { records: [{ ordinal: 0, line: 10, kind: "agent-message", data: { text: "Fix login" } }, { ordinal: 1, line: 11, kind: "agent-message", data: { text: "Update report" } }, { ordinal: 2, line: 12, kind: "agent-message", data: { text: "Shared project context" } }] } } }] });
    const commonBackground = episodes.map(episode => ({ ...episode, summary: { ...episode.summary, citations: [...episode.summary.citations, { eventId: "chunk", recordOrdinal: 2, line: 12 }] } }));
    expect(() => validateEpisodeCitations({ ...input, episodes: commonBackground }, new Map([[source.id, backgroundSource]]))).not.toThrow();
    const identicalSupport = episodes.map(episode => ({ ...episode, summary: { ...episode.summary, citations: [{ eventId: "chunk", recordOrdinal: 0, line: 10 }, { eventId: "chunk", recordOrdinal: 1, line: 11 }] } }));
    expect(() => validateEpisodeCitations({ ...input, episodes: identicalSupport }, new Map([[source.id, source]]))).toThrow(/distinct supporting record/);
    expect(() => validateEpisodeCitations({ ...input, episodes: [episodes[0]!, { ...episodes[1]!, summary: { text: "No locator", citations: [{ eventId: "chunk" }] } }] }, new Map([[source.id, source]]))).toThrow(/record-level/);
    const otherSource = { ...source, id: "other-chunk" };
    const uncitedMember = { ...episodes[0]!, memberEventIds: ["chunk", "other-chunk"], objective: { ...episodes[0]!.objective, citations: [{ eventId: "other-chunk", recordOrdinal: 0 }] }, summary: { ...episodes[0]!.summary, citations: [{ eventId: "other-chunk", recordOrdinal: 0 }] }, grouping: { ...episodes[0]!.grouping, reason: { ...episodes[0]!.grouping.reason, citations: [{ eventId: "other-chunk", recordOrdinal: 0 }] } } };
    expect(() => validateEpisodeCitations({ ...input, sources: [...input.sources, { eventId: "other-chunk", sha256: "b".repeat(64) }], episodes: [uncitedMember, episodes[1]!] }, new Map([[source.id, source], [otherSource.id, otherSource]]))).toThrow(/Every grouped source/);
    expect(() => episodeWindowInputSchema.parse({ ...input, ungrouped: [{ eventId: "chunk", reason: "Already grouped" }] })).toThrow(/coverage/);
  });
});
