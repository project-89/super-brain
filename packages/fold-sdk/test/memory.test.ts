import { describe, expect, it } from "vitest";

import { FoldSdk, PersonalMemoryUnavailableError } from "../src/index.js";
import {
  MEMORY_A,
  MEMORY_B,
  access,
  memoryContext,
  MemoryStore,
  stamp,
} from "./helpers.js";

describe("SDK personal memory API", () => {
  it("records, revises, reopens, and forgets personal memory", async () => {
    const store = new MemoryStore();
    const sdk = new FoldSdk(store);
    const created = await sdk.recordMemory(memoryContext(), stamp("event-a", 100), {
      id: MEMORY_A,
      source: "conversation",
      content: { decision: "ship" },
      tags: ["decision"],
    });
    expect(created.memory).toMatchObject({ creatorId: "user-a", revision: 0 });
    expect((await sdk.recallMemories(access()))[0]?.memory.id).toBe(MEMORY_A);

    const revised = await sdk.reviseMemory(
      memoryContext(),
      stamp("event-b", 110),
      MEMORY_A,
      { summary: "Ship after review", tags: ["reviewed", "decision"] },
    );
    expect(revised.memory).toMatchObject({
      summary: "Ship after review",
      tags: ["decision", "reviewed"],
      revision: 1,
      updatedAt: 110,
    });

    const reopened = new FoldSdk(store);
    expect(await reopened.memoryById(access(), MEMORY_A)).toEqual(revised.memory);
    const removed = await reopened.forgetMemory(
      memoryContext(),
      stamp("event-c", 120),
      MEMORY_A,
      "user request",
    );
    expect(removed.forgotten).toMatchObject({ memoryId: MEMORY_A, reason: "user request" });
    expect(await reopened.memoryById(access(), MEMORY_A)).toBeUndefined();
    await expect(
      reopened.reviseMemory(memoryContext(), stamp("event-d", 130), MEMORY_A, {
        summary: "Too late",
      }),
    ).rejects.toBeInstanceOf(PersonalMemoryUnavailableError);
  });

  it("does not expose another creator's memory through raw or memory reads", async () => {
    const sdk = new FoldSdk(new MemoryStore());
    await sdk.recordMemory(memoryContext(), stamp("event-a", 100), {
      id: MEMORY_A,
      source: "conversation",
    });
    const other = access({ principalId: "user-b", workspaceRole: "owner" });
    expect(await sdk.listEntries(other)).toEqual([]);
    expect(await sdk.memoryById(other, MEMORY_A)).toBeUndefined();
    await expect(
      sdk.reviseMemory(memoryContext({ principalId: "user-b" }), stamp("event-b", 110), MEMORY_A, {
        summary: "Mine",
      }),
    ).rejects.toBeInstanceOf(PersonalMemoryUnavailableError);
  });

  it("applies current space membership to raw events and recall", async () => {
    const sdk = new FoldSdk(new MemoryStore());
    await sdk.recordMemory(
      memoryContext({ spaceId: "space-a" }),
      stamp("event-a", 100),
      { id: MEMORY_A, spaceId: "space-a", source: "conversation" },
    );
    const revoked = access();
    expect(await sdk.listEntries(revoked)).toEqual([]);
    expect(await sdk.recallMemories(revoked)).toEqual([]);
  });

  it("reauthorizes externally ranked semantic candidates", async () => {
    const sdk = new FoldSdk(new MemoryStore());
    await sdk.recordMemory(memoryContext(), stamp("event-a", 100), {
      id: MEMORY_A,
      source: "conversation",
      summary: "Own",
    });
    await sdk.recordMemory(
      memoryContext({ principalId: "user-b" }),
      stamp("event-b", 101),
      { id: MEMORY_B, source: "conversation", summary: "Other" },
    );

    const recalled = await sdk.recallMemories(access(), {
      candidates: [
        { memoryId: MEMORY_B, score: 0.99 },
        { memoryId: MEMORY_A, score: 0.3 },
      ],
    });
    expect(recalled.map(({ memory, score }) => [memory.id, score])).toEqual([[MEMORY_A, 0.3]]);
  });

  it("keeps an inaccessible and an absent memory indistinguishable on mutation", async () => {
    const sdk = new FoldSdk(new MemoryStore());
    await sdk.recordMemory(memoryContext(), stamp("event-a", 100), {
      id: MEMORY_A,
      source: "conversation",
    });
    const otherContext = memoryContext({ principalId: "user-b" });
    await expect(
      sdk.forgetMemory(otherContext, stamp("event-b", 110), MEMORY_A, "remove"),
    ).rejects.toThrow(`personal memory is unavailable: ${MEMORY_A}`);
    await expect(
      sdk.forgetMemory(otherContext, stamp("event-c", 120), MEMORY_B, "remove"),
    ).rejects.toThrow(`personal memory is unavailable: ${MEMORY_B}`);
  });
});
