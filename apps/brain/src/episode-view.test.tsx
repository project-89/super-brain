import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EpisodeEvidence } from "./components/EpisodeEvidence";
import { decodeEpisodeEvidence, evidenceLabel, focusCitation, mergeEpisodePages, recordMatchesCitation, sourceRecords } from "./episode-view";

describe("episode evidence presentation", () => {
  it("decodes full retained data and preserves citation ordinal and line", () => {
    const text = "Full conversation text ".repeat(1000);
    const decoded = decodeEpisodeEvidence({ changes: [{ after: { chunk: { records: [{ ordinal: 25, line: 40, kind: "agent-message", dataEncoding: "base64-json-utf8", data: { base64: btoa(JSON.stringify({ text })) } }] } } }] });
    const records = sourceRecords(decoded);
    expect(records[0]!.data).toEqual({ text });
    const citation = focusCitation({ eventId: "event", recordOrdinal: 25, line: 40 });
    expect(citation).toEqual({ eventId: "event", recordOrdinal: 25, line: 40 });
    expect(recordMatchesCitation(records[0]!, citation)).toBe(true);
    expect(recordMatchesCitation(records[0]!, { eventId: "event", line: 41 })).toBe(false);
  });
  it("shows readable memory content and exact highlighted transcript evidence, raw JSON secondary", () => {
    const memory = renderToStaticMarkup(<EpisodeEvidence source={{ eventId: "event", sha256: "a", quality: "memory-derived", memorySnapshot: { memoryId: "memory-one", revision: 3, sha256: "b" }, memory: { summary: "Fixed stale source handling", content: { lesson: "Recheck source authorization after model work" } }, event: {} }} citation={undefined} />);
    expect(memory).toContain("Fixed stale source handling"); expect(memory).toContain("Recheck source authorization after model work"); expect(memory).toContain("memory-one"); expect(memory).toContain("correlated evidence");
    const transcript = renderToStaticMarkup(<EpisodeEvidence source={{ eventId: "event", sha256: "a", quality: "direct-transcript", event: { changes: [{ after: { chunk: { records: [{ ordinal: 7, line: 19, kind: "agent-message", data: { text: "Run the scoped regression" } }] } } }] } }} citation={{ eventId: "event", recordOrdinal: 7, line: 19 }} />);
    expect(transcript).toContain("Run the scoped regression"); expect(transcript).toContain("retained line 19"); expect(transcript).toContain('episode-transcript-record is-focused'); expect(transcript).toContain('open=""');
  });
  it("keeps metadata-only windows honest and rejects mixed source revisions", () => {
    expect(evidenceLabel("metadata-only")).toContain("insufficient");
    const page = { items: [{ id: "one" }], total: 2, coverage: "authorized-current-only" as const, revision: "old" };
    expect(() => mergeEpisodePages(page, { ...page, revision: "new" }, item => item.id)).toThrow("changed");
    expect(mergeEpisodePages(page, { ...page, items: [{ id: "one" }, { id: "two" }] }, item => item.id).items).toHaveLength(2);
  });
});
