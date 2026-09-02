import { z } from "zod";

import type { MemoryEmbeddingProvider } from "@_89/fold-sdk";

export interface HttpMemoryEmbeddingProviderOptions {
  readonly url: string;
  readonly model: string;
  readonly dimensions: number;
  readonly token?: string;
  readonly fetch?: typeof fetch;
}

export class HttpMemoryEmbeddingProvider implements MemoryEmbeddingProvider {
  readonly descriptor: { readonly id: string; readonly dimensions: number };
  private readonly url: string;
  private readonly model: string;
  private readonly token: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpMemoryEmbeddingProviderOptions) {
    const parsed = new URL(options.url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new TypeError("embedding provider URL must use HTTP or HTTPS");
    }
    if (options.model.trim().length === 0) throw new TypeError("embedding model is required");
    if (!Number.isInteger(options.dimensions) || options.dimensions < 1 || options.dimensions > 16_000) {
      throw new TypeError("embedding dimensions must be an integer within [1, 16000]");
    }
    this.url = parsed.toString();
    this.model = options.model;
    this.token = options.token;
    this.fetchImpl = options.fetch ?? fetch;
    this.descriptor = { id: `http:${options.model}`, dimensions: options.dimensions };
  }

  async embed(inputs: readonly string[]): Promise<readonly (readonly number[])[]> {
    if (inputs.length === 0) return [];
    const headers = new Headers({ "content-type": "application/json" });
    if (this.token !== undefined) headers.set("authorization", `Bearer ${this.token}`);
    const response = await this.fetchImpl(this.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: this.model, inputs }),
    });
    if (!response.ok) throw new Error(`embedding provider failed with HTTP ${response.status}`);
    const schema = z.object({
      embeddings: z.array(z.array(z.number().finite()).length(this.descriptor.dimensions)).length(inputs.length),
    }).strict();
    return schema.parse(await response.json()).embeddings;
  }
}
