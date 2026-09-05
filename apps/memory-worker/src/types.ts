import type { MemoryCandidateInput } from "@_89/fold-epistemic";
import type { TranscriptRun, TranscriptSource } from "@_89/fold-transcript";

export interface VaultMessage {
  readonly role: "user" | "assistant" | "tool";
  readonly text: string;
  readonly turnId: string;
  readonly at?: string;
  readonly projectPath?: string;
  readonly evidenceKind?: "message" | "tool-result";
  readonly result?: "success" | "failure" | "unknown";
  readonly nativeId?: string;
  readonly toolName?: string;
}

export interface ExtractedCandidate extends MemoryCandidateInput {}

export interface RunExtraction {
  readonly run: TranscriptRun;
  readonly source: TranscriptSource;
  readonly candidates: readonly ExtractedCandidate[];
  readonly skippedReason?: string;
}
