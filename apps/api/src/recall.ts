import {
  LocalLexicalMemoryRanker as SdkLexicalMemoryRanker,
  type MemoryRanker,
  type MemoryRankingRequest,
} from "@_89/fold-sdk";
import type { SemanticMemoryCandidate } from "@_89/fold-epistemic";

/** Question scaffolding never counts as lexical evidence that a memory is relevant. */
const QUERY_STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "by", "can", "could",
  "did", "do", "does", "for", "from", "had", "has", "have", "how", "i", "in",
  "is", "it", "its", "know", "me", "of", "on", "or", "our", "please", "s",
  "should", "tell", "that", "the", "their", "them", "there", "these", "they",
  "this", "to", "us", "was", "we", "were", "what", "when", "where", "which",
  "who", "why", "will", "with", "would", "you", "your", "about",
]);

function tokens(value: string): string[] {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * The shared SDK BM25 ranker with query stop-word removal. Tokenization matches the SDK ranker,
 * so the filtered query yields exactly the remaining query terms.
 */
export class LocalLexicalMemoryRanker implements MemoryRanker {
  readonly descriptor = { id: "local-bm25-v2", kind: "lexical" } as const;
  private readonly inner = new SdkLexicalMemoryRanker();

  async rank(request: MemoryRankingRequest): Promise<readonly SemanticMemoryCandidate[]> {
    const queryTokens = [...new Set(tokens(request.query).filter((token) => !QUERY_STOP_WORDS.has(token)))];
    if (queryTokens.length === 0 || request.documents.length === 0) return [];
    return this.inner.rank({ ...request, query: queryTokens.join(" ") });
  }
}
