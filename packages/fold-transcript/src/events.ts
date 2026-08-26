import { parseEvent, type Author, type CaptureEnvelope, type FoldEvent, type Provenance } from "@_89/fold";

import {
  transcriptArtifactSchema,
  transcriptChunkSchema,
  transcriptProjectSchema,
  transcriptRunSchema,
  type TranscriptArtifact,
  type TranscriptChunk,
  type TranscriptProject,
  type TranscriptRun,
} from "./schema.js";

export const TRANSCRIPT_PROJECT_NODE_KIND = "x.fold.transcript-project";
export const TRANSCRIPT_ARTIFACT_NODE_KIND = "x.fold.transcript-artifact";
export const TRANSCRIPT_RUN_NODE_KIND = "x.fold.transcript-run";
export const TRANSCRIPT_CHUNK_NODE_KIND = "x.fold.transcript-chunk";

const EVENT_KIND_BY_NODE_KIND = new Map([
  [TRANSCRIPT_PROJECT_NODE_KIND, "transcript.project-recorded"],
  [TRANSCRIPT_ARTIFACT_NODE_KIND, "transcript.artifact-imported"],
  [TRANSCRIPT_RUN_NODE_KIND, "transcript.run-imported"],
  [TRANSCRIPT_CHUNK_NODE_KIND, "transcript.chunk-imported"],
]);

const NODE_KIND_BY_EVENT_KIND = new Map(
  [...EVENT_KIND_BY_NODE_KIND].map(([nodeKind, eventKind]) => [eventKind, nodeKind]),
);

export interface TranscriptEventStamp {
  readonly id: string;
  readonly t: number;
  readonly worldDate: string;
}

export interface TranscriptEventContext {
  readonly author: Author;
  readonly capture: CaptureEnvelope;
}

export type TranscriptLogRecord =
  | { readonly recordType: "project"; readonly project: TranscriptProject }
  | { readonly recordType: "artifact"; readonly artifact: TranscriptArtifact }
  | { readonly recordType: "run"; readonly run: TranscriptRun }
  | { readonly recordType: "chunk"; readonly chunk: TranscriptChunk };

export class TranscriptEventError extends Error {
  override readonly name = "TranscriptEventError";
}

function validateContext(context: TranscriptEventContext): void {
  if (context.author.kind !== "ingest") {
    throw new TypeError("transcript events require an ingest author");
  }
  if (context.capture.identity?.source === undefined) {
    throw new TypeError("transcript capture identity requires source");
  }
}

function makeEvent(
  context: TranscriptEventContext,
  stamp: TranscriptEventStamp,
  kind: string,
  title: string,
  nodeKind: string,
  subject: string,
  after: Readonly<Record<string, unknown>>,
  provenance: Provenance,
): FoldEvent {
  validateContext(context);
  const event = parseEvent({
    specVersion: "0.7",
    id: stamp.id,
    kind,
    title,
    at: { t: stamp.t, worldDate: stamp.worldDate, granularity: "session" },
    author: context.author,
    capture: context.capture,
    changes: [{ verb: "create", subject, nodeKind, after, provenance }],
  });
  validateTranscriptEventEnvelope(event);
  return event;
}

export function makeTranscriptProjectEvent(
  context: TranscriptEventContext,
  stamp: TranscriptEventStamp,
  input: TranscriptProject,
): FoldEvent {
  const project = transcriptProjectSchema.parse(input);
  return makeEvent(
    context,
    stamp,
    "transcript.project-recorded",
    `Transcript project ${project.name}`,
    TRANSCRIPT_PROJECT_NODE_KIND,
    `urn:fold:transcript-project:${project.id}`,
    { recordType: "project", project },
    { basis: "derived", method: { kind: "system", id: "transcript-importer" } },
  );
}

export function makeTranscriptArtifactEvent(
  context: TranscriptEventContext,
  stamp: TranscriptEventStamp,
  input: TranscriptArtifact,
): FoldEvent {
  const artifact = transcriptArtifactSchema.parse(input);
  return makeEvent(
    context,
    stamp,
    "transcript.artifact-imported",
    `Transcript artifact ${artifact.id}`,
    TRANSCRIPT_ARTIFACT_NODE_KIND,
    `urn:fold:transcript-artifact:${artifact.id}`,
    { recordType: "artifact", artifact },
    { basis: "observed", method: { kind: "system", id: artifact.parser.id, detail: { version: artifact.parser.version } } },
  );
}

