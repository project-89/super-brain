import { createHash } from "node:crypto";
import type { JsonValue } from "@_89/fold";
import type { SteeringSnapshot } from "@_89/fold-sdk";
import { z } from "zod";

export type ReasoningProviderKind = "extractive" | "model";

export interface ReasoningProviderDescriptor {
  readonly id: string;
  readonly kind: ReasoningProviderKind;
  readonly configRevision?: string;
  readonly provider?: "local" | "gemini" | "claude" | "codex" | "custom";
  readonly model?: string;
}

export interface ReasoningProviderStatus extends ReasoningProviderDescriptor {
  readonly configured: boolean;
  readonly isDefault: boolean;
}

export interface ReasoningEvidence {
  readonly memoryId: string;
  readonly source: string;
  readonly summary: string;
  readonly content: JsonValue;
  readonly tags: readonly string[];
  readonly score?: number;
}

export interface ReasoningProviderRequest {
  readonly question: string;
  readonly signal?: AbortSignal;
  readonly evidence: readonly ReasoningEvidence[];
  readonly steering?: SteeringSnapshot;
}

export interface ReasoningProviderResult {
  readonly answer: string;
  readonly citations: readonly string[];
}

export interface ReasoningProvider {
  readonly descriptor: ReasoningProviderDescriptor;
  answer(request: ReasoningProviderRequest): Promise<ReasoningProviderResult>;
}

function compactText(value: JsonValue): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.replace(/\s+/g, " ").trim();
}

export class LocalEvidenceReasoner implements ReasoningProvider {
  readonly descriptor = { configRevision: "local-evidence-v1:exact-revisions-v2", id: "local-evidence-v1", kind: "extractive", provider: "local" } as const;

  async answer(request: ReasoningProviderRequest): Promise<ReasoningProviderResult> {
    const evidence = request.evidence.slice(0, 3);
    const statements = evidence.map((item) => {
      const fallback = compactText(item.content).slice(0, 240);
      return item.summary.trim() || fallback || `Memory ${item.memoryId}`;
    });
    const active = request.steering?.intentions[0];
    if (statements.length === 0 && active === undefined) {
      return {
        answer: "No relevant authorized memory or active intention was found.",
        citations: [],
      };
    }
    return {
      answer: [
        ...(statements.length === 0 ? [] : [`Relevant evidence: ${statements.join("; ")}.`]),
        ...(active === undefined ? [] : [`Active intention: ${active.aim}.`]),
      ].join(" "),
      citations: evidence.map(({ memoryId }) => memoryId),
    };
  }
}

const resultSchema = z.object({ answer: z.string(), citations: z.array(z.string()) }).strict();
const resultJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["answer", "citations"],
  properties: {
    answer: { type: "string" },
    citations: { type: "array", items: { type: "string" } },
  },
} as const;

function modelPrompt(request: ReasoningProviderRequest): string {
  return JSON.stringify({
    task: "Answer the question using only the supplied authorized memory evidence and optional steering state.",
    question: request.question,
    evidence: request.evidence,
    ...(request.steering === undefined ? {} : { steering: request.steering }),
    constraints: {
      output: { answer: "string", citations: "unique memoryId strings used by the answer" },
      citeOnlyMemoryIds: request.evidence.map(({ memoryId }) => memoryId),
      noUnsupportedClaims: true,
    },
  });
}

function parsedModelResult(text: string): ReasoningProviderResult {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return resultSchema.parse(JSON.parse(trimmed));
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) throw new TypeError("reasoning provider returned invalid structured output");
    return resultSchema.parse(JSON.parse(trimmed.slice(start, end + 1)));
  }
}

