import { describe, expect, it } from "vitest";

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
