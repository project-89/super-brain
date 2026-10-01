import { createHash } from "node:crypto";
import { jsonValueSchema, parseEvent, type FoldEvent } from "@_89/fold";
import { z } from "zod";
import type { TranscriptEventContext, TranscriptEventStamp } from "./events.js";
import { transcriptArtifactSchema } from "./schema.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().min(1).max(500);
export const DERIVATION_NODE_KIND = "x.fold.transcript-derivation";
export const DERIVATION_CHUNK_NODE_KIND = "x.fold.transcript-derivation-chunk";

export const derivedTranscriptRecordSchema = z.object({
  ordinal: z.number().int().nonnegative(),
  line: z.number().int().positive(),
  kind: z.enum(["usage", "agent-message", "agent-link", "tool-result", "web-search"]),
  sourceType: z.string().min(1).max(220),
  data: z.record(jsonValueSchema),
  dataEncoding: z.literal("base64-json-utf8").optional(),
}).strict();

export const transcriptDerivationManifestSchema = z.object({
  runId: id,
  artifactId: id,
  sourceSha256: hash,
  inputSha256: hash,
  inputKind: z.literal("retained-policy-artifact"),
  parser: z.object({ id: z.string().min(1).max(100), version: z.string().min(1).max(100) }).strict(),
  policy: transcriptArtifactSchema.pick({ contentPolicy: true, reasoningPolicy: true, encryptedReasoningPolicy: true, anonymizationPolicy: true }),
  records: z.number().int().nonnegative(),
  sourceRecords: z.number().int().nonnegative(),
  byKind: z.record(z.number().int().nonnegative()),
  unclassifiedTypes: z.record(z.number().int().nonnegative()),
  chunkHashes: z.array(hash).max(10_000),
}).strict();

export const transcriptDerivationChunkSchema = z.object({
  runId: id,
  derivationId: hash,
  sequence: z.number().int().nonnegative(),
  records: z.array(derivedTranscriptRecordSchema).min(1).max(100),
}).strict();

export type TranscriptDerivationManifest = z.infer<typeof transcriptDerivationManifestSchema>;
export type TranscriptDerivationChunk = z.infer<typeof transcriptDerivationChunkSchema>;
export type DerivedTranscriptRecord = z.infer<typeof derivedTranscriptRecordSchema>;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]));
  return value;
}

export function derivationHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export type TranscriptDerivationRecord =
  | { readonly recordType: "derivation"; readonly derivationId: string; readonly manifest: TranscriptDerivationManifest }
  | { readonly recordType: "derivation-chunk"; readonly chunk: TranscriptDerivationChunk };

export function derivationRecordFromEvent(event: FoldEvent): TranscriptDerivationRecord | undefined {
  const declared = event.kind === "transcript.derivation-recorded" || event.kind === "transcript.derivation-chunk-recorded";
  const nodes = event.changes.filter((change) => change.verb === "create" && [DERIVATION_NODE_KIND, DERIVATION_CHUNK_NODE_KIND].includes(change.nodeKind));
  if (!declared && nodes.length === 0) return undefined;
  if (!declared || event.author.kind !== "ingest" || event.capture.identity?.source === undefined || event.changes.length !== 1 || nodes.length !== 1) throw new TypeError("Invalid transcript derivation envelope");
  const change = nodes[0]!;
  if (change.verb !== "create" || change.provenance?.basis !== "derived" || change.subject !== `urn:fold:${event.id}`) throw new TypeError("Invalid derivation change");
  if (event.kind === "transcript.derivation-recorded" && change.nodeKind === DERIVATION_NODE_KIND) {
    const manifest = transcriptDerivationManifestSchema.parse(change.after.manifest);
    const derivationId = derivationHash(manifest);
    if (change.after.recordType !== "derivation" || change.after.derivationId !== derivationId) throw new TypeError("Invalid derivation identity");
    return { recordType: "derivation", derivationId, manifest };
  }
  if (event.kind === "transcript.derivation-chunk-recorded" && change.nodeKind === DERIVATION_CHUNK_NODE_KIND && change.after.recordType === "derivation-chunk") {
    return { recordType: "derivation-chunk", chunk: transcriptDerivationChunkSchema.parse(change.after.chunk) };
  }
  throw new TypeError("Derivation kind does not match its record");
}

export function makeTranscriptDerivationEvent(context: TranscriptEventContext, stamp: TranscriptEventStamp, record: TranscriptDerivationRecord): FoldEvent {
  const manifest = record.recordType === "derivation";
  const event = parseEvent({
    specVersion: "0.7", id: stamp.id,
    kind: manifest ? "transcript.derivation-recorded" : "transcript.derivation-chunk-recorded",
    title: manifest ? "Historical transcript derivation" : "Historical transcript derived evidence",
    at: { t: stamp.t, worldDate: stamp.worldDate, granularity: "session" },
    author: context.author, capture: context.capture,
    changes: [{ verb: "create", subject: `urn:fold:${stamp.id}`, nodeKind: manifest ? DERIVATION_NODE_KIND : DERIVATION_CHUNK_NODE_KIND,
      after: record, provenance: { basis: "derived", method: { kind: "system", id: "transcript-reprocessor" } } }],
  });
  derivationRecordFromEvent(event);
  return event;
}
