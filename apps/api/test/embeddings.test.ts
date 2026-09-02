import { describe, expect, it, vi } from "vitest";

import { HttpMemoryEmbeddingProvider } from "../src/index.js";

describe("HTTP memory embedding provider", () => {
  it("sends bounded provider requests and validates vector dimensions", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ embeddings: [[1, 0, 0]] }), { status: 200 })) as unknown as typeof fetch;
    const provider = new HttpMemoryEmbeddingProvider({
      url: "http://embedding.internal/v1/embed",
      model: "local-model-v1",
      dimensions: 3,
      token: "secret",
      fetch: fetchMock,
    });
    await expect(provider.embed(["Postgres is canonical"])).resolves.toEqual([[1, 0, 0]]);
    const [, init] = (fetchMock as any).mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer secret");
    expect(JSON.parse(String(init.body))).toEqual({ model: "local-model-v1", inputs: ["Postgres is canonical"] });
  });

  it("rejects malformed provider output", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ embeddings: [[1, 0]] }), { status: 200 })) as unknown as typeof fetch;
    const provider = new HttpMemoryEmbeddingProvider({ url: "http://embedding.internal/embed", model: "model", dimensions: 3, fetch: fetchMock });
    await expect(provider.embed(["text"])).rejects.toThrow();
  });
});
