import { describe, expect, it } from "vitest";

import {
  makeTranscriptArtifactEvent,
  makeTranscriptChunkEvent,
  makeTranscriptProjectEvent,
  makeTranscriptRunEvent,
  rebuildTranscriptCatalog,
  TranscriptEventError,
  TranscriptProjectionError,
  transcriptImportBundleSchema,
  type TranscriptChunk,
  type TranscriptEventContext,
} from "../src/index.js";

const context: TranscriptEventContext = {
  author: { kind: "ingest", id: "local-importer" },
  capture: {
    scope: { workspace: "workspace-1" },
    identity: { source: "codex", project: "project-a", run: "codex:run-a" },
  },
};

const project = {
  id: "project-a",
  name: "Project A",
  identityKeyHash: "a".repeat(64),
  resolution: "resolved" as const,
  roots: ["/workspace/project-a"],
};

const artifact = {
  id: "artifact-a",
  source: "codex" as const,
  sha256: "b".repeat(64),
  sourcePathHash: "c".repeat(64),
  byteLength: 100,
  mediaType: "application/x-ndjson",
  parser: { id: "codex-jsonl", version: "1" },
  contentPolicy: "metadata-only" as const,
  stored: false,
  redactionCount: 0,
};

const run = {
  id: "codex:run-a",
  nativeId: "run-a",
  source: "codex" as const,
  artifactId: artifact.id,
  projectId: project.id,
  projectResolution: "resolved" as const,
  startedAt: "2026-08-20T12:00:00.000Z",
  cwd: "/workspace/project-a",
  branch: "main",
  counts: { records: 5, turns: 1, messages: 2, actions: 1, unknown: 0 },
  segments: [{
    id: "codex:run-a:segment:0",
    ordinal: 0,
    projectId: project.id,
    resolution: "resolved" as const,
    cwd: "/workspace/project-a",
    branch: "main",
    startedAt: "2026-08-20T12:00:00.000Z",
  }],
};

const chunk: TranscriptChunk = {
  runId: run.id,
  sequence: 0,
  turns: [{
    id: "codex:run-a:turn:0",
    ordinal: 0,
    nativeId: "turn-a",
    startedAt: "2026-08-20T12:00:01.000Z",
    messageCount: 2,
    actionCount: 1,
    roles: ["user", "assistant"],
  }],
  actions: [{
    id: "codex:run-a:action:0",
    ordinal: 0,
    turnId: "codex:run-a:turn:0",
    at: "2026-08-20T12:00:02.000Z",
    kind: "tool-call" as const,
    name: "exec_command",
    status: "completed" as const,
  }],
};

function stamp(index: number) {
  return { id: `event-${index}`, t: index, worldDate: "2026-08-20" };
}

describe("transcript catalog", () => {
  it("validates a source-qualified bounded import bundle", () => {
    expect(transcriptImportBundleSchema.parse({ projects: [project], artifact, run, chunks: [chunk] }))
      .toMatchObject({ run: { id: "codex:run-a" } });
    expect(() => transcriptImportBundleSchema.parse({
      projects: [project],
      artifact,
      run,
      chunks: [{ ...chunk, sequence: 1 }],
    })).toThrow(/contiguous/);
  });

  it("records and deterministically rebuilds project, run, turn, and action identity", () => {
    const events = [
      makeTranscriptProjectEvent(context, stamp(1), project),
      makeTranscriptArtifactEvent(context, stamp(2), artifact),
      makeTranscriptRunEvent(context, stamp(3), run),
      makeTranscriptChunkEvent(context, stamp(4), chunk),
    ];
    const catalog = rebuildTranscriptCatalog(events.reverse());
    expect(catalog.projects.get(project.id)).toEqual(project);
    expect(catalog.runs.get(run.id)).toEqual(run);
    expect(catalog.chunksByRun.get(run.id)?.[0]).toEqual(chunk);
  });

  it("rejects masquerading records and unavailable references", () => {
    const valid = makeTranscriptArtifactEvent(context, stamp(1), artifact);
    expect(() => rebuildTranscriptCatalog([
      { ...valid, author: { kind: "human", id: "person-a" } },
    ])).toThrow(TranscriptEventError);
    expect(() => rebuildTranscriptCatalog([
      makeTranscriptRunEvent(context, stamp(2), run),
    ])).toThrow(TranscriptProjectionError);
  });
});