async function providerFailure(response: Response, provider: string): Promise<never> {
  const detail = (await response.text()).replace(/\s+/g, " ").slice(0, 1_000);
  throw new Error(`${provider} reasoning failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
}

interface NativeReasonerOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
}

abstract class NativeModelReasoner implements ReasoningProvider {
  abstract readonly descriptor: ReasoningProviderDescriptor;
  abstract answer(request: ReasoningProviderRequest): Promise<ReasoningProviderResult>;
  protected readonly apiKey: string;
  protected readonly model: string;
  protected readonly timeoutMs: number;
  protected readonly fetchImpl: typeof fetch;

  constructor(options: NativeReasonerOptions) {
    this.apiKey = options.apiKey.trim();
    this.model = options.model.trim();
    if (!this.apiKey || !this.model) throw new TypeError("reasoning provider API key and model are required");
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.fetchImpl = options.fetch ?? fetch;
  }
}

export class GeminiReasoner extends NativeModelReasoner {
  readonly descriptor: ReasoningProviderDescriptor;
  constructor(options: NativeReasonerOptions) {
    super(options);
    this.descriptor = { configRevision: createHash("sha256").update(JSON.stringify(["memory-answer-v2", "gemini", this.model, this.timeoutMs])).digest("hex"), id: `gemini:${this.model}`, kind: "model", provider: "gemini", model: this.model };
  }

  async answer(request: ReasoningProviderRequest): Promise<ReasoningProviderResult> {
    const response = await this.fetchImpl(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
        signal: request.signal === undefined ? AbortSignal.timeout(this.timeoutMs) : AbortSignal.any([request.signal, AbortSignal.timeout(this.timeoutMs)]),
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: modelPrompt(request) }] }],
          generationConfig: { responseMimeType: "application/json", responseJsonSchema: resultJsonSchema },
        }),
      },
    );
    if (!response.ok) return providerFailure(response, "Gemini");
    const body = await response.json() as { candidates?: readonly { content?: { parts?: readonly { text?: string }[] } }[] };
    const text = body.candidates?.flatMap(({ content }) => content?.parts ?? []).map((part) => part.text ?? "").join("") ?? "";
    return parsedModelResult(text);
  }
}

export class CodexReasoner extends NativeModelReasoner {
  readonly descriptor: ReasoningProviderDescriptor;
  constructor(options: NativeReasonerOptions) {
    super(options);
    this.descriptor = { configRevision: createHash("sha256").update(JSON.stringify(["memory-answer-v2", "codex", this.model, this.timeoutMs])).digest("hex"), id: `codex:${this.model}`, kind: "model", provider: "codex", model: this.model };
  }

  async answer(request: ReasoningProviderRequest): Promise<ReasoningProviderResult> {
    const response = await this.fetchImpl("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "authorization": `Bearer ${this.apiKey}`, "content-type": "application/json" },
      signal: request.signal === undefined ? AbortSignal.timeout(this.timeoutMs) : AbortSignal.any([request.signal, AbortSignal.timeout(this.timeoutMs)]),
      body: JSON.stringify({
        model: this.model,
        input: modelPrompt(request),
        text: { format: { type: "json_schema", name: "memory_answer", strict: true, schema: resultJsonSchema } },
      }),
    });
    if (!response.ok) return providerFailure(response, "Codex");
    const body = await response.json() as {
      output_text?: string;
      output?: readonly { content?: readonly { type?: string; text?: string }[] }[];
    };
    const text = body.output_text ?? body.output?.flatMap(({ content }) => content ?? []).map((item) => item.text ?? "").join("") ?? "";
    return parsedModelResult(text);
  }
}

export class ClaudeReasoner extends NativeModelReasoner {
  readonly descriptor: ReasoningProviderDescriptor;
  constructor(options: NativeReasonerOptions) {
    super(options);
    this.descriptor = { configRevision: createHash("sha256").update(JSON.stringify(["memory-answer-v2", "claude", this.model, this.timeoutMs])).digest("hex"), id: `claude:${this.model}`, kind: "model", provider: "claude", model: this.model };
  }

  async answer(request: ReasoningProviderRequest): Promise<ReasoningProviderResult> {
    const response = await this.fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "anthropic-version": "2023-06-01", "content-type": "application/json", "x-api-key": this.apiKey },
      signal: request.signal === undefined ? AbortSignal.timeout(this.timeoutMs) : AbortSignal.any([request.signal, AbortSignal.timeout(this.timeoutMs)]),
      body: JSON.stringify({
        model: this.model,
        max_tokens: 4_096,
        system: "Return only a JSON object matching the requested output contract.",
        messages: [{ role: "user", content: modelPrompt(request) }],
      }),
    });
    if (!response.ok) return providerFailure(response, "Claude");
    const body = await response.json() as { content?: readonly { type?: string; text?: string }[] };
    return parsedModelResult(body.content?.map((item) => item.text ?? "").join("") ?? "");
  }
}

export class ReasoningProviderCatalog {
  private readonly providers: ReadonlyMap<string, ReasoningProvider>;
  readonly statuses: readonly ReasoningProviderStatus[];
  readonly defaultId: string;

  constructor(options: {
    readonly providers: readonly ReasoningProvider[];
    readonly known?: readonly ReasoningProviderDescriptor[];
    readonly defaultProvider?: string;
  }) {
    if (options.providers.length === 0) throw new TypeError("at least one reasoning provider is required");
    this.providers = new Map(options.providers.map((provider) => [provider.descriptor.id, provider]));
    const requested = options.defaultProvider;
    this.defaultId = options.providers.find(({ descriptor }) => descriptor.id === requested || descriptor.provider === requested)?.descriptor.id
      ?? options.providers[0]!.descriptor.id;
    const known = options.known ?? options.providers.map(({ descriptor }) => descriptor);
    this.statuses = known.map((descriptor) => ({
      ...descriptor,
      configured: this.providers.has(descriptor.id),
      isDefault: descriptor.id === this.defaultId,
    }));
  }

  provider(id?: string): ReasoningProvider {
    const provider = this.providers.get(id ?? this.defaultId);
    if (provider === undefined) throw new TypeError(`reasoning provider is unavailable: ${id}`);
    return provider;
  }
}

export interface HttpModelReasonerOptions {
  readonly url: string;
  readonly model: string;
  readonly token?: string;
  readonly timeoutMs?: number;
  readonly maxEvidence?: number;
  readonly maxInputCharacters?: number;
  readonly fetch?: typeof fetch;
}

export class HttpModelReasoner implements ReasoningProvider {
  readonly descriptor: ReasoningProviderDescriptor;
  private readonly url: string;
  private readonly model: string;
  private readonly token: string | undefined;
  private readonly timeoutMs: number;
  private readonly maxEvidence: number;
  private readonly maxInputCharacters: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpModelReasonerOptions) {
    const url = new URL(options.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new TypeError("reasoning provider URL must use HTTP or HTTPS");
    }
    this.url = url.toString();
    this.model = options.model.trim();
    if (this.model.length === 0) throw new TypeError("reasoning provider model is required");
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxEvidence = options.maxEvidence ?? 10;
    this.maxInputCharacters = options.maxInputCharacters ?? 50_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 300_000) {
      throw new TypeError("reasoning provider timeout must be an integer within [100, 300000]");
    }
    if (!Number.isInteger(this.maxEvidence) || this.maxEvidence < 1 || this.maxEvidence > 100) {
      throw new TypeError("reasoning provider evidence limit must be an integer within [1, 100]");
    }
    if (!Number.isInteger(this.maxInputCharacters) || this.maxInputCharacters < 1_000 || this.maxInputCharacters > 1_000_000) {
      throw new TypeError("reasoning provider input budget must be an integer within [1000, 1000000]");
    }
    this.fetchImpl = options.fetch ?? fetch;
    this.descriptor = { configRevision: createHash("sha256").update(JSON.stringify(["memory-answer-v2", this.url, this.model, this.timeoutMs, this.maxEvidence, this.maxInputCharacters])).digest("hex"), id: `http-model:${this.model}`, kind: "model", provider: "custom", model: this.model };
  }

  async answer(request: ReasoningProviderRequest): Promise<ReasoningProviderResult> {
    const evidence: ReasoningEvidence[] = [];
    let usedCharacters = request.question.length;
    for (const candidate of request.evidence.slice(0, this.maxEvidence)) {
      const characters = candidate.summary.length + JSON.stringify(candidate.content).length +
        candidate.tags.reduce((total, tag) => total + tag.length, 0);
      if (usedCharacters + characters > this.maxInputCharacters) break;
      evidence.push(candidate);
      usedCharacters += characters;
    }
    const headers = new Headers({ "content-type": "application/json" });
    if (this.token !== undefined) headers.set("authorization", `Bearer ${this.token}`);
    const response = await this.fetchImpl(this.url, {
      method: "POST",
      headers,
      signal: request.signal === undefined ? AbortSignal.timeout(this.timeoutMs) : AbortSignal.any([request.signal, AbortSignal.timeout(this.timeoutMs)]),
      body: JSON.stringify({
        model: this.model,
        question: request.question,
        evidence,
        ...(request.steering === undefined ? {} : { steering: request.steering }),
        constraints: {
          citeOnlyMemoryIds: evidence.map(({ memoryId }) => memoryId),
          maxAnswerCharacters: 20_000,
        },
      }),
    });
    if (!response.ok) throw new Error(`reasoning provider failed with HTTP ${response.status}`);
    return z.object({
      answer: z.string(),
      citations: z.array(z.string()),
    }).strict().parse(await response.json());
  }
}

export function validateReasoningResult(
  result: ReasoningProviderResult,
  evidence: readonly ReasoningEvidence[],
): ReasoningProviderResult {
  const answer = result.answer.trim();
  if (answer.length === 0 || answer.length > 20_000) {
    throw new TypeError("reasoning provider answer must contain 1 to 20000 characters");
  }
  const available = new Set(evidence.map(({ memoryId }) => memoryId));
  const citations = [...new Set(result.citations)];
  if (citations.some((memoryId) => !available.has(memoryId))) {
    throw new TypeError("reasoning provider cited memory outside its authorized evidence");
  }
  return { answer, citations };
}
