import { compareEventKeys, type FoldEvent } from "@_89/fold";

import { transcriptRecordsFromEvent, validateTranscriptEventEnvelope } from "./events.js";
import type {
  TranscriptArtifact,
  TranscriptChunk,
  TranscriptProject,
  TranscriptRun,
} from "./schema.js";

export interface TranscriptCatalog {
  readonly projects: ReadonlyMap<string, TranscriptProject>;
  readonly artifacts: ReadonlyMap<string, TranscriptArtifact>;
  readonly runs: ReadonlyMap<string, TranscriptRun>;
  readonly chunksByRun: ReadonlyMap<string, readonly TranscriptChunk[]>;
}

export class TranscriptProjectionError extends Error {
  override readonly name = "TranscriptProjectionError";
}

/** Validates canonical equivalence only; private bytes and descriptive ranges require a local verifier. */
export function validateTranscriptInterpretation(run: TranscriptRun, artifact: TranscriptArtifact, catalog: Pick<TranscriptCatalog, "runs" | "artifacts">): void {
  const interpretation = run.interpretation;
  if (interpretation === undefined) return;
  const previous = catalog.runs.get(interpretation.previousRunId);
  const rootId = previous?.interpretation?.sourceArtifactId ?? previous?.artifactId;
  const root = rootId === undefined ? undefined : catalog.artifacts.get(rootId);
  const priorArtifact = previous === undefined ? undefined : catalog.artifacts.get(previous.artifactId);
  if (!previous || !root || !priorArtifact || previous.id === run.id || interpretation.sourceArtifactId !== root.id || interpretation.sourceOccurrenceId !== root.id ||
    run.nativeId !== previous.nativeId || run.source !== previous.source || artifact.id === root.id || artifact.id === priorArtifact.id ||
    interpretation.parser.id !== artifact.parser.id || interpretation.parser.version !== artifact.parser.version ||
    (artifact.parser.id === priorArtifact.parser.id && artifact.parser.version === priorArtifact.parser.version)) {
    throw new TranscriptProjectionError("reinterpretation source or parser identity does not match canonical predecessor");
  }
  for (const key of ["source", "sha256", "storedSha256", "sourcePathHash", "byteLength", "mediaType", "modifiedAt", "contentPolicy", "reasoningPolicy", "encryptedReasoningPolicy", "anonymizationPolicy", "stored", "redactionCount"] as const) {
    if (artifact[key] !== root[key]) throw new TranscriptProjectionError("reinterpretation must retain original source bytes and privacy metadata");
  }
}

function insertUnique<T>(map: Map<string, T>, id: string, value: T, label: string): void {
  const existing = map.get(id);
  if (existing === undefined) {
    map.set(id, value);
    return;
  }
  if (JSON.stringify(existing) !== JSON.stringify(value)) {
    throw new TranscriptProjectionError(`${label} ${id} changed after import`);
  }
}

function projectTranscriptEvents(
  events: readonly FoldEvent[],
  seed?: TranscriptCatalog,
): TranscriptCatalog {
  const projects = new Map(seed?.projects);
  const artifacts = new Map(seed?.artifacts);
  const runs = new Map(seed?.runs);
  const chunksByRun = new Map(
    [...(seed?.chunksByRun ?? [])].map(([runId, chunks]) => [runId, [...chunks]]),
  );

  for (const event of [...events].sort(compareEventKeys)) {
    validateTranscriptEventEnvelope(event);
    for (const record of transcriptRecordsFromEvent(event)) {
      if (record.recordType === "project") {
        insertUnique(projects, record.project.id, record.project, "transcript project");
      } else if (record.recordType === "artifact") {
        insertUnique(artifacts, record.artifact.id, record.artifact, "transcript artifact");
      } else if (record.recordType === "run") {
        if (!artifacts.has(record.run.artifactId)) {
          throw new TranscriptProjectionError(`run ${record.run.id} references an unavailable artifact`);
        }
        if (record.run.projectId !== undefined && !projects.has(record.run.projectId)) {
          throw new TranscriptProjectionError(`run ${record.run.id} references an unavailable project`);
        }
        validateTranscriptInterpretation(record.run, artifacts.get(record.run.artifactId)!, { artifacts, runs });
        insertUnique(runs, record.run.id, record.run, "transcript run");
      } else {
        if (!runs.has(record.chunk.runId)) {
          throw new TranscriptProjectionError(`chunk references unavailable run ${record.chunk.runId}`);
        }
        const run = runs.get(record.chunk.runId)!;
        for (const turn of record.chunk.turns) if (turn.origin !== undefined && (turn.origin.sourceOccurrenceId !== (run.interpretation?.sourceOccurrenceId ?? run.artifactId) || turn.origin.recordRanges.some(({ end }) => end >= run.counts.records))) throw new TranscriptProjectionError("turn origin is outside canonical source bounds");
        const chunks = chunksByRun.get(record.chunk.runId) ?? [];
        const existing = chunks.find(({ sequence }) => sequence === record.chunk.sequence);
        if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(record.chunk)) {
          throw new TranscriptProjectionError(`run ${record.chunk.runId} chunk ${record.chunk.sequence} changed after import`);
        }
        if (existing === undefined) {
          chunks.push(record.chunk);
          chunks.sort((left, right) => left.sequence - right.sequence);
          chunksByRun.set(record.chunk.runId, chunks);
        }
      }
    }
  }

  for (const [runId, chunks] of chunksByRun) {
    chunks.forEach((chunk, index) => {
      if (chunk.sequence !== index) {
        throw new TranscriptProjectionError(`run ${runId} has a gap before chunk ${chunk.sequence}`);
      }
    });
  }

  return { projects, artifacts, runs, chunksByRun };
}

export function rebuildTranscriptCatalog(events: readonly FoldEvent[]): TranscriptCatalog {
  return projectTranscriptEvents(events);
}

export function extendTranscriptCatalog(
  catalog: TranscriptCatalog,
  events: readonly FoldEvent[],
): TranscriptCatalog {
  return projectTranscriptEvents(events, catalog);
}
