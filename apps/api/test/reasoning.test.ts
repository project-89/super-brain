import { describe, expect, it } from "vitest";

import {
  LocalEvidenceReasoner,
  validateReasoningResult,
  type ReasoningEvidence,
} from "../src/index.js";

const evidence: ReasoningEvidence[] = [{
  memoryId: "memory-a",
  source: "conversation",
  summary: "Rotate the access token before retrying",
  content: { outcome: "refresh succeeded" },
  tags: ["authentication"],
  score: 1,
}];

describe("local evidence reasoner", () => {
  it("returns an explicitly extractive answer with authorized citations", async () => {
    const reasoner = new LocalEvidenceReasoner();
    expect(await reasoner.answer({ question: "How did refresh recover?", evidence })).toEqual({
      answer: "Relevant evidence: Rotate the access token before retrying.",
      citations: ["memory-a"],
    });
    expect(reasoner.descriptor).toEqual({ id: "local-evidence-v1", kind: "extractive" });
  });

  it("rejects citations outside the supplied evidence", () => {
    expect(() => validateReasoningResult(
      { answer: "Unsupported", citations: ["memory-b"] },
      evidence,
    )).toThrow(/outside its authorized evidence/);
  });
});
