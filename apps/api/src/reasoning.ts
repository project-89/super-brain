import type { JsonValue } from "@_89/fold";
import type { SteeringSnapshot } from "@_89/fold-sdk";

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
