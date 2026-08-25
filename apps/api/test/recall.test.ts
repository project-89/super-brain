import { describe, expect, it } from "vitest";

import { LocalLexicalMemoryRanker } from "../src/index.js";

const documents = [
  {
    memoryId: "memory-refresh",
    source: "conversation",
    summary: "Refresh expired credentials",
    content: { resolution: "Rotate the access token before retrying" },
    tags: ["authentication"],
    entities: [],
    createdAt: 100,
    updatedAt: 100,
  },
  {
    memoryId: "memory-layout",
    source: "operator-note",
    summary: "Compact layout review",
    content: { resolution: "Keep table columns visible" },
    tags: ["ui"],
    entities: [],
    createdAt: 101,
    updatedAt: 101,
  },
] as const;

describe("local lexical memory ranker", () => {
  it("returns bounded normalized matches in relevance order", async () => {
    const ranker = new LocalLexicalMemoryRanker();
    const ranked = await ranker.rank({ query: "expired access token", documents, limit: 5 });
    expect(ranked).toEqual([{ memoryId: "memory-refresh", score: 1 }]);
    expect(ranker.descriptor).toEqual({ id: "local-bm25-v1", kind: "lexical" });
  });

  it("returns no candidates for a query without matching terms", async () => {
    const ranker = new LocalLexicalMemoryRanker();
    expect(await ranker.rank({ query: "trajectory", documents, limit: 5 })).toEqual([]);
  });
});
