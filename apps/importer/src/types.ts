import type { TranscriptImportBundle, TranscriptSource } from "@_89/fold-transcript";

export interface ParsedTranscript {
  readonly sourcePath: string;
  readonly bundle: TranscriptImportBundle;
}

export interface TranscriptSourceRoots {
  readonly claude?: string;
  readonly codex?: string;
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
}
