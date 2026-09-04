import { describe, expect, it, vi } from "vitest";

import {
  LocalEvidenceReasoner,
  HttpModelReasoner,
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

  it("calls a bounded HTTP model provider with explicit provenance", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      answer: "Rotate the token first.",
      citations: ["memory-a"],
    }), { status: 200 }));
    const reasoner = new HttpModelReasoner({
      url: "https://reasoning.internal/v1/answer",
      model: "reasoner-1",
      token: "provider-token",
      maxEvidence: 1,
      maxInputCharacters: 1_000,
      fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(reasoner.answer({ question: "How did refresh recover?", evidence })).resolves.toEqual({
      answer: "Rotate the token first.",
      citations: ["memory-a"],
    });
    expect(reasoner.descriptor).toEqual({ id: "http-model:reasoner-1", kind: "model" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://reasoning.internal/v1/answer");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer provider-token");
    expect(JSON.parse(init.body as string)).toMatchObject({
      model: "reasoner-1",
      evidence: [{ memoryId: "memory-a" }],
      constraints: { citeOnlyMemoryIds: ["memory-a"], maxAnswerCharacters: 20_000 },
    });
  });

  it("rejects invalid model-provider configuration and responses", async () => {
    expect(() => new HttpModelReasoner({ url: "file:///tmp/reasoner", model: "model" }))
      .toThrow(/HTTP or HTTPS/);
    const provider = new HttpModelReasoner({
      url: "https://reasoning.internal/v1/answer",
      model: "model",
      fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ answer: "uncited" }), { status: 200 })) as unknown as typeof fetch,
    });
    await expect(provider.answer({ question: "Question", evidence })).rejects.toThrow();
  });
});
