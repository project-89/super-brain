import { describe, expect, it } from "vitest";

import {
  listMemoryCandidateViews,
  makeMemoryCandidateAcceptedEvent,
  makeMemoryCandidateEvidenceAddedEvent,
  equivalentMemoryCandidateMeaning,
  candidateSupportSourceMatches,
  makeMemoryCandidateProposedEvent,
  makeMemoryCandidateRejectedEvent,
  memoryCandidateLogRecordsFromEvent,
  rebuildMemoryCandidates,
} from "../src/index.js";
import { MEMORY_A, MEMORY_B, context, stamp } from "./helpers.js";

const candidateInput = {
  id: MEMORY_A,
  audience: "workspace" as const,
  projectIds: ["project-b", "project-a", "project-a"],
  source: "transcript",
  summary: "Use Postgres as the durable event store",
  content: { decision: "Use Postgres as the durable event store" },
  tags: ["decision", "architecture", "decision"],
  evidence: [{ eventId: "transcript-chunk-1", runId: "run-1", projectId: "project-a" }],
  confidence: 0.91,
  salience: 0.85,
  extractor: { kind: "rule" as const, id: "durable-decision", version: "1" },
};

describe("memory candidate evidence", () => {
  it("preserves additive support during replay and requires review of the latest evidence", () => {
    const ctx = context({ audience: "workspace" });
    const proposed = makeMemoryCandidateProposedEvent(ctx, stamp("proposal", 100), candidateInput);
    const before = rebuildMemoryCandidates([proposed]).candidates.get(MEMORY_A)!;
    const support = makeMemoryCandidateEvidenceAddedEvent(ctx, stamp("support", 110), before,
      [...before.evidence, { eventId: "later-source", turnId: "late-turn", projectId: "project-a" }]);
    const after = rebuildMemoryCandidates([support, proposed]).candidates.get(MEMORY_A)!;
    expect(after.evidence).toHaveLength(2);
    expect(after.content).toEqual(before.content);
    expect(after.supportEventIds).toEqual(["support"]);
    const stale = makeMemoryCandidateAcceptedEvent(ctx, stamp("accept", 120), before, MEMORY_B);
    expect(() => rebuildMemoryCandidates([proposed, support, stale])).toThrow(/scope does not match/);
    const accepted = makeMemoryCandidateAcceptedEvent(ctx, stamp("accept", 120), after, MEMORY_B);
    expect(listMemoryCandidateViews(rebuildMemoryCandidates([accepted, support, proposed]))[0]?.status).toBe("accepted");
    const late = makeMemoryCandidateEvidenceAddedEvent(ctx, stamp("late", 130), after, [{ eventId: "new-source" }]);
    expect(() => rebuildMemoryCandidates([proposed, support, accepted, late])).toThrow(/undecided/);
  });

  it("compares full meaning canonically without collapsing content or scope variants", () => {
    expect(equivalentMemoryCandidateMeaning(candidateInput, { ...candidateInput, projectIds: ["project-a", "project-b"], tags: ["architecture", "decision"] })).toBe(true);
    expect(equivalentMemoryCandidateMeaning(candidateInput, { ...candidateInput, content: { decision: "Use another database" } })).toBe(false);
    expect(equivalentMemoryCandidateMeaning(candidateInput, { ...candidateInput, projectIds: ["project-c"] })).toBe(false);
    expect(equivalentMemoryCandidateMeaning(candidateInput, { ...candidateInput, audience: "personal" })).toBe(false);
  });

  it("uses verified project IDs, accommodates aliases and multi-project runs, and ignores display names", () => {
    const ctx = context({ audience: "workspace" });
    const proposed = makeMemoryCandidateProposedEvent(ctx, stamp("proposal", 100), { ...candidateInput, projectIds: ["project-a"] });
    const candidate = rebuildMemoryCandidates([proposed]).candidates.get(MEMORY_A)!;
    const displayOnly = { ...proposed, capture: { ...proposed.capture, identity: { ...proposed.capture.identity, project: "Human project name" } } };
    expect(candidateSupportSourceMatches(candidate, { eventId: "source" }, displayOnly)).toBe(true);
    const projectB = { ...displayOnly, capture: { ...displayOnly.capture, identity: { ...displayOnly.capture.identity, repo: "project-b" } } };
    expect(candidateSupportSourceMatches(candidate, { eventId: "source" }, projectB, candidate.projectIds, ["project-a", "project-b"])).toBe(false);
    expect(candidateSupportSourceMatches(candidate, { eventId: "source", projectId: "project-a" }, projectB, candidate.projectIds, ["project-a", "project-b"])).toBe(false);
    expect(candidateSupportSourceMatches(candidate, { eventId: "source" }, projectB, ["project-a", "project-b"], ["project-a", "project-b"])).toBe(true);
    const unknownRepo = { ...displayOnly, capture: { ...displayOnly.capture, identity: { ...displayOnly.capture.identity, repo: "https://github.com/example/repository" } } };
    expect(candidateSupportSourceMatches(candidate, { eventId: "source" }, unknownRepo, candidate.projectIds, ["project-a", "project-b"])).toBe(true);
    const mixed = { ...displayOnly, kind: "transcript.run-imported", changes: [{ ...proposed.changes[0]!, verb: "create" as const,
      subject: "run", nodeKind: "fact", after: { run: { projectId: "project-b", segments: [{ projectId: "project-a" }] } } }] };
    expect(candidateSupportSourceMatches(candidate, { eventId: "source", projectId: "project-a" }, mixed)).toBe(true);
    expect(candidateSupportSourceMatches(candidate, { eventId: "source", projectId: "project-c" }, mixed)).toBe(false);
  });
  it("records normalized provenance and rebuilds an accepted decision", () => {
    const proposer = context({ principalId: "agent-a", audience: "workspace" });
    const proposed = makeMemoryCandidateProposedEvent(proposer, stamp("candidate-event", 100), candidateInput);
    const candidate = rebuildMemoryCandidates([proposed]).candidates.get(MEMORY_A)!;
    expect(candidate).toMatchObject({
      proposerId: "agent-a",
      audience: "workspace",
      projectIds: ["project-a", "project-b"],
      tags: ["architecture", "decision"],
      proposalEventId: "candidate-event",
    });

    const accepted = makeMemoryCandidateAcceptedEvent(
      context({ principalId: "owner-a", workspaceRole: "owner", audience: "workspace" }),
      stamp("accepted-event", 110),
      candidate,
      MEMORY_B,
    );
    expect(listMemoryCandidateViews(rebuildMemoryCandidates([accepted, proposed]))[0]).toMatchObject({
      status: "accepted",
      decision: { memoryId: MEMORY_B, actorId: "owner-a" },
    });
  });

  it("rejects duplicate or conflicting decisions during replay", () => {
    const eventContext = context({ audience: "workspace" });
    const proposed = makeMemoryCandidateProposedEvent(eventContext, stamp("candidate-event", 100), candidateInput);
    const candidate = rebuildMemoryCandidates([proposed]).candidates.get(MEMORY_A)!;
    const accepted = makeMemoryCandidateAcceptedEvent(eventContext, stamp("accepted-event", 110), candidate, MEMORY_B);
    const rejected = makeMemoryCandidateRejectedEvent(eventContext, stamp("rejected-event", 120), candidate, "obsolete");
    expect(() => rebuildMemoryCandidates([proposed, accepted, rejected])).toThrow(/already decided/);
  });

  it("keeps personal candidate decisions with the proposer", () => {
    const proposer = context({ principalId: "user-a" });
    const proposed = makeMemoryCandidateProposedEvent(proposer, stamp("candidate-event", 100), {
      ...candidateInput,
      audience: "personal",
    });
    const candidate = rebuildMemoryCandidates([proposed]).candidates.get(MEMORY_A)!;
    expect(() => makeMemoryCandidateRejectedEvent(
      context({ principalId: "user-b" }),
      stamp("rejected-event", 110),
      candidate,
      "not mine",
    )).toThrow(/only the proposer/);
    expect(memoryCandidateLogRecordsFromEvent(proposed)).toHaveLength(1);
  });
});
