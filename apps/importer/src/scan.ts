import { stat } from "node:fs/promises";

import type { TranscriptSource } from "@_89/fold-transcript";

import { parseClaudeTranscript, parseCodexTranscript } from "./adapters.js";
import { discoverJsonlFiles } from "./files.js";
import { hermesSessionIds, parseNativeArchive } from "./native-archives.js";
import type {
  ParsedTranscript,
  TranscriptScanReport,
  TranscriptSourceRoots,
  TranscriptParserDiagnostics,
} from "./types.js";

export interface ScanTranscriptOptions {
  readonly roots: TranscriptSourceRoots;
  readonly limit?: number;
}

export async function scanTranscripts(options: ScanTranscriptOptions): Promise<TranscriptScanReport> {
  if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1)) {
    throw new TypeError("scan limit must be a positive integer");
  }
  const candidates: { readonly source: TranscriptSource; readonly path: string; readonly sessionId?: string }[] = [];
  for (const [source, root] of [
    ["claude-code", options.roots.claude],
    ["codex", options.roots.codex],
    ["codex", options.roots.codexArchived],
    ["gemini", options.roots.gemini],
    ["hermes", options.roots.hermes],
  ] as const) {
    if (root === undefined) continue;
    let paths: readonly string[];
    try {
      paths = await discoverJsonlFiles(root, (name) => source === "gemini" ? /^session-.*\.jsonl?$/.test(name)
        : source === "hermes" ? /^session_.*\.json$/.test(name) : name.endsWith(".jsonl"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const path of paths) candidates.push({ source, path });
  }
  if (options.roots.hermesDatabase !== undefined) {
    try {
      await stat(options.roots.hermesDatabase);
      for (const sessionId of hermesSessionIds(options.roots.hermesDatabase)) candidates.push({ source: "hermes", path: options.roots.hermesDatabase, sessionId });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const selected = options.limit === undefined ? candidates : candidates.slice(0, options.limit);
  const bySource = {
    "claude-code": { files: 0, bytes: 0 },
    codex: { files: 0, bytes: 0 },
    gemini: { files: 0, bytes: 0 },
    hermes: { files: 0, bytes: 0 },
  };
  const failures: { source: TranscriptSource; sourcePath: string; error: string }[] = [];
  const byRun = new Map<string, ParsedTranscript>();
  let totalBytes = 0;
  for (const candidate of selected) {
    try {
      const transcript = candidate.source === "claude-code"
        ? await parseClaudeTranscript(candidate.path)
        : candidate.source === "codex" ? await parseCodexTranscript(candidate.path)
        : await parseNativeArchive(candidate.path, candidate.source, candidate.sessionId);
      const bytes = transcript.bundle.artifact.byteLength;
      totalBytes += bytes;
      bySource[candidate.source].files += 1;
      bySource[candidate.source].bytes += bytes;
      const existing = byRun.get(transcript.bundle.run.id);
      if (existing === undefined || existing.bundle.run.counts.records < transcript.bundle.run.counts.records) {
        byRun.set(transcript.bundle.run.id, transcript);
      }
    } catch (error) {
      failures.push({
        source: candidate.source,
        sourcePath: candidate.path,
        error: error instanceof Error ? error.message : "Unknown transcript parse error",
      });
    }
  }
  const transcripts = [...byRun.values()].sort((left, right) =>
    (left.bundle.run.startedAt ?? left.bundle.run.id).localeCompare(right.bundle.run.startedAt ?? right.bundle.run.id),
  );
  const projectIds = new Set(transcripts.flatMap(({ bundle }) => bundle.projects.map(({ id }) => id)));
  const diagnostics = Object.fromEntries((["claude-code", "codex", "gemini", "hermes"] as const).map((source) => {
    const recordTypes = new Map<string, number>();
    const unknownRecordTypes = new Map<string, number>();
    const toolResults = { completed: 0, failed: 0, unknown: 0 };
    for (const transcript of transcripts.filter(({ bundle }) => bundle.run.source === source)) {
      for (const [key, value] of Object.entries(transcript.diagnostics?.recordTypes ?? {})) recordTypes.set(key, (recordTypes.get(key) ?? 0) + value);
      for (const [key, value] of Object.entries(transcript.diagnostics?.unknownRecordTypes ?? {})) unknownRecordTypes.set(key, (unknownRecordTypes.get(key) ?? 0) + value);
      for (const status of ["completed", "failed", "unknown"] as const) toolResults[status] += transcript.diagnostics?.toolResults[status] ?? 0;
    }
    return [source, { recordTypes: Object.fromEntries([...recordTypes].sort()), unknownRecordTypes: Object.fromEntries([...unknownRecordTypes].sort()), toolResults }];
  })) as Record<TranscriptSource, TranscriptParserDiagnostics>;
  return {
    discoveredFiles: selected.length,
    parsedFiles: transcripts.length,
    totalBytes,
    projects: projectIds.size,
    runs: transcripts.length,
    turns: transcripts.reduce((sum, { bundle }) => sum + bundle.run.counts.turns, 0),
    actions: transcripts.reduce((sum, { bundle }) => sum + bundle.run.counts.actions, 0),
    unknownRecords: transcripts.reduce((sum, { bundle }) => sum + bundle.run.counts.unknown, 0),
    bySource,
    failures,
    transcripts,
    diagnostics,
  };
}
