import { describe, expect, it } from "vitest";
import { derivationHash, type TranscriptDerivationManifest } from "@_89/fold-transcript";

import {
  FoldSdk,
  FoldSdkConflictError,
  type FoldSdkTranscriptContext,
  type TranscriptImportBundle,
} from "../src/index.js";
import { access, MemoryStore } from "./helpers.js";

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
  endedAt: "2026-08-20T12:05:00.000Z",
  cwd: "/workspace/project-a",
  counts: { records: 5, turns: 1, messages: 2, actions: 1, unknown: 0 },
  segments: [{
    id: "codex:run-a:segment:0",
    ordinal: 0,
    projectId: project.id,
    resolution: "resolved" as const,
    cwd: "/workspace/project-a",
    startedAt: "2026-08-20T12:00:00.000Z",
  }],
};

const chunk = {
  runId: run.id,
  sequence: 0,
  turns: [{
    id: "codex:run-a:turn:0",
    ordinal: 0,
    nativeId: "turn-a",
    startedAt: "2026-08-20T12:00:01.000Z",
    messageCount: 2,
    actionCount: 1,
    roles: ["user", "assistant"] as Array<"user" | "assistant">,
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

const bundle: TranscriptImportBundle = {
  projects: [project],
  artifact,
  run,
  chunks: [chunk],
};

it("adds resumable hash-bound evidence without changing original runs or allowing source and policy substitution", async () => {
  const sdk = new FoldSdk(new MemoryStore());
  const retained = { ...bundle, artifact: { ...artifact, contentPolicy: "redacted" as const, stored: true } };
  await sdk.importTranscript(context(), retained, { importId: "retained", importedAt: 1 });
  const records = [0, 1].map((ordinal) => ({ ordinal, line: ordinal + 1, kind: "usage" as const, sourceType: "token_usage_record", data: { tokens: 42 } }));
  const manifest: TranscriptDerivationManifest = { runId: run.id, artifactId: artifact.id, sourceSha256: artifact.sha256, inputSha256: "d".repeat(64), inputKind: "retained-policy-artifact", parser: { id: "test", version: "1" }, policy: { contentPolicy: "redacted" }, records: 2, sourceRecords: 2, byKind: { usage: 2 }, unclassifiedTypes: {}, chunkHashes: records.map((record) => derivationHash([record])) };
  const id = derivationHash(manifest);
  await expect(sdk.recordTranscriptDerivation(context(), { manifest: { ...manifest, sourceSha256: "f".repeat(64) } })).rejects.toThrow("source or retention policy");
  await expect(sdk.recordTranscriptDerivation(context(), { manifest: { ...manifest, policy: { contentPolicy: "redacted", reasoningPolicy: "included" } } })).rejects.toThrow("source or retention policy");
  await expect(sdk.recordTranscriptDerivation(context(), { manifest })).resolves.toMatchObject({ imported: true });
  await expect(sdk.recordTranscriptDerivation(context(), { manifest })).resolves.toMatchObject({ imported: false });
  const chunks = records.map((record, sequence) => ({ runId: run.id, derivationId: id, sequence, records: [record] }));
  await expect(sdk.recordTranscriptDerivation(context(), { chunk: chunks[1]! })).rejects.toThrow("in order");
  await expect(sdk.recordTranscriptDerivation(context(), { chunk: { ...chunks[0]!, records: [{ ...records[0]!, data: { tokens: 99 } }] } })).rejects.toThrow("checksum");
  await sdk.recordTranscriptDerivation(context(), { chunk: chunks[0]! });
  expect(await sdk.transcriptDerivations(access(), run.id)).toMatchObject([{ complete: false }]);
  await sdk.recordTranscriptDerivation(context(), { chunk: chunks[1]! });
  await expect(sdk.recordTranscriptDerivation(context(), { chunk: chunks[1]! })).resolves.toMatchObject({ imported: false });
  expect(await sdk.transcriptDerivations(access(), run.id)).toMatchObject([{ derivationId: id, complete: true, chunks }]);
  expect(Number.isInteger((await sdk.transcriptDerivations(access(), run.id))[0]!.recordedAt)).toBe(false);
  expect(await sdk.transcriptRun(access(), run.id)).toEqual({ run, artifact: retained.artifact, projects: [project], chunks: [chunk] });
  await expect(sdk.transcriptDerivations(access({ workspaceId: "elsewhere" }), run.id)).rejects.toThrow("unavailable");
});

function context(workspaceId = "workspace-1"): FoldSdkTranscriptContext {
  const currentAccess = access({ workspaceId, workspaceRole: "owner" });
  return {
    access: currentAccess,
    author: { kind: "ingest", id: "local-importer" },
    capture: {
      scope: { workspace: workspaceId },
      identity: {
        principal: currentAccess.principalId,
        workspace: workspaceId,
        source: bundle.run.source,
        project: project.id,
        run: bundle.run.id,
        session: bundle.run.nativeId,
      },
    },
  };
}

describe("Fold SDK transcript imports", () => {
  it("imports an immutable bundle and exposes project and run queries", async () => {
    const store = new MemoryStore();
    const sdk = new FoldSdk(store);
    const imported = await sdk.importTranscript(context(), bundle, {
      importId: "import-a",
      importedAt: Date.parse("2026-08-20T13:00:00.000Z"),
    });

    expect(imported.events).toHaveLength(4);
    expect(store.appendManyCount).toBe(1);
    expect(await sdk.transcriptProjects(access())).toEqual([{
      project,
      runCount: 1,
      lastRunAt: run.endedAt,
    }]);
    expect(await sdk.transcriptRuns(access(), { projectId: project.id })).toEqual([run]);
    expect(await sdk.transcriptRun(access(), run.id)).toEqual({
      run,
      artifact,
      projects: [project],
      chunks: [chunk],
    });
  });

  it("makes exact retries no-ops and preserves changed source artifacts as immutable snapshots", async () => {
    const sdk = new FoldSdk(new MemoryStore());
    await sdk.importTranscript(context(), bundle, { importId: "import-a", importedAt: 1 });
    const retry = await sdk.importTranscript(context(), bundle, { importId: "import-b", importedAt: 2 });
    expect(retry.events).toEqual([]);

    const nextArtifact = {
      ...artifact,
      id: "artifact-next",
      sha256: "d".repeat(64),
      byteLength: 200,
    };
    const snapshot = await sdk.importTranscript(context(), {
      ...bundle,
      artifact: nextArtifact,
      run: {
        ...run,
        artifactId: nextArtifact.id,
        counts: { ...run.counts, messages: 3 },
      },
    }, { importId: "import-c", importedAt: 3 });
    expect(snapshot.run).toMatchObject({
      id: `codex:run-a:snapshot:${"d".repeat(16)}`,
      snapshotOfRunId: run.id,
      nativeId: run.nativeId,
      artifactId: nextArtifact.id,
    });
    expect(snapshot.events).toHaveLength(3);
    expect(snapshot.events.every((event) => event.capture.identity?.run === snapshot.run.id)).toBe(true);
    expect(await sdk.transcriptRuns(access())).toHaveLength(2);

    const snapshotRetry = await sdk.importTranscript(context(), {
      ...bundle,
      artifact: nextArtifact,
      run: {
        ...run,
        artifactId: nextArtifact.id,
        counts: { ...run.counts, messages: 3 },
      },
    }, { importId: "import-d", importedAt: 4 });
    expect(snapshotRetry.events).toEqual([]);
    expect(snapshotRetry.run.id).toBe(snapshot.run.id);

    await expect(sdk.importTranscript(context(), {
      ...bundle,
      run: { ...run, counts: { ...run.counts, messages: 3 } },
    }, { importId: "import-e", importedAt: 5 })).rejects.toBeInstanceOf(FoldSdkConflictError);
  });

  it("keeps transcript queries inside the authenticated workspace", async () => {
    const sdk = new FoldSdk(new MemoryStore(true));
    await sdk.importTranscript(context(), bundle, { importId: "import-a", importedAt: 1 });
    expect(await sdk.transcriptProjects(access())).toHaveLength(1);
    expect(await sdk.transcriptProjects(access({ workspaceId: "workspace-2" }))).toEqual([]);
    expect(await sdk.transcriptRun(access({ workspaceId: "workspace-2" }), run.id)).toBeUndefined();
  });

  it("rejects transcript records submitted through a masquerading event", async () => {
    const store = new MemoryStore();
    const sdk = new FoldSdk(store);
    const imported = await sdk.importTranscript(context(), bundle, {
      importId: "import-a",
      importedAt: 1,
    });
    const event = imported.events[0]!;
    await expect(new FoldSdk(new MemoryStore()).append(
      access(),
      { ...event, author: { kind: "human", id: "user-a" } },
    )).rejects.toThrow(/matching ingest-authored record/);
  });
});
