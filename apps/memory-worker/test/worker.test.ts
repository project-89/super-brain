import { mergeMemoryCandidateEvidence, type MemoryCandidateView, type PersonalMemory } from "@_89/fold-epistemic";
import { SuperBrainApiError, type SuperBrainClient } from "@_89/super-brain-client";
import { makeTrajectoryRecordedEvent } from "@_89/fold-trajectory";
import type { TranscriptRun } from "@_89/fold-transcript";
import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

const crossProjectCandidates: readonly MemoryCandidateView[] = ["a", "b"].map((suffix, index) => ({
  candidate: {
    ...candidate.candidate,
    id: `019c0000-0000-7000-8000-00000000002${index}`,
    projectIds: [`project-${suffix}`],
    summary: `Evidence ${suffix}`,
    proposedAt: 100 + index,
  },
  status: "accepted" as const,
  decision: {
    kind: "accepted" as const,
    candidateId: `019c0000-0000-7000-8000-00000000002${index}`,
    actorId: "worker-a",
    atMs: 100 + index,
    eventId: `accepted-cross-project-${index}`,
    memoryId: `019c0000-0000-7000-8000-00000000000${index + 3}`,
  },
}));

describe("live memory consolidation", () => {
  it.each([false, true])("preserves 151 repeated supports with bounded proposals and concurrent conflict=%s", async (conflict) => {
    const stored: MemoryCandidateView[] = [];
    let first = true;
    const client = {
      memoryCandidates: vi.fn(async () => stored),
      proposeMemoryCandidates: vi.fn(async (inputs: ExtractedCandidate[]) => {
        expect(inputs.every((input) => input.evidence.length <= 100)).toBe(true);
        stored.push(...inputs.map((input) => ({ status: "proposed" as const, candidate: { ...candidate.candidate, ...input,
          evidence: first && conflict ? input.evidence.slice(0, 1) : input.evidence } })));
        if (first && conflict) { first = false; throw new SuperBrainApiError(409, "conflict", "Another writer created the candidate"); }
        first = false;
      }),
      addMemoryCandidateEvidence: vi.fn(async (id: string, input: ExtractedCandidate) => {
        expect(input.evidence.length).toBeLessThanOrEqual(1000);
        const current = stored.find(({ candidate }) => candidate.id === id)!;
        const updated = { ...current.candidate, evidence: mergeMemoryCandidateEvidence(current.candidate.evidence, input.evidence) };
        stored[stored.indexOf(current)] = { status: "proposed", candidate: updated };
        return { candidate: updated };
      }),
    };
    const worker = new TranscriptMemoryWorker({ client: client as unknown as SuperBrainClient, vaultRoot: "/unused", maxCandidatesPerRun: 500 });
    const inputs = Array.from({ length: 151 }, (_, index) => ({ ...candidate.candidate,
      id: index === 0 ? candidate.candidate.id : `candidate-${index}`, evidence: [{ eventId: `source-${index}`, turnId: `turn-${index}` }] }));
    expect(await worker.propose(inputs)).toBe(conflict ? 0 : 1);
    expect(stored).toHaveLength(1); expect(stored[0]?.candidate.evidence).toHaveLength(151);
    const correction = { ...inputs[0]!, content: { summary: "Changed conclusion under the same source-derived ID" } };
    expect(await worker.propose([correction])).toBe(1);
    expect(stored).toHaveLength(2);
    expect(stored[1]?.candidate.id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    expect(stored[1]?.candidate.evidence).toEqual(correction.evidence);
    expect(await new TranscriptMemoryWorker({ client: client as unknown as SuperBrainClient, vaultRoot: "/unused" }).propose([correction])).toBe(0);
    expect(stored).toHaveLength(2);
  });
  it("merges in-batch and later pending support while preserving same-summary corrections", async () => {
    const stored: MemoryCandidateView[] = [];
    const client = {
      memoryCandidates: vi.fn(async () => stored),
      proposeMemoryCandidates: vi.fn(async (inputs: ExtractedCandidate[]) => {
        stored.push(...inputs.map((input) => ({ status: "proposed" as const, candidate: { ...candidate.candidate, ...input } })));
      }),
      addMemoryCandidateEvidence: vi.fn(async (id: string, input: ExtractedCandidate) => {
        const current = stored.find(({ candidate }) => candidate.id === id)!;
        const updated = { ...current.candidate, evidence: mergeMemoryCandidateEvidence(current.candidate.evidence, input.evidence) };
        stored[stored.indexOf(current)] = { status: "proposed", candidate: updated };
        return { candidate: updated };
      }),
    };
    const worker = new TranscriptMemoryWorker({ client: client as unknown as SuperBrainClient, vaultRoot: "/unused" });
    const support = (index: number) => ({ ...candidate.candidate, id: `support-${index}`, evidence: [{ eventId: `source-${index}`, projectId: "project-a" }] });
    expect(await worker.propose(Array.from({ length: 25 }, (_, index) => support(index)))).toBe(1);
    expect(stored[0]?.candidate.evidence).toHaveLength(25);
    expect(await worker.propose(Array.from({ length: 7 }, (_, index) => support(index + 25)))).toBe(0);
    expect(stored[0]?.candidate.evidence).toHaveLength(32);
    const restarted = new TranscriptMemoryWorker({ client: client as unknown as SuperBrainClient, vaultRoot: "/unused" });
    expect(await restarted.propose([support(31)])).toBe(0);
    expect(stored[0]?.candidate.evidence).toHaveLength(32);
    expect(await restarted.propose([{ ...support(32), content: { summary: "Correction: use a different storage contract" } }])).toBe(1);
    expect(stored).toHaveLength(2);
    expect(stored[0]?.candidate.content).toEqual(candidate.candidate.content);
    expect(stored[1]?.candidate.evidence).toEqual(support(32).evidence);
  });

  it.each(["accepted", "rejected"] as const)("does not discard fresh support when review races and becomes %s", async (status) => {
    let current: MemoryCandidateView = { candidate: candidate.candidate, status: "proposed" };
    const revised = vi.fn(); const proposed = vi.fn();
    const incoming = { ...candidate.candidate, id: "late", evidence: [{ eventId: "new-source" }] };
    const client = {
      memoryCandidates: vi.fn(async () => [current]),
      memoryById: vi.fn(async () => ({ ...candidate.candidate, id: "accepted-memory" })),
      reviseMemory: revised, proposeMemoryCandidates: proposed,
      addMemoryCandidateEvidence: vi.fn(async () => { current = { ...candidate, status,
        ...(status === "rejected" ? { decision: { kind: "rejected", candidateId: candidate.candidate.id, actorId: "user", atMs: 110, eventId: "reject", reason: "not applicable" } } : {}) } as MemoryCandidateView;
        throw new SuperBrainApiError(409, "conflict", "candidate changed"); }),
    };
    const worker = new TranscriptMemoryWorker({ client: client as unknown as SuperBrainClient, vaultRoot: "/unused" });
    expect(await worker.propose([incoming])).toBe(status === "accepted" ? 0 : 1);
    expect(revised).toHaveBeenCalledTimes(status === "accepted" ? 1 : 0);
    expect(proposed).toHaveBeenCalledTimes(status === "rejected" ? 1 : 0);
  });

  it("preserves a content correction instead of attaching it as accepted supporting evidence", async () => {
    const proposeMemoryCandidates = vi.fn(); const reviseMemory = vi.fn();
    const client = { memoryCandidates: vi.fn(async () => [candidate]), memoryById: vi.fn(async () => candidate.candidate), proposeMemoryCandidates, reviseMemory };
    const worker = new TranscriptMemoryWorker({ client: client as unknown as SuperBrainClient, vaultRoot: "/unused" });
    expect(await worker.propose([{ ...candidate.candidate, id: "correction", content: "The earlier conclusion was wrong" }])).toBe(1);
    expect(reviseMemory).not.toHaveBeenCalled();
  });
  it.each(["proposed", "rejected"] as const)("consolidates accepted evidence before suppressing a %s duplicate", async (status) => {
    const earlierDuplicate = { candidate: { ...candidate.candidate, id: "earlier-duplicate" }, status };
    const memory = { ...candidate.candidate, id: "accepted-memory" };
    const reviseMemory = vi.fn().mockResolvedValue({});
    const proposeMemoryCandidates = vi.fn();
    const client = {
      memoryCandidates: vi.fn().mockResolvedValue([earlierDuplicate, candidate]),
      memoryById: vi.fn().mockResolvedValue(memory), reviseMemory, proposeMemoryCandidates,
    } as unknown as SuperBrainClient;
    const incoming = { ...candidate.candidate, id: "fresh-evidence", evidence: [{ eventId: "new-event", projectId: "project-a" }] };
    await expect(new TranscriptMemoryWorker({ client, vaultRoot: "/unused" }).propose([incoming])).resolves.toBe(0);
    expect(reviseMemory).toHaveBeenCalledExactlyOnceWith(memory.id, { evidence: [...candidate.candidate.evidence, ...incoming.evidence] }, ["new-event"]);
    expect(proposeMemoryCandidates).not.toHaveBeenCalled();
  });

  it.each([
    { applicability: "project" as const, projectIds: ["project-b"] },
    { applicability: "general" as const, projectIds: [] },
  ])("does not attach fresh project evidence to a memory revised to $applicability $projectIds", async (scope) => {
    const revisedMemory = { ...candidate.candidate, ...scope, id: candidate.decision!.kind === "accepted" ? candidate.decision!.memoryId : "", revision: 1 };
    const reviseMemory = vi.fn();
    const proposeMemoryCandidates = vi.fn().mockResolvedValue({});
    const fresh = { ...candidate.candidate, id: "fresh-a", evidence: [{ eventId: "fresh-evidence", projectId: "project-a" }] };
    const client = { memoryCandidates: vi.fn().mockResolvedValue([candidate]), memoryById: vi.fn().mockResolvedValue(revisedMemory), reviseMemory, proposeMemoryCandidates } as unknown as SuperBrainClient;
    const worker = new TranscriptMemoryWorker({ client, vaultRoot: "/unused" });
    await expect(worker.propose([candidate.candidate])).resolves.toBe(0);
    await expect(worker.propose([fresh])).resolves.toBe(1);
    await expect(worker.propose([fresh, { ...fresh, id: "another-fresh-a" }])).resolves.toBe(0);
    expect(proposeMemoryCandidates).toHaveBeenCalledExactlyOnceWith([fresh], { audience: "workspace" });
    expect(reviseMemory).not.toHaveBeenCalled();
    const reopenedClient = { ...client, memoryCandidates: vi.fn().mockResolvedValue([candidate, { candidate: fresh, status: "proposed" }]) } as unknown as SuperBrainClient;
    await expect(new TranscriptMemoryWorker({ client: reopenedClient, vaultRoot: "/unused" }).propose([{ ...fresh, id: "after-restart" }])).resolves.toBe(0);
    expect(proposeMemoryCandidates).toHaveBeenCalledTimes(1);
  });

  it("does not deduplicate general and unresolved memories with matching summaries", async () => {
    const general = { ...candidate.candidate, applicability: "general" as const, projectIds: [] };
    const proposeMemoryCandidates = vi.fn().mockResolvedValue({});
    const client = {
      memoryCandidates: vi.fn().mockResolvedValue([{ candidate: general, status: "proposed" }]),
      proposeMemoryCandidates,
    } as unknown as SuperBrainClient;
    const worker = new TranscriptMemoryWorker({ client, vaultRoot: "/unused" });
    const unresolved = { ...general, id: "019c0000-0000-7000-8000-000000000090", applicability: "unresolved" as const };
    await expect(worker.propose([unresolved])).resolves.toBe(1);
    expect(proposeMemoryCandidates).toHaveBeenCalledWith([unresolved], { audience: "workspace" });
  });

  it("deduplicates legacy project scope with explicit project applicability", async () => {
    const proposeMemoryCandidates = vi.fn();
    const client = {
      memoryCandidates: vi.fn().mockResolvedValue([{ candidate: candidate.candidate, status: "proposed" }]),
      proposeMemoryCandidates,
    } as unknown as SuperBrainClient;
    const worker = new TranscriptMemoryWorker({ client, vaultRoot: "/unused" });
    await expect(worker.propose([{ ...candidate.candidate, id: "other", applicability: "project" }])).resolves.toBe(0);
    expect(proposeMemoryCandidates).not.toHaveBeenCalled();
  });

  it("resolves observed files explicitly without assigning projects to general memories", () => {
    const worker = new TranscriptMemoryWorker({ client: {} as SuperBrainClient, vaultRoot: "/unused" });
    worker.configureProjectRoots([{ segments: [{ cwd: "/work/project", projectId: "project-a" }] } as unknown as TranscriptRun]);
    const unresolved: ExtractedCandidate = {
      ...candidate.candidate, source: "claude-mem-observation", applicability: "unresolved", projectIds: [],
      content: { files: ["/work/project/src/main.ts"] },
    };
    expect(worker["resolveCandidateProjects"](unresolved)).toMatchObject({ applicability: "project", projectIds: ["project-a"] });
    const general = { ...unresolved, applicability: "general" as const };
    expect(worker["resolveCandidateProjects"](general)).toBe(general);
    const unlocated = { ...unresolved, content: { files: ["/elsewhere/main.ts"] } };
    expect(worker["resolveCandidateProjects"](unlocated)).toBe(unlocated);
  });

  it("does not promote every reasoning checkpoint merely because its task succeeded", async () => {
    const event = makeTrajectoryRecordedEvent({
      access: { principalId: "worker-a", workspaceId: "workspace-a", workspaceRole: "owner", spaceRoles: {} },
      author: { kind: "human", id: "worker-a" },
      capture: { scope: { workspace: "workspace-a" }, identity: { principal: "worker-a", workspace: "workspace-a" } },
    }, { id: "completed-task", t: 200, worldDate: "2026-09-09" }, {
      taskId: "task-a", rootNodeId: "done", nodes: [{ id: "done", kind: "outcome", label: "Done" }], edges: [],
    }, {
      id: "run-a", taskId: "task-a", model: { id: "model-a" }, outcome: "success",
      outcomeEvidence: { kind: "operator-verdict", eventId: "operator-verdict" },
      steps: [{ id: "step-a", stepNumber: 1, role: "model_thought", content: "An early hypothesis that was later discarded", eventId: "event-a" }],
      assignments: { "step-a": { kind: "mapped", nodeId: "done", method: { kind: "rule", id: "test" } } },
    });
    const acceptMemoryCandidates = vi.fn();
    const client = {
      memoryCandidates: vi.fn().mockResolvedValue([{ candidate: candidate.candidate, status: "proposed" }]),
      transcriptRuns: vi.fn().mockResolvedValue([]),
      consumeEvents: vi.fn().mockImplementation(async ({ onEvent }) => { await onEvent({ entry: { status: "canon", event } }); }),
      acceptMemoryCandidates,
    } as unknown as SuperBrainClient;
    const processingRoot = await mkdtemp(join(tmpdir(), "memory-watch-"));
    try { await new TranscriptMemoryWorker({ client, vaultRoot: "/unused", autoPromote: true, processingRoot }).watch({ consumerId: "test" }); }
    finally { await rm(processingRoot, { recursive: true, force: true }); }
    expect(acceptMemoryCandidates).not.toHaveBeenCalled();
  });

  it("retries rate-limited repair reads without duplicating revisions", async () => {
    const reviseMemory = vi.fn().mockResolvedValue({});
    const client = {
      memoryCandidates: vi.fn().mockResolvedValue([candidate]),
      memoryById: vi.fn()
        .mockRejectedValueOnce(new SuperBrainApiError(429, "rate_limited", "Retry later", { retryAfterSeconds: 0 }))
        .mockResolvedValue({ id: "accepted-memory" }),
      reviseMemory,
    } as unknown as SuperBrainClient;
    const worker = new TranscriptMemoryWorker({ client, vaultRoot: "/unused" });
    await expect(worker.repairAcceptedEvidence(true)).resolves.toMatchObject({ repaired: 1 });
    expect(reviseMemory).toHaveBeenCalledTimes(1);
  });

  it("previews and idempotently repairs legacy evidence without changing content or scope", async () => {
    let memory = {
      id: candidate.decision!.kind === "accepted" ? candidate.decision!.memoryId : "",
      summary: "A user-edited summary", content: { retained: true }, audience: "personal",
      evidence: [{ eventId: "existing-user-evidence" }], revision: 3,
    };
    const reviseMemory = vi.fn().mockImplementation(async (_id, patch) => {
      memory = { ...memory, ...patch, revision: memory.revision + 1 };
      return { memory };
    });
    const client = {
      memoryCandidates: vi.fn().mockResolvedValue([candidate]),
      memoryById: vi.fn().mockImplementation(async () => memory),
      reviseMemory,
    } as unknown as SuperBrainClient;
    const worker = new TranscriptMemoryWorker({ client, vaultRoot: "/unused" });
    await expect(worker.repairAcceptedEvidence()).resolves.toMatchObject({ repairable: 1, repaired: 0 });
    expect(reviseMemory).not.toHaveBeenCalled();
    await expect(worker.repairAcceptedEvidence(true)).resolves.toMatchObject({ repairable: 1, repaired: 1 });
    expect(reviseMemory).toHaveBeenCalledWith(memory.id, { evidence: [
      { eventId: "existing-user-evidence" }, ...candidate.candidate.evidence,
    ] }, [candidate.decision!.eventId]);
    expect(memory).toMatchObject({ summary: "A user-edited summary", content: { retained: true }, audience: "personal", revision: 4 });
    await expect(worker.repairAcceptedEvidence(true)).resolves.toMatchObject({ repairable: 0, repaired: 0 });
    expect(reviseMemory).toHaveBeenCalledTimes(1);
  });

  it("does not recreate a forgotten memory during evidence repair", async () => {
    const reviseMemory = vi.fn();
    const proposeMemoryCandidates = vi.fn();
    const client = {
      memoryCandidates: vi.fn().mockResolvedValue([candidate]), memoryById: vi.fn().mockResolvedValue(undefined), reviseMemory, proposeMemoryCandidates,
    } as unknown as SuperBrainClient;
    const worker = new TranscriptMemoryWorker({ client, vaultRoot: "/unused" });
    await expect(worker.repairAcceptedEvidence(true)).resolves.toMatchObject({ missingMemories: 1, repaired: 0 });
    await expect(worker.propose([{ ...candidate.candidate, id: "fresh-after-forgetting" }])).resolves.toBe(0);
    expect(reviseMemory).not.toHaveBeenCalled();
    expect(proposeMemoryCandidates).not.toHaveBeenCalled();
  });

  it("restores evidence even when the exact same accepted proposal is replayed", async () => {
    const reviseMemory = vi.fn().mockResolvedValue({});
    const client = {
      memoryCandidates: vi.fn().mockResolvedValue([candidate]),
      memoryById: vi.fn().mockResolvedValue({ ...candidate.candidate, id: "accepted-memory", evidence: [] }), reviseMemory,
    } as unknown as SuperBrainClient;
    await new TranscriptMemoryWorker({ client, vaultRoot: "/unused" }).propose([candidate.candidate]);
    expect(reviseMemory).toHaveBeenCalledWith("accepted-memory", { evidence: candidate.candidate.evidence }, ["event-a"]);
  });

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
      ...(index === 0 ? {} : { evidence: [{ eventId: `event-${suffix}`, projectId: `project-${suffix}` }] }),
      createdAt: 100 + index,
      updatedAt: 100 + index,
      revision: 0,
    }));
    const proposeMemoryCandidates = vi.fn().mockResolvedValue({});
    const accepted = memories.map((memory, index): MemoryCandidateView => ({
      candidate: {
        ...candidate.candidate,
        id: `019c0000-0000-7000-8000-00000000001${index}`,
        projectIds: memory.projectIds,
        summary: memory.summary,
        evidence: [{ eventId: `event-${index === 0 ? "a" : "b"}`, projectId: memory.projectIds[0]! }],
        proposedAt: memory.createdAt,
      },
      status: "accepted",
      decision: {
        kind: "accepted",
        candidateId: `019c0000-0000-7000-8000-00000000001${index}`,
        actorId: "worker-a",
        atMs: memory.createdAt,
        eventId: `accepted-${index}`,
        memoryId: memory.id,
      },
    }));
    const client = {
      askReasoning: vi.fn().mockResolvedValue({
        answer: "Use the same evidence-first release gate across both projects.",
        citations: memories.map(({ id }) => id),
        provider: { id: "http-model:reasoner-1", kind: "model" },
      }),
      memoryById: vi.fn().mockImplementation((id) => memories.find((memory) => memory.id === id)),
      memoryCandidates: vi.fn().mockImplementation(({ offset = 0 } = {}) => offset === 0 ? accepted : []),
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
        applicability: "project",
        extractor: { kind: "model", id: "http-model:reasoner-1", version: "1" },
        evidence: [
          { eventId: "event-a", projectId: "project-a" },
          { eventId: "event-b", projectId: "project-b" },
        ],
      }),
    ], { audience: "workspace" });
    expect(client.askReasoning).toHaveBeenCalledWith({
      question: expect.any(String),
      memoryIds: expect.arrayContaining(memories.map(({ id }) => id)),
    });
  });

  it("does not relabel extractive fallback output as model cognition", async () => {
    const client = {
      askReasoning: vi.fn().mockResolvedValue({
        answer: "Extractive answer",
        citations: [],
        provider: { id: "local-evidence-v1", kind: "extractive" },
      }),
      memoryCandidates: vi.fn().mockResolvedValue(crossProjectCandidates),
      memoryById: vi.fn().mockImplementation((id) => ({ id, projectIds: [id], audience: "workspace" })),
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

  it.each([{ audience: "personal" }, { audience: "workspace", spaceId: "private-space" }])("does not synthesize broader output from current restricted memory: %s", async (scope) => {
    const askReasoning = vi.fn();
    const client = {
      askReasoning, memoryCandidates: vi.fn().mockResolvedValue(crossProjectCandidates),
      memoryById: vi.fn().mockImplementation((id) => ({ id, projectIds: [id], ...scope })),
    } as unknown as SuperBrainClient;
    const worker = new TranscriptMemoryWorker({ client, vaultRoot: "/unused", continuousCognition: true, cognitionEveryEvents: 1 });
    await expect(worker.synthesizeAcrossProjects({ id: "trigger", kind: "memory.recorded", at: { t: 200, worldDate: "2026-09-15" } })).resolves.toMatchObject({ proposed: 0, skippedReason: "cross-project evidence with compatible publication scope unavailable" });
    expect(askReasoning).not.toHaveBeenCalled();
  });

  it("disables optional cognition without stalling the consumer when reasoning scope is absent", async () => {
    const askReasoning = vi.fn().mockRejectedValue(
      new SuperBrainApiError(403, "credential_scope_denied", "Credential lacks reasoning:read"),
    );
    const reportWarning = vi.fn();
    const worker = new TranscriptMemoryWorker({
      client: { askReasoning, memoryCandidates: vi.fn().mockResolvedValue(crossProjectCandidates), memoryById: vi.fn().mockImplementation((id) => ({ id, projectIds: [id], audience: "workspace" })) } as unknown as SuperBrainClient,
      vaultRoot: "/unused",
      continuousCognition: true,
      cognitionEveryEvents: 1,
      reportWarning,
    });
    const event = {
      id: "trigger-event",
      kind: "memory.recorded",
      at: { t: 200, worldDate: "2026-09-04" },
    } as const;

    await expect(worker.synthesizeAcrossProjects(event)).resolves.toEqual({
      proposed: 0,
      skippedReason: "reasoning access unavailable",
    });
    await expect(worker.synthesizeAcrossProjects(event)).resolves.toEqual({
      proposed: 0,
      skippedReason: "reasoning access unavailable",
    });
    expect(askReasoning).toHaveBeenCalledTimes(1);
    expect(reportWarning).toHaveBeenCalledOnce();
  });
});
