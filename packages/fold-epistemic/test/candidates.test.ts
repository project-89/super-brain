import { describe, expect, it } from "vitest";

import {
  listMemoryCandidateViews,
  makeMemoryCandidateAcceptedEvent,
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
