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

export function rebuildTranscriptCatalog(events: readonly FoldEvent[]): TranscriptCatalog {
  const projects = new Map<string, TranscriptProject>();
  const artifacts = new Map<string, TranscriptArtifact>();
  const runs = new Map<string, TranscriptRun>();
  const chunksByRun = new Map<string, TranscriptChunk[]>();

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
        insertUnique(runs, record.run.id, record.run, "transcript run");
      } else {
        if (!runs.has(record.chunk.runId)) {
          throw new TranscriptProjectionError(`chunk references unavailable run ${record.chunk.runId}`);
        }
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
