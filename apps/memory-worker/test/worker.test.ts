import type { MemoryCandidateView, PersonalMemory } from "@_89/fold-epistemic";
import type { SuperBrainClient } from "@_89/super-brain-client";
import { describe, expect, it, vi } from "vitest";

import { TranscriptMemoryWorker, type ExtractedCandidate } from "../src/index.js";

const candidate: MemoryCandidateView = {
  candidate: {
    id: "019c0000-0000-7000-8000-000000000001",
    workspaceId: "workspace-a",
    proposerId: "worker-a",
    audience: "workspace",
    projectIds: ["project-a"],
    source: "live-reasoning-checkpoint",
    summary: "Postgres is canonical",
    content: { summary: "Postgres is canonical" },
    tags: ["reasoning-checkpoint"],
    entities: [],
    evidence: [{ eventId: "event-a", projectId: "project-a" }],
    confidence: 0.9,
    salience: 0.8,
    extractor: { kind: "rule", id: "live-structured-memory", version: "1" },
    proposedAt: 100,
    proposalEventId: "proposal-a",
  },
  status: "accepted",
  decision: {
    kind: "accepted",
    candidateId: "019c0000-0000-7000-8000-000000000001",
    actorId: "worker-a",
    atMs: 101,
    eventId: "accepted-a",
    memoryId: "019c0000-0000-7000-8000-000000000002",
  },
};

describe("live memory consolidation", () => {
  it("attaches repeated evidence to the accepted memory through a revision", async () => {
    const memory: PersonalMemory = {
      id: "019c0000-0000-7000-8000-000000000002",
      workspaceId: "workspace-a",
      creatorId: "worker-a",
      audience: "workspace",
      projectIds: ["project-a"],
      source: candidate.candidate.source,
      summary: candidate.candidate.summary,
      content: candidate.candidate.content,
      tags: candidate.candidate.tags,
      entities: [],
      evidence: candidate.candidate.evidence,
      createdAt: 101,
      updatedAt: 101,
      revision: 0,
    };
    const reviseMemory = vi.fn().mockResolvedValue({ memory: { ...memory, revision: 1 } });
    const client = {
      memoryCandidates: vi.fn().mockImplementation(({ offset = 0 } = {}) => offset === 0 ? [candidate] : []),
      memoryById: vi.fn().mockResolvedValue(memory),
      reviseMemory,
    } as unknown as SuperBrainClient;
    const worker = new TranscriptMemoryWorker({ client, vaultRoot: "/unused", audience: "workspace" });
    const repeated: ExtractedCandidate = {
      ...candidate.candidate,
      id: "019c0000-0000-7000-8000-000000000003",
      evidence: [{ eventId: "event-b", projectId: "project-a", turnId: "turn-b" }],
    };
    await expect(worker.propose([repeated])).resolves.toBe(0);
    expect(reviseMemory).toHaveBeenCalledWith(memory.id, {
      evidence: [
        { eventId: "event-a", projectId: "project-a" },
        { eventId: "event-b", projectId: "project-a", turnId: "turn-b" },
      ],
    }, ["event-b"]);
  });

  it("creates a reviewable model proposal only from cited cross-project evidence", async () => {
    const memories: PersonalMemory[] = ["a", "b"].map((suffix, index) => ({
      id: `019c0000-0000-7000-8000-00000000000${index + 3}`,
      workspaceId: "workspace-a",
      creatorId: "worker-a",
      audience: "workspace",
      projectIds: [`project-${suffix}`],
      source: "conversation",
      summary: `Evidence ${suffix}`,
      content: { statement: `Evidence ${suffix}` },
      tags: [],
      entities: [],
      evidence: [{ eventId: `event-${suffix}`, projectId: `project-${suffix}` }],
      createdAt: 100 + index,
      updatedAt: 100 + index,
      revision: 0,
    }));
    const proposeMemoryCandidates = vi.fn().mockResolvedValue({});
    const client = {
      askReasoning: vi.fn().mockResolvedValue({
        answer: "Use the same evidence-first release gate across both projects.",
        citations: memories.map(({ id }) => id),
        provider: { id: "http-model:reasoner-1", kind: "model" },
      }),
      memoryById: vi.fn().mockImplementation((id) => memories.find((memory) => memory.id === id)),
      memoryCandidates: vi.fn().mockResolvedValue([]),
      proposeMemoryCandidates,
    } as unknown as SuperBrainClient;
    const worker = new TranscriptMemoryWorker({
      client,
      vaultRoot: "/unused",
      audience: "workspace",
      continuousCognition: true,
      cognitionEveryEvents: 1,
    });
    await expect(worker.synthesizeAcrossProjects({
      id: "trigger-event",
      kind: "memory.recorded",
      at: { t: 200, worldDate: "2026-09-04" },
    })).resolves.toEqual({ proposed: 1 });
    expect(proposeMemoryCandidates).toHaveBeenCalledWith([
      expect.objectContaining({
        source: "continuous-cognition",
        projectIds: ["project-a", "project-b"],
        extractor: { kind: "model", id: "http-model:reasoner-1", version: "1" },
        evidence: [
          { eventId: "event-a", projectId: "project-a" },
          { eventId: "event-b", projectId: "project-b" },
        ],
      }),
    ], { audience: "workspace" });
  });

  it("does not relabel extractive fallback output as model cognition", async () => {
    const client = {
      askReasoning: vi.fn().mockResolvedValue({
        answer: "Extractive answer",
        citations: [],
        provider: { id: "local-evidence-v1", kind: "extractive" },
      }),
    } as unknown as SuperBrainClient;
    const worker = new TranscriptMemoryWorker({
      client,
      vaultRoot: "/unused",
      continuousCognition: true,
      cognitionEveryEvents: 1,
    });
    await expect(worker.synthesizeAcrossProjects({
      id: "trigger-event",
      kind: "memory.recorded",
      at: { t: 200, worldDate: "2026-09-04" },
    })).resolves.toEqual({ proposed: 0, skippedReason: "model reasoning provider unavailable" });
  });
});
