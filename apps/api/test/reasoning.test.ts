import { describe, expect, it, vi } from "vitest";

import {
  GeminiReasoner,
  LocalEvidenceReasoner,
  HttpModelReasoner,
  ReasoningProviderCatalog,
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
  it("binds provider configuration without secrets and cancels the upstream HTTP request", async () => {
    const config = { url: "https://reasoning.internal/answer", model: "reasoner-1" };
    const first = new HttpModelReasoner({ ...config, token: "first-secret" });
    expect(first.descriptor.configRevision).toBe(new HttpModelReasoner({ ...config, token: "rotated-secret" }).descriptor.configRevision);
    expect(first.descriptor.configRevision).not.toBe(new HttpModelReasoner({ ...config, url: "https://other.internal/answer" }).descriptor.configRevision);
    expect(first.descriptor.configRevision).not.toContain("secret");
    let cancelled = false;
    const reasoner = new HttpModelReasoner({ ...config, fetch: async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => { cancelled = true; reject(init!.signal!.reason); }, { once: true });
    }) });
    const controller = new AbortController();
    const request = reasoner.answer({ question: "Slow request", evidence, signal: controller.signal });
    controller.abort(new Error("Caller stopped"));
    await expect(request).rejects.toThrow("Caller stopped");
    expect(cancelled).toBe(true);
  });

  it("returns an explicitly extractive answer with authorized citations", async () => {
    const reasoner = new LocalEvidenceReasoner();
    expect(await reasoner.answer({ question: "How did refresh recover?", evidence })).toEqual({
      answer: "Relevant evidence: Rotate the access token before retrying.",
      citations: ["memory-a"],
    });
    expect(reasoner.descriptor).toMatchObject({ id: "local-evidence-v1", kind: "extractive", provider: "local" });
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
    expect(reasoner.descriptor).toMatchObject({ id: "http-model:reasoner-1", kind: "model", provider: "custom", model: "reasoner-1" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://reasoning.internal/v1/answer");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer provider-token");
    expect(JSON.parse(init.body as string)).toMatchObject({
      model: "reasoner-1",
      evidence: [{ memoryId: "memory-a" }],
      constraints: { citeOnlyMemoryIds: ["memory-a"], maxAnswerCharacters: 20_000 },
    });
  });

  it("calls Gemini structured generation and catalogs it as the default", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify({ answer: "Rotate it.", citations: ["memory-a"] }) }] } }],
    }), { status: 200 }));
    const gemini = new GeminiReasoner({ apiKey: "google-key", model: "gemini-fast", fetch: fetchMock as unknown as typeof fetch });
    await expect(gemini.answer({ question: "What now?", evidence })).resolves.toEqual({ answer: "Rotate it.", citations: ["memory-a"] });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain("gemini-fast:generateContent");
    expect(new Headers(init.headers).get("x-goog-api-key")).toBe("google-key");
    expect(JSON.parse(init.body as string)).toMatchObject({ generationConfig: { responseMimeType: "application/json" } });
    const local = new LocalEvidenceReasoner();
    const catalog = new ReasoningProviderCatalog({ providers: [gemini, local], defaultProvider: "gemini" });
    expect(catalog.provider()).toBe(gemini);
    expect(catalog.statuses[0]).toMatchObject({ provider: "gemini", configured: true, isDefault: true });
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
