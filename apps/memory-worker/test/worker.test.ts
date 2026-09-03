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
});
