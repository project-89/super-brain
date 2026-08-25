import type {
  MemoryRanker,
  MemoryRankingDocument,
  MemoryRankingRequest,
} from "@_89/fold-sdk";
import type { SemanticMemoryCandidate } from "@_89/fold-epistemic";

const BM25_K1 = 1.2;
const BM25_B = 0.75;

function tokens(value: string): string[] {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? [];
}

function documentText(document: MemoryRankingDocument): string {
  return [
    document.summary,
    document.summary,
    document.source,
    ...document.tags,
    ...document.tags,
    ...document.entities.flatMap((entity) => [entity.name, entity.name, entity.type]),
    JSON.stringify(document.content),
  ].join(" ");
}

interface ScoredDocument {
  readonly memoryId: string;
  readonly rawScore: number;
  readonly updatedAt: number;
}

export class LocalLexicalMemoryRanker implements MemoryRanker {
  readonly descriptor = { id: "local-bm25-v1", kind: "lexical" } as const;

  async rank(request: MemoryRankingRequest): Promise<readonly SemanticMemoryCandidate[]> {
    const queryTokens = [...new Set(tokens(request.query))];
    if (queryTokens.length === 0 || request.documents.length === 0) return [];

    const documentTokens = request.documents.map((document) => tokens(documentText(document)));
    const averageLength = Math.max(
      1,
      documentTokens.reduce((sum, values) => sum + values.length, 0) / documentTokens.length,
    );
    const documentFrequency = new Map<string, number>();
    for (const values of documentTokens) {
      const present = new Set(values);
      for (const token of queryTokens) {
        if (present.has(token)) documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
      }
    }

    const scored: ScoredDocument[] = request.documents.flatMap((document, index) => {
      const values = documentTokens[index]!;
      const frequency = new Map<string, number>();
      for (const value of values) frequency.set(value, (frequency.get(value) ?? 0) + 1);
      let rawScore = 0;
      for (const token of queryTokens) {
        const count = frequency.get(token) ?? 0;
        if (count === 0) continue;
        const containing = documentFrequency.get(token) ?? 0;
        const inverseFrequency = Math.log(
          1 + (request.documents.length - containing + 0.5) / (containing + 0.5),
        );
        const lengthAdjustment = BM25_K1 * (
          1 - BM25_B + BM25_B * (values.length / averageLength)
        );
        rawScore += inverseFrequency * (count * (BM25_K1 + 1)) / (count + lengthAdjustment);
      }
      return rawScore === 0 ? [] : [{ memoryId: document.memoryId, rawScore, updatedAt: document.updatedAt }];
    });
    scored.sort(
      (left, right) =>
        right.rawScore - left.rawScore ||
        right.updatedAt - left.updatedAt ||
        left.memoryId.localeCompare(right.memoryId),
    );
    const maximum = scored[0]?.rawScore ?? 1;
    return scored.slice(0, request.limit).map(({ memoryId, rawScore }) => ({
      memoryId,
      score: rawScore / maximum,
    }));
  }
}
