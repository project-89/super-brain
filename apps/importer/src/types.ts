import type { TranscriptImportBundle, TranscriptSource } from "@_89/fold-transcript";

export interface ParsedTranscript {
  readonly sourcePath: string;
  readonly bundle: TranscriptImportBundle;
  readonly diagnostics?: TranscriptParserDiagnostics;
  readonly archiveInput?: { readonly kind: "json" } | { readonly kind: "hermes-sqlite"; readonly sessionId: string };
}

export interface TranscriptParserDiagnostics {
  readonly recordTypes: Readonly<Record<string, number>>;
  readonly unknownRecordTypes: Readonly<Record<string, number>>;
  readonly toolResults: Readonly<Record<"completed" | "failed" | "unknown", number>>;
}

export interface TranscriptSourceRoots {
  readonly claude?: string;
  readonly codex?: string;
  readonly codexArchived?: string;
  readonly gemini?: string;
  readonly hermes?: string;
  readonly hermesDatabase?: string;
}

export interface ScanFailure {
  readonly source: TranscriptSource;
  readonly sourcePath: string;
  readonly error: string;
}

export interface TranscriptScanReport {
  readonly discoveredFiles: number;
  readonly parsedFiles: number;
  readonly totalBytes: number;
  readonly projects: number;
  readonly runs: number;
  readonly turns: number;
  readonly actions: number;
  readonly unknownRecords: number;
  readonly bySource: Readonly<Record<TranscriptSource, { readonly files: number; readonly bytes: number }>>;
  readonly failures: readonly ScanFailure[];
  readonly transcripts: readonly ParsedTranscript[];
  readonly diagnostics: Readonly<Record<TranscriptSource, TranscriptParserDiagnostics>>;
}
