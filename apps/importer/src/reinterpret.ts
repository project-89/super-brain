import { createHash } from "node:crypto";
import { transcriptImportBundleSchema, type TranscriptImportBundle } from "@_89/fold-transcript";
import { TranscriptBuilder } from "./builder.js";
import { NativeTranscriptNormalizer } from "./native.js";
import { visitStoredTranscriptArtifact } from "./stored.js";

interface RecordRange { readonly start: number; readonly end: number }
export interface TranscriptReinterpretationReport {
  readonly recomputed: boolean;
  readonly previousRunId: string;
  readonly runId: string;
  readonly sourceOccurrenceId: string;
  readonly sourceArtifactId: string;
  readonly parser: { readonly id: string; readonly version: string };
  readonly storedRecords: number;
  readonly unavailableOriginalRecords: number;
  readonly integrity?: "verified" | "legacy-unverified";
  readonly localStoredSha256?: string;
  readonly previousCounts: TranscriptImportBundle["run"]["counts"];
  readonly recomputedCounts: TranscriptImportBundle["run"]["counts"];
  readonly turnCorrespondence: readonly { readonly previousTurnId: string; readonly turnIds: readonly string[]; readonly recordRanges: readonly RecordRange[] }[];
}
function ranges(ordinals: readonly number[]): RecordRange[] {
  const result: Array<{ start: number; end: number }> = [];
  for (const value of [...new Set(ordinals)].sort((a, b) => a - b)) {
    const previous = result.at(-1);
    if (previous !== undefined && previous.end + 1 === value) previous.end = value;
    else result.push({ start: value, end: value });
  }
  return result;
}

