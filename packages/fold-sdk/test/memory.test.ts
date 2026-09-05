import { describe, expect, it } from "vitest";

import { FoldSdk, PersonalMemoryUnavailableError } from "../src/index.js";
import {
  MEMORY_A,
  MEMORY_B,
  access,
  event,
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
      applicability: { kind: "global" }, source: "conversation",
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
      applicability: { kind: "global" }, source: "conversation",
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
      { id: MEMORY_A, spaceId: "space-a", applicability: { kind: "global" }, source: "conversation" },
    );
    const revoked = access();
    expect(await sdk.listEntries(revoked)).toEqual([]);
    expect(await sdk.recallMemories(revoked)).toEqual([]);
  });

  it("reauthorizes externally ranked semantic candidates", async () => {
    const sdk = new FoldSdk(new MemoryStore());
    await sdk.recordMemory(memoryContext(), stamp("event-a", 100), {
      id: MEMORY_A,
      applicability: { kind: "global" }, source: "conversation",
      summary: "Own",
    });
    await sdk.recordMemory(
      memoryContext({ principalId: "user-b" }),
      stamp("event-b", 101),
      { id: MEMORY_B, applicability: { kind: "global" }, source: "conversation", summary: "Other" },
    );

    const recalled = await sdk.recallMemories(access(), {
      candidates: [
        { memoryId: MEMORY_B, score: 0.99 },
        { memoryId: MEMORY_A, score: 0.3 },
      ],
    });
    expect(recalled.map(({ memory, score }) => [memory.id, score])).toEqual([[MEMORY_A, 0.3]]);
  });

  it("ranks only authorized documents and reauthorizes provider candidates", async () => {
    const sdk = new FoldSdk(new MemoryStore());
    await sdk.recordMemory(memoryContext(), stamp("event-a", 100), {
      id: MEMORY_A,
      applicability: { kind: "global" }, source: "conversation",
      summary: "Refresh the access token",
    });
    await sdk.recordMemory(
      memoryContext({ principalId: "user-b" }),
      stamp("event-b", 101),
      { id: MEMORY_B, applicability: { kind: "global" }, source: "conversation", summary: "Private owner note" },
    );

    const seen: string[] = [];
    const result = await sdk.rankMemories(
      access(),
      { query: "refresh token", limit: 5 },
      {
        descriptor: { id: "test-ranker", kind: "semantic" },
        async rank({ documents }) {
          seen.push(...documents.map(({ memoryId }) => memoryId));
          return [
            { memoryId: MEMORY_B, score: 0.99 },
            { memoryId: MEMORY_A, score: 0.75 },
          ];
        },
      },
    );

    expect(seen).toEqual([MEMORY_A]);
    expect(result).toEqual({
      memories: [{ memory: expect.objectContaining({ id: MEMORY_A }), score: 0.75 }],
      ranking: { id: "test-ranker", kind: "semantic", corpusSize: 1 },
    });
  });

  it("pages authorized memories newest first with a stable cursor", async () => {
    const sdk = new FoldSdk(new MemoryStore());
    const ids = [MEMORY_A, MEMORY_B, "01890f47-7c00-7000-8000-000000000003"];
    for (const [index, id] of ids.entries()) {
      await sdk.recordMemory(memoryContext(), stamp(`event-page-${index}`, 100 + index), {
        id,
        applicability: { kind: "global" }, source: "conversation",
        summary: `Memory ${index}`,
      });
    }
    const first = await sdk.recallMemoryPage(access(), { limit: 2 });
    expect(first.memories.map(({ memory }) => memory.id)).toEqual([ids[2], ids[1]]);
    expect(first.total).toBe(3);
    const second = await sdk.recallMemoryPage(access(), { limit: 2, cursor: first.nextCursor! });
    expect(second.memories.map(({ memory }) => memory.id)).toEqual([ids[0]]);
    expect(second.nextCursor).toBeUndefined();
  });

  it("ranks the complete authorized corpus beyond the response limit", async () => {
    const sdk = new FoldSdk(new MemoryStore());
    for (let index = 0; index < 125; index += 1) {
      const memoryId = `01890f47-7d00-7000-8000-${index.toString(16).padStart(12, "0")}`;
      await sdk.recordMemory(memoryContext(), stamp(`event-${index.toString().padStart(3, "0")}`, 1_000 + index), {
        id: memoryId,
        applicability: { kind: "global" }, source: "archive",
        summary: `Memory ${index}`,
      });
    }
    let corpusSize = 0;
    const result = await sdk.rankMemories(access(), { query: "memory", limit: 5 }, {
      descriptor: { id: "complete-corpus-test", kind: "lexical" },
      async rank({ documents }) {
        corpusSize = documents.length;
        return [];
      },
    });
    expect(corpusSize).toBe(125);
    expect(result.ranking.corpusSize).toBe(125);
  });

  it("rejects empty ranked recall queries before calling the provider", async () => {
    const sdk = new FoldSdk(new MemoryStore());
    let called = false;
    await expect(
      sdk.rankMemories(access(), { query: "   " }, {
        descriptor: { id: "test-ranker", kind: "lexical" },
        async rank() {
          called = true;
          return [];
        },
      }),
    ).rejects.toThrow(/1 to 500/);
    expect(called).toBe(false);
  });

  it("keeps an inaccessible and an absent memory indistinguishable on mutation", async () => {
    const sdk = new FoldSdk(new MemoryStore());
    await sdk.recordMemory(memoryContext(), stamp("event-a", 100), {
      id: MEMORY_A,
      applicability: { kind: "global" }, source: "conversation",
    });
    const otherContext = memoryContext({ principalId: "user-b" });
    await expect(
      sdk.forgetMemory(otherContext, stamp("event-b", 110), MEMORY_A, "remove"),
    ).rejects.toThrow(`personal memory is unavailable: ${MEMORY_A}`);
    await expect(
      sdk.forgetMemory(otherContext, stamp("event-c", 120), MEMORY_B, "remove"),
    ).rejects.toThrow(`personal memory is unavailable: ${MEMORY_B}`);
  });

  it("promotes a workspace candidate and its memory atomically with provenance", async () => {
    const store = new MemoryStore();
    const sdk = new FoldSdk(store);
    const source = event({ id: "transcript-chunk-1", t: 1, actorId: "agent-a" });
    await sdk.append(access({ principalId: "agent-a" }), { ...source, capture: { ...source.capture, identity: { ...source.capture.identity, project: "project-a", run: "run-a" } } });
    const proposed = await sdk.proposeMemoryCandidate(
      memoryContext({ principalId: "agent-a", audience: "workspace" }),
      stamp("candidate-event", 100),
      {
        id: MEMORY_A,
        audience: "workspace",
        projectIds: ["project-a"],
        source: "transcript",
        summary: "Use Postgres for canonical events",
        content: { decision: "postgres" },
        tags: ["decision"],
        evidence: [{ eventId: "transcript-chunk-1", projectId: "project-a", runId: "run-a" }],
        confidence: 0.9,
        salience: 0.8,
        extractor: { kind: "rule", id: "decision-rule", version: "1" },
      },
    );
    expect(proposed.candidate.proposerId).toBe("agent-a");

    const result = await sdk.acceptMemoryCandidate(
      memoryContext({ principalId: "owner-a", workspaceRole: "owner", audience: "workspace" }),
      stamp("accept-event", 110),
      stamp("memory-event", 111),
      MEMORY_A,
      MEMORY_B,
    );
    expect(result.memory).toMatchObject({
      id: MEMORY_B,
      audience: "workspace",
      projectIds: ["project-a"],
      creatorId: "owner-a",
      evidence: [{ eventId: "transcript-chunk-1", projectId: "project-a", runId: "run-a" }],
    });
    expect(result.memoryEvent.causedBy).toEqual(["candidate-event", "accept-event"]);
    expect(store.appendManyCount).toBe(1);
    expect((await sdk.memoryCandidates(access({ principalId: "user-b" })))[0]?.status).toBe("accepted");
    expect((await sdk.recallMemories(access({ principalId: "user-b" }), { projectIds: ["project-a"] }))[0]?.memory.id).toBe(MEMORY_B);
  });

  it("does not expose personal candidates to another principal", async () => {
    const sdk = new FoldSdk(new MemoryStore());
    await sdk.append(access(), event({ id: "transcript-chunk-1", t: 1, creatorId: "user-a" }));
    await sdk.proposeMemoryCandidate(memoryContext(), stamp("candidate-event", 100), {
      id: MEMORY_A,
      source: "transcript",
      summary: "Private preference",
      content: "Use compact output",
      evidence: [{ eventId: "transcript-chunk-1" }],
      confidence: 0.8,
      salience: 0.5,
      extractor: { kind: "rule", id: "preference-rule", version: "1" },
    });
    expect(await sdk.memoryCandidates(access({ principalId: "user-b", workspaceRole: "owner" }))).toEqual([]);
  });

  it("atomically appends bounded candidate batches", async () => {
    const store = new MemoryStore();
    const sdk = new FoldSdk(store);
    const context = memoryContext({ audience: "workspace", workspaceRole: "owner" });
    for (let index = 0; index < 2; index++) await sdk.append(access(), event({ id: `run-event-${index}`, t: index + 1 }));
    const results = await sdk.proposeMemoryCandidates(context, [MEMORY_A, MEMORY_B].map((id, index) => ({
      stamp: stamp(`candidate-event-${index}`, 100 + index),
      input: {
        id,
        audience: "workspace" as const,
        source: "transcript",
        summary: `Candidate ${index}`,
        content: { index },
        evidence: [{ eventId: `run-event-${index}` }],
        confidence: 0.8,
        salience: 0.7,
        extractor: { kind: "rule" as const, id: "batch-rule", version: "1" },
      },
    })));
    expect(results).toHaveLength(2);
    expect(store.appendManyCount).toBe(1);
    expect(await sdk.memoryCandidates(access())).toHaveLength(2);
  });

  it("atomically promotes a bounded candidate batch into active memory", async () => {
    const store = new MemoryStore();
    const sdk = new FoldSdk(store);
    const context = memoryContext({ audience: "workspace", workspaceRole: "owner" });
    for (let index = 0; index < 2; index++) await sdk.append(access(), event({ id: `run-event-${index}`, t: index + 1 }));
    const memoryC = "01890f47-7c02-7000-8000-000000000003";
    const memoryD = "01890f47-7c03-7000-8000-000000000004";
    await sdk.proposeMemoryCandidates(context, [MEMORY_A, MEMORY_B].map((id, index) => ({
      stamp: stamp(`candidate-event-${index}`, 100 + index),
      input: {
        id,
        audience: "workspace" as const,
        projectIds: ["project-a"],
        source: "claude-mem-observation",
        summary: `Candidate ${index}`,
        content: { index },
        evidence: [{ eventId: `run-event-${index}` }],
        confidence: 0.96,
        salience: 0.9,
        extractor: { kind: "rule" as const, id: "batch-rule", version: "1" },
      },
    })));
    const promoted = await sdk.acceptMemoryCandidates(context, [
      { decisionStamp: stamp("accept-a", 110), memoryStamp: stamp("memory-a", 111), candidateId: MEMORY_A, memoryId: memoryC },
      { decisionStamp: stamp("accept-b", 112), memoryStamp: stamp("memory-b", 113), candidateId: MEMORY_B, memoryId: memoryD },
    ]);
    expect(promoted.map(({ memory }) => memory.id)).toEqual([memoryC, memoryD]);
    expect((await sdk.memoryCandidates(access())).every(({ status }) => status === "accepted")).toBe(true);
    expect(await sdk.recallMemories(access(), { projectIds: ["project-a"] })).toHaveLength(2);
    expect(store.appendManyCount).toBe(2);
  });
});
