import { describe, expect, it } from "vitest";

import {
  authorizeRecall,
  recallMemories,
  recallMemoryById,
  type EpistemicAccessContext,
} from "../src/index.js";
import { MEMORY_A, MEMORY_B, MEMORY_C, MEMORY_D, memory, projection } from "./helpers.js";

function access(
  overrides: Partial<EpistemicAccessContext> = {},
): EpistemicAccessContext {
  return {
    principalId: "user-a",
    workspaceId: "workspace-1",
    workspaceRole: "member",
    spaceRoles: { "space-a": "reader" },
    ...overrides,
  };
}

describe("recall-time access enforcement", () => {
  it("returns only the principal's workspace and currently accessible spaces", () => {
    const memories = projection([
      memory({ id: MEMORY_A, createdAt: 100 }),
      memory({ id: MEMORY_B, spaceId: "space-a", createdAt: 300 }),
      memory({ id: MEMORY_C, spaceId: "space-removed", createdAt: 400 }),
      memory({ id: MEMORY_D, workspaceId: "workspace-2", createdAt: 500 }),
    ]);

    expect(recallMemories(memories, access()).map((item) => item.memory.id)).toEqual([
      MEMORY_B,
      MEMORY_A,
    ]);
  });

  it("keeps personal memories private even from workspace administrators", () => {
    const other = memory({ id: MEMORY_A, creatorId: "user-b" });
    expect(authorizeRecall(other, access({ workspaceRole: "owner" }))).toEqual({
      allowed: false,
      reason: "creator-mismatch",
    });
    expect(recallMemories(projection([other]), access({ workspaceRole: "admin" }))).toEqual([]);
  });

  it("distinguishes workspace-only and exact-space scopes", () => {
    const memories = projection([
      memory({ id: MEMORY_A, createdAt: 100 }),
      memory({ id: MEMORY_B, spaceId: "space-a", createdAt: 200 }),
    ]);
    expect(
      recallMemories(memories, access(), { scope: { kind: "workspace" } }).map(
        (item) => item.memory.id,
      ),
    ).toEqual([MEMORY_A]);
    expect(
      recallMemories(memories, access(), { scope: { kind: "space", spaceId: "space-a" } }).map(
        (item) => item.memory.id,
      ),
    ).toEqual([MEMORY_B]);
    expect(
      recallMemories(memories, access(), { scope: { kind: "space", spaceId: "space-removed" } }),
    ).toEqual([]);
  });

  it("reapplies ownership after externally ranked semantic candidates", () => {
    const own = memory({ id: MEMORY_A, creatorId: "user-a", createdAt: 100 });
    const other = memory({ id: MEMORY_B, creatorId: "user-b", createdAt: 200 });
    const result = recallMemories(projection([own, other]), access(), {
      candidates: [
        { memoryId: other.id, score: 0.99 },
        { memoryId: own.id, score: 0.4 },
      ],
    });

    expect(result).toEqual([{ memory: own, score: 0.4 }]);
  });

  it("filters workspace and removed-space candidates after ranking", () => {
    const own = memory({ id: MEMORY_A, createdAt: 100 });
    const removed = memory({ id: MEMORY_B, spaceId: "space-removed", createdAt: 300 });
    const otherWorkspace = memory({ id: MEMORY_C, workspaceId: "workspace-2", createdAt: 400 });
    const result = recallMemories(projection([own, removed, otherWorkspace]), access(), {
      candidates: [
        { memoryId: removed.id, score: 1 },
        { memoryId: otherWorkspace.id, score: 0.9 },
        { memoryId: own.id, score: 0.2 },
        { memoryId: own.id, score: 0.7 },
      ],
    });
    expect(result).toEqual([{ memory: own, score: 0.7 }]);
  });

  it("uses all requested tags plus source, time, and limit filters", () => {
    const memories = projection([
      memory({
        id: MEMORY_A,
        tags: ["decision", "person"],
        source: "conversation",
        createdAt: 100,
      }),
      memory({ id: MEMORY_B, tags: ["decision"], source: "conversation", createdAt: 200 }),
      memory({ id: MEMORY_C, tags: ["decision", "person"], source: "tool", createdAt: 300 }),
      memory({
        id: MEMORY_D,
        tags: ["decision", "person"],
        source: "conversation",
        createdAt: 400,
      }),
    ]);
    const result = recallMemories(memories, access(), {
      tags: ["person", "decision"],
      sources: ["conversation"],
      from: 50,
      to: 450,
      limit: 1,
    });
    expect(result.map((item) => item.memory.id)).toEqual([MEMORY_D]);
  });

  it("orders equal semantic scores by newest memory then UUID", () => {
    const older = memory({ id: MEMORY_A, createdAt: 100 });
    const newer = memory({ id: MEMORY_B, createdAt: 200 });
    const result = recallMemories(projection([older, newer]), access(), {
      candidates: [
        { memoryId: older.id, score: 0.5 },
        { memoryId: newer.id, score: 0.5 },
      ],
    });
    expect(result.map((item) => item.memory.id)).toEqual([MEMORY_B, MEMORY_A]);
  });

  it("rejects malformed recall requests before evaluating access", () => {
    const memories = projection([memory()]);
    expect(() => recallMemories(memories, access(), { limit: 0 })).toThrow(/limit/);
    expect(() => recallMemories(memories, access(), { from: 2, to: 1 })).toThrow(/exceed/);
    expect(() => recallMemories(memories, access(), { sources: [" "] })).toThrow(/sources/);
    expect(() =>
      recallMemories(memories, access(), {
        scope: { kind: "space", spaceId: "space-removed" },
        candidates: [{ memoryId: "bad-id", score: 0.5 }],
      }),
    ).toThrow(/UUIDv7/);
    expect(() =>
      recallMemories(memories, access(), { candidates: [{ memoryId: MEMORY_A, score: 2 }] }),
    ).toThrow(/score/);
  });

  it("enforces access on direct lookup and cannot return forgotten state", () => {
    const own = memory({ id: MEMORY_A });
    const memories = projection([own]);
    expect(recallMemoryById(memories, access(), MEMORY_A)).toEqual(own);
    expect(recallMemoryById(memories, access({ principalId: "user-b" }), MEMORY_A)).toBeUndefined();
    expect(recallMemoryById(projection([]), access(), MEMORY_A)).toBeUndefined();
    expect(() =>
      recallMemoryById(projection([]), access({ workspaceRole: "invalid" as never }), MEMORY_A),
    ).toThrow(/unsupported workspace role/);
  });
});
