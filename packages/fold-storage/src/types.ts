import type {
  ComponentRegistry,
  FoldLogEntry,
  FoldState,
} from "@_89/fold";

import type { FoldCheckpoint, JournalRecord } from "./records.js";

export type JournalErrorKind =
  | "blank-line"
  | "checkpoint-components-unavailable"
  | "checkpoint-mismatch"
  | "invalid-json"
  | "invalid-record"
  | "line-too-large"
  | "missing-file"
  | "torn-tail";

export class JournalError extends Error {
  override readonly name = "JournalError";

  constructor(
    message: string,
    readonly kind: JournalErrorKind,
    readonly path: string,
    readonly line?: number,
  ) {
    super(message);
  }
}

export interface JournalDiagnostic {
  readonly kind: "truncated-tail-ignored";
  readonly line: number;
  readonly byteLength: number;
}

export interface ReadJournalOptions {
  readonly tailPolicy?: "error" | "recover-truncated-tail";
  readonly missing?: "error" | "empty";
  readonly maxLineBytes?: number;
  readonly verifyCheckpoints?: boolean;
  readonly checkpointComponents?: Readonly<Record<string, ComponentRegistry>>;
}

export interface ReadJournalResult {
  readonly records: readonly JournalRecord[];
  readonly entries: readonly FoldLogEntry[];
  readonly checkpoints: readonly FoldCheckpoint[];
  readonly diagnostics: readonly JournalDiagnostic[];
}

export interface AppendOptions {
  readonly sync?: boolean;
}

export interface ReplayJournalOptions extends ReadJournalOptions {
  readonly include: "canon" | "canon+draft";
  readonly cursor?: number | { readonly t: number; readonly eventId: string };
  readonly components?: ComponentRegistry;
}

export interface ReplayJournalResult extends ReadJournalResult {
  readonly state: FoldState;
}
