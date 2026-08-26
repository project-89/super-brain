import { stat } from "node:fs/promises";

import type { TranscriptSource } from "@_89/fold-transcript";

import { parseClaudeTranscript, parseCodexTranscript } from "./adapters.js";
import { discoverJsonlFiles } from "./files.js";
import type {
  ParsedTranscript,
  TranscriptScanReport,
  TranscriptSourceRoots,
} from "./types.js";

export interface ScanTranscriptOptions {
  readonly roots: TranscriptSourceRoots;
  readonly limit?: number;
}

export async function scanTranscripts(options: ScanTranscriptOptions): Promise<TranscriptScanReport> {
  if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1)) {
    throw new TypeError("scan limit must be a positive integer");
  }
  const candidates: { readonly source: TranscriptSource; readonly path: string }[] = [];
  for (const [source, root] of [
    ["claude-code", options.roots.claude],
    ["codex", options.roots.codex],
  ] as const) {
    if (root === undefined) continue;
    for (const path of await discoverJsonlFiles(root)) candidates.push({ source, path });
  }
  const selected = options.limit === undefined ? candidates : candidates.slice(0, options.limit);
  const bySource = {
    "claude-code": { files: 0, bytes: 0 },
    codex: { files: 0, bytes: 0 },
  };
  const failures: { source: TranscriptSource; sourcePath: string; error: string }[] = [];
  const byRun = new Map<string, ParsedTranscript>();
  let totalBytes = 0;
  for (const candidate of selected) {
    try {
      const bytes = (await stat(candidate.path)).size;
      totalBytes += bytes;
      bySource[candidate.source].files += 1;
      bySource[candidate.source].bytes += bytes;
      const transcript = candidate.source === "claude-code"
        ? await parseClaudeTranscript(candidate.path)
        : await parseCodexTranscript(candidate.path);
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
  };
}
