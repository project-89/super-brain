import type { MemoryCandidateInput } from "@_89/fold-epistemic";
import type { TranscriptRun, TranscriptSource } from "@_89/fold-transcript";

export interface VaultMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly turnId: string;
  readonly at?: string;
  readonly projectPath?: string;
}

export interface ExtractedCandidate extends Omit<MemoryCandidateInput, "audience" | "spaceId"> {}

export interface RunExtraction {
  readonly run: TranscriptRun;
  readonly source: TranscriptSource;
  readonly candidates: readonly ExtractedCandidate[];
  readonly skippedReason?: string;
}
