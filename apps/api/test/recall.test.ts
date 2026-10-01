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
    revision: 0,
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
    revision: 0,
  },
] as const;

describe("local lexical memory ranker", () => {
  it("returns bounded normalized matches in relevance order", async () => {
    const ranker = new LocalLexicalMemoryRanker();
    const ranked = await ranker.rank({ workspaceId: "workspace-1", query: "expired access token", documents, limit: 5 });
    expect(ranked).toEqual([{ memoryId: "memory-refresh", score: 1 }]);
    expect(ranker.descriptor).toEqual({ id: "local-bm25-v2", kind: "lexical" });
  });

  it("returns no candidates for a query without matching terms", async () => {
    const ranker = new LocalLexicalMemoryRanker();
    expect(await ranker.rank({ workspaceId: "workspace-1", query: "trajectory", documents, limit: 5 })).toEqual([]);
  });

  it("does not retrieve unrelated memories merely because they contain question words", async () => {
    const ranker = new LocalLexicalMemoryRanker();
    const corpus = [
      { ...documents[0], memoryId: "storage", summary: "Postgres storage", content: { detail: "Durable event log" } },
      { ...documents[0], memoryId: "unrelated", summary: "What we know about agents", content: { detail: "What do we know about their goals?" } },
    ];
    expect(await ranker.rank({ workspaceId: "workspace-1", query: "What do we know about Postgres storage?", documents: corpus, limit: 5 }))
      .toEqual([{ memoryId: "storage", score: 1 }]);
    expect(await ranker.rank({ workspaceId: "workspace-1", query: "What do we know?", documents: corpus, limit: 5 })).toEqual([]);
  });
});