/** Explicit new interpretation of immutable stored records; existing IDs, bytes and privacy projections stay intact. */
export async function reinterpretStoredTranscript(previousInput: TranscriptImportBundle, options: {
  readonly vaultRoot: string;
  readonly parserVersion: "2";
  readonly encryptionKey?: Uint8Array;
  readonly maxBytes?: number;
}): Promise<{ readonly bundle: TranscriptImportBundle; readonly report: TranscriptReinterpretationReport }> {
  const previous = transcriptImportBundleSchema.parse(previousInput);
  const oldVersion = previous.artifact.parser.version;
  if (oldVersion !== "1" && oldVersion !== "2") throw new TypeError("unsupported-previous-parser");
  if (options.parserVersion !== "2") throw new TypeError("unsupported-target-parser");
  const expectedParser = previous.run.source === "codex" ? "codex-jsonl" : "claude-jsonl";
  if (previous.artifact.parser.id !== expectedParser) throw new TypeError("unsupported-previous-parser");
  const sourceOccurrenceId = previous.run.interpretation?.sourceOccurrenceId ?? previous.artifact.id;
  const sourceArtifactId = previous.run.interpretation?.sourceArtifactId ?? previous.artifact.id;
  const parser = { id: expectedParser, version: options.parserVersion };
  if (oldVersion === options.parserVersion) return { bundle: previous, report: {
    recomputed: false, previousRunId: previous.run.id, runId: previous.run.id, sourceOccurrenceId, sourceArtifactId, parser,
    storedRecords: 0, unavailableOriginalRecords: 0, previousCounts: previous.run.counts, recomputedCounts: previous.run.counts, turnCorrespondence: [],
  } };
  if (!previous.artifact.stored || previous.artifact.contentPolicy !== "redacted") throw new TypeError("immutable-vault-unavailable");
  const digest = createHash("sha256").update(JSON.stringify([previous.run.id, sourceOccurrenceId, parser])).digest("hex");
  const runId = `interpretation-${digest}`;
  const artifact = { ...previous.artifact, id: `artifact-interpretation-${digest}`, parser };
  const builder = new TranscriptBuilder(previous.run.source, previous.run.nativeId);
  const oldDecoder = new NativeTranscriptNormalizer(previous.run.source, previous.run.nativeId, { parserVersion: oldVersion });
  const decoder = new NativeTranscriptNormalizer(previous.run.source, previous.run.nativeId, { parserVersion: options.parserVersion });
  const originalTurns = new Map(previous.chunks.flatMap(({ turns }) => turns).map((turn) => [turn.ordinal, turn]));
  const seenOriginalTurns = new Set<number>();
  const origins = new Map<number, number[]>();
  const correspondence = new Map<string, { next: Set<number>; records: number[] }>();
  const read = await visitStoredTranscriptArtifact({ ...options, artifact: previous.artifact, onRecord(record, ordinal) {
    const old = oldDecoder.push(record);
    const next = decoder.push(record);
    builder.consume(next);
    if (next.turn !== undefined) { const list = origins.get(next.turn.ordinal) ?? []; list.push(ordinal); origins.set(next.turn.ordinal, list); }
    if (old.turn !== undefined) {
      const original = originalTurns.get(old.turn.ordinal);
      if (original === undefined) throw new TypeError("previous-turn-origin-unavailable");
      seenOriginalTurns.add(original.ordinal);
      const mapping = correspondence.get(original.id) ?? { next: new Set<number>(), records: [] };
      if (next.turn !== undefined) mapping.next.add(next.turn.ordinal);
      mapping.records.push(ordinal); correspondence.set(original.id, mapping);
    }
  } });
  if (read.status !== "ready") throw new TypeError(`reinterpretation-${read.reason}`);
  if ([...originalTurns.keys()].some((ordinal) => !seenOriginalTurns.has(ordinal))) throw new TypeError("previous-turn-origin-unavailable");
  const interpreted = builder.finish(artifact);
  const newTurnId = (ordinal: number) => `${runId}:turn:${ordinal}`;
  const turnIdMap = new Map(interpreted.chunks.flatMap(({ turns }) => turns).map(({ id, ordinal }) => [id, newTurnId(ordinal)]));
  const anonymous = previous.artifact.anonymizationPolicy !== undefined && previous.artifact.anonymizationPolicy !== "none";
  const publicActionNames = new Set(previous.chunks.flatMap(({ actions }) => actions).flatMap(({ name }) => name === undefined ? [] : [name]));
  const bundle = transcriptImportBundleSchema.parse({
    projects: previous.projects,
    artifact,
    run: { ...previous.run, id: runId, artifactId: artifact.id, counts: interpreted.run.counts,
      interpretation: { version: 1, sourceOccurrenceId, sourceArtifactId, previousRunId: previous.run.id, parser } },
    chunks: interpreted.chunks.map((chunk) => ({ ...chunk, runId,
      turns: chunk.turns.map(({ nativeId, ...turn }) => ({ ...turn, id: newTurnId(turn.ordinal),
        ...(!anonymous && nativeId !== undefined ? { nativeId } : {}),
        origin: { sourceOccurrenceId, recordRanges: ranges(origins.get(turn.ordinal) ?? []) } })),
      actions: chunk.actions.map(({ name, ...action }) => ({ ...action, id: `${runId}:action:${action.ordinal}`,
        ...(name !== undefined && (!anonymous || publicActionNames.has(name)) ? { name } : {}),
        ...(action.turnId === undefined ? {} : { turnId: turnIdMap.get(action.turnId)! }) })),
    })),
  });
  return { bundle, report: {
    recomputed: true, previousRunId: previous.run.id, runId, sourceOccurrenceId, sourceArtifactId, parser,
    storedRecords: read.records, unavailableOriginalRecords: Math.max(0, previous.run.counts.records - read.records),
    integrity: read.integrity, localStoredSha256: read.storedSha256,
    previousCounts: previous.run.counts, recomputedCounts: bundle.run.counts,
    turnCorrespondence: [...correspondence].map(([previousTurnId, map]) => ({ previousTurnId, turnIds: [...map.next].sort((a, b) => a - b).map(newTurnId), recordRanges: ranges(map.records) })),
  } };
}
