import type { JsonValue } from "@_89/fold";
import type { SteeringSnapshot } from "@_89/fold-sdk";
import { z } from "zod";

export type ReasoningProviderKind = "extractive" | "model";

export interface ReasoningProviderDescriptor {
  readonly id: string;
  readonly kind: ReasoningProviderKind;
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
  readonly descriptor = { id: "local-evidence-v1", kind: "extractive" } as const;

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
    this.descriptor = { id: `http-model:${this.model}`, kind: "model" };
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
      signal: AbortSignal.timeout(this.timeoutMs),
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