export function makeTranscriptRunEvent(
  context: TranscriptEventContext,
  stamp: TranscriptEventStamp,
  input: TranscriptRun,
): FoldEvent {
  const run = transcriptRunSchema.parse(input);
  return makeEvent(
    context,
    stamp,
    "transcript.run-imported",
    `Imported ${run.source} run ${run.nativeId}`,
    TRANSCRIPT_RUN_NODE_KIND,
    `urn:fold:transcript-run:${run.id}`,
    { recordType: "run", run },
    { basis: "observed", method: { kind: "system", id: "transcript-importer" } },
  );
}

export function makeTranscriptChunkEvent(
  context: TranscriptEventContext,
  stamp: TranscriptEventStamp,
  input: TranscriptChunk,
): FoldEvent {
  const chunk = transcriptChunkSchema.parse(input);
  return makeEvent(
    context,
    stamp,
    "transcript.chunk-imported",
    `Imported ${chunk.runId} metadata chunk ${chunk.sequence}`,
    TRANSCRIPT_CHUNK_NODE_KIND,
    `urn:fold:transcript-chunk:${chunk.runId}:${chunk.sequence}`,
    { recordType: "chunk", chunk },
    { basis: "observed", method: { kind: "system", id: "transcript-importer" } },
  );
}

export function transcriptRecordsFromEvent(event: FoldEvent): readonly TranscriptLogRecord[] {
  const records: TranscriptLogRecord[] = [];
  for (const change of event.changes) {
    if (change.verb !== "create") continue;
    if (change.nodeKind === TRANSCRIPT_PROJECT_NODE_KIND) {
      const payload = transcriptProjectSchema.parse(change.after.project);
      if (change.after.recordType !== "project") throw new TranscriptEventError(`transcript project ${event.id} has an invalid record type`);
      records.push({ recordType: "project", project: payload });
    } else if (change.nodeKind === TRANSCRIPT_ARTIFACT_NODE_KIND) {
      const payload = transcriptArtifactSchema.parse(change.after.artifact);
      if (change.after.recordType !== "artifact") throw new TranscriptEventError(`transcript artifact ${event.id} has an invalid record type`);
      records.push({ recordType: "artifact", artifact: payload });
    } else if (change.nodeKind === TRANSCRIPT_RUN_NODE_KIND) {
      const payload = transcriptRunSchema.parse(change.after.run);
      if (change.after.recordType !== "run") throw new TranscriptEventError(`transcript run ${event.id} has an invalid record type`);
      records.push({ recordType: "run", run: payload });
    } else if (change.nodeKind === TRANSCRIPT_CHUNK_NODE_KIND) {
      const payload = transcriptChunkSchema.parse(change.after.chunk);
      if (change.after.recordType !== "chunk") throw new TranscriptEventError(`transcript chunk ${event.id} has an invalid record type`);
      records.push({ recordType: "chunk", chunk: payload });
    }
  }
  return records;
}

export function validateTranscriptEventEnvelope(event: FoldEvent): void {
  const records = transcriptRecordsFromEvent(event);
  const expectedNodeKind = NODE_KIND_BY_EVENT_KIND.get(event.kind);
  const declaresTranscript = expectedNodeKind !== undefined || records.length > 0;
  if (!declaresTranscript) return;
  if (expectedNodeKind === undefined || event.author.kind !== "ingest" || event.changes.length !== 1 || records.length !== 1) {
    throw new TranscriptEventError(`transcript event ${event.id} requires one matching ingest-authored record`);
  }
  const change = event.changes[0];
  if (change?.verb !== "create" || change.nodeKind !== expectedNodeKind) {
    throw new TranscriptEventError(`transcript event ${event.id} kind does not match its record`);
  }
  if (change.provenance?.method?.kind !== "system") {
    throw new TranscriptEventError(`transcript event ${event.id} requires importer provenance`);
  }
  if (event.capture.identity?.source === undefined) {
    throw new TranscriptEventError(`transcript event ${event.id} requires capture identity source`);
  }
}
