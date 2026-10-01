import { createHash } from "node:crypto";
import { z } from "zod";
import type { MemoryEmbeddingProvider, MemoryEmbeddingRequestOptions } from "@_89/fold-sdk";

export interface HttpMemoryEmbeddingProviderOptions {
  readonly url: string;
  readonly model: string;
  readonly dimensions: number;
  readonly token?: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

export class HttpMemoryEmbeddingProvider implements MemoryEmbeddingProvider {
  readonly descriptor: { readonly id: string; readonly dimensions: number };
  private readonly url: string;
  private readonly model: string;
  private readonly token: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly outstanding = new Set<Promise<unknown>>();
  private readonly controllers = new Set<AbortController>();
  private closed = false;

  constructor(options: HttpMemoryEmbeddingProviderOptions) {
    const parsed = new URL(options.url);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new TypeError("embedding provider URL requires HTTP(S) without embedded credentials");
    if (!options.model.trim()) throw new TypeError("embedding model is required");
    if (!Number.isInteger(options.dimensions) || options.dimensions < 1 || options.dimensions > 16_000) throw new TypeError("embedding dimensions must be within [1,16000]");
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 16 * 1024 * 1024;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60_000 || !Number.isInteger(this.maxResponseBytes) || this.maxResponseBytes < 1 || this.maxResponseBytes > 64 * 1024 * 1024) throw new TypeError("invalid embedding deadline/body bound");
    this.url = parsed.toString(); this.model = options.model; this.token = options.token; this.fetchImpl = options.fetch ?? fetch;
    const endpoint = new URL(this.url);
    for (const key of ["token", "api_key", "api-key", "key", "access_token"]) endpoint.searchParams.delete(key);
    const configuration = createHash("sha256").update(JSON.stringify(["embedding-http-v2",endpoint.toString(),options.model,options.dimensions])).digest("hex");
    this.descriptor = { id: `http:${options.model}:${configuration}`, dimensions: options.dimensions };
  }

  async embed(inputs: readonly string[], options: MemoryEmbeddingRequestOptions = {}): Promise<readonly (readonly number[])[]> {
    if (this.closed) throw new Error("embedding provider is closed");
    options.signal?.throwIfAborted();
    if (inputs.length === 0) return [];
    if (inputs.length > 64 || this.outstanding.size >= 4) throw new Error("embedding provider capacity unavailable");
    const body = JSON.stringify({ model: this.model, inputs });
    if (Buffer.byteLength(body) > 8 * 1024 * 1024) throw new TypeError("embedding input exceeds byte limit");
    const controller = new AbortController(); this.controllers.add(controller);
    const timeout = Math.min(options.timeoutMs ?? this.timeoutMs, this.timeoutMs);
    const timer = setTimeout(() => controller.abort(new Error("embedding request timed out")), timeout);
    const cancel = () => controller.abort(options.signal?.reason); options.signal?.addEventListener("abort", cancel, { once: true });
    const headers = new Headers({ "content-type": "application/json" });
    if (this.token !== undefined) headers.set("authorization", `Bearer ${this.token}`);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const work = (async () => {
      const response = await this.fetchImpl(this.url, { method: "POST", headers, body, signal: controller.signal });
      controller.signal.throwIfAborted();
      if (!response.ok) { void response.body?.cancel().catch(() => undefined); throw new Error(`embedding provider failed with HTTP ${response.status}`); }
      const declared = Number(response.headers.get("content-length"));
      if (declared > this.maxResponseBytes) { void response.body?.cancel().catch(() => undefined); throw new TypeError("embedding response exceeds byte limit"); }
      if (response.body === null) throw new TypeError("embedding response body is unavailable");
      reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
      try {
        while (true) {
          controller.signal.throwIfAborted(); const chunk = await reader.read(); controller.signal.throwIfAborted();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > this.maxResponseBytes) { controller.abort(new Error("embedding response exceeds byte limit")); throw new TypeError("embedding response exceeds byte limit"); }
          chunks.push(chunk.value);
        }
      } finally { reader.releaseLock(); }
      const merged = new Uint8Array(bytes); let position = 0;
      for (const chunk of chunks) { merged.set(chunk,position); position += chunk.byteLength; }
      controller.signal.throwIfAborted();
      return z.object({ embeddings: z.array(z.array(z.number().finite()).length(this.descriptor.dimensions)).length(inputs.length) }).strict().parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(merged))).embeddings;
    })();
    this.outstanding.add(work);
    void work.then(() => this.outstanding.delete(work), () => this.outstanding.delete(work));
    try {
      return await new Promise((resolve,reject) => {
        const abort = () => { void reader?.cancel().catch(() => undefined); reject(controller.signal.reason ?? new Error("embedding request aborted")); };
        if (controller.signal.aborted) { abort(); return; }
        controller.signal.addEventListener("abort",abort,{once:true});
        void work.then(resolve,reject).finally(() => controller.signal.removeEventListener("abort",abort));
      });
    } finally { clearTimeout(timer); options.signal?.removeEventListener("abort",cancel); this.controllers.delete(controller); }
  }

  async close(): Promise<void> { this.closed = true; for (const controller of this.controllers) controller.abort(new Error("embedding provider closed")); }
}
