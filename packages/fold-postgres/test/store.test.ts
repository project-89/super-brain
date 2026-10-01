import { randomUUID } from "node:crypto";

import { parseEvent, type FoldLogEntry } from "@_89/fold";
import { FoldSdk } from "@_89/fold-sdk";
import { makeMemoryCandidateAcceptedEvent, makeMemoryCandidateEvidenceAddedEvent } from "@_89/fold-epistemic";
import { derivationHash, makeTranscriptProjectEvent } from "@_89/fold-transcript";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PostgresFoldConflictError,
  PostgresFoldDatabase,
  PostgresTenantAdministration,
  PostgresVectorMemoryRanker,
} from "../src/index.js";

const connectionString = process.env.FOLD_TEST_DATABASE_URL;
const integrationDescribe = connectionString === undefined ? describe.skip : describe;

function entry(id: string, t: number, status: FoldLogEntry["status"] = "canon"): FoldLogEntry {
  return {
    status,
    event: parseEvent({
      specVersion: "0.7",
      id,
      kind: "test.observation",
      title: id,
      at: { t, worldDate: "2026-08-27" },
      author: { kind: "human", id: "test-user" },
      capture: { scope: { workspace: "placeholder" } },
      changes: [{
        verb: "create",
        subject: `urn:test:${id}`,
        nodeKind: "fact",
        after: { id },
        provenance: { basis: "authored" },
      }],
    }),
  };
}

integrationDescribe("Postgres Fold store", () => {
  const schema = `fold_test_${randomUUID().replaceAll("-", "")}`;
  const workspaceId = `test-${randomUUID()}`;
  let database: PostgresFoldDatabase;
  let administration: PostgresTenantAdministration;

  beforeAll(async () => {
    const pool = new Pool({ connectionString: connectionString! });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    await pool.end();
    database = new PostgresFoldDatabase({ connectionString: connectionString!, schema });
    administration = new PostgresTenantAdministration({ connectionString: connectionString!, schema });
    await Promise.all([database.open(), administration.replaceStaticMemberships([])]);
  });

  afterAll(async () => {
    await Promise.all([database.close(), administration.close()]);
    const pool = new Pool({ connectionString: connectionString! });
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  });

  it("atomically appends and reads canonical-order entries", async () => {
    const store = database.store(workspaceId);
    const second = entry("event-b", 2, "draft");
    const first = entry("event-a", 1);
    await store.appendMany!([second]);
    await store.append(first);

    await expect(store.read()).resolves.toMatchObject({
      entries: [first, second],
      revision: expect.stringMatching(/^\d+$/),
    });
    await expect(store.append(first)).rejects.toBeInstanceOf(PostgresFoldConflictError);
  });

  it("preserves pending support in the SQL candidate projection and rejects stale cross-process review", async () => {
    const tenant = { organizationId: `support-${workspaceId}`, workspaceId: "support" };
    const access = { principalId: "worker", workspaceId: tenant.workspaceId, workspaceRole: "owner" as const, spaceRoles: {} };
    const context = { access, author: { kind: "agent" as const, id: "worker" }, capture: {
      scope: { workspace: tenant.workspaceId }, identity: { principal: "worker", workspace: tenant.workspaceId } } };
    const store = database.store(tenant); const sdk = new FoldSdk(store);
    const source = (id: string, t: number) => {
      const event = entry(id, t).event;
      return { status: "canon" as const, event: { ...event, capture: context.capture } };
    };
    await store.appendMany!([source("source-one", 1), source("source-two", 2)]);
    const id = "01890f47-7c00-7000-8000-000000000001";
    const memoryId = "01890f47-7c00-7000-8000-000000000002";
    const input = { id, audience: "workspace" as const, source: "test", summary: "Same conclusion", content: { conclusion: "verify" },
      projectIds: ["project-a"], evidence: [{ eventId: "source-one", projectId: "project-a" }], confidence: 0.9, salience: 0.8,
      extractor: { kind: "rule" as const, id: "rule", version: "1" } };
    const stamp = (id: string, t: number) => ({ id, t, worldDate: "2026-09-15" });
    const { candidate } = await sdk.proposeMemoryCandidate(context, stamp("proposal", 100), input);
    const staleDecision = makeMemoryCandidateAcceptedEvent(context, stamp("stale-accept", 120), candidate, memoryId);
    const secondDatabase = new PostgresFoldDatabase({ connectionString: connectionString!, schema });
    try {
      const other = new FoldSdk(secondDatabase.store(tenant));
      await other.addMemoryCandidateEvidence(context, stamp("support", 110), id, { ...input, evidence: [{ eventId: "source-two", projectId: "project-a", turnId: "late" }] });
      const views = await database.workspaceMemoryCandidates(tenant, access);
      expect(views[0]?.candidate.evidence).toHaveLength(2);
      expect(views[0]?.candidate.supportEventIds).toEqual(["support"]);
      await expect(store.append({ event: staleDecision, status: "canon" })).rejects.toThrow(/stale or invalid/);
      const accepted = await sdk.acceptMemoryCandidate(context, stamp("accept", 130), stamp("memory", 131), id, memoryId);
      expect(accepted.memory.evidence).toHaveLength(2);
      const late = makeMemoryCandidateEvidenceAddedEvent(context, stamp("late", 140), candidate, [{ eventId: "source-two" }]);
      await expect(secondDatabase.store(tenant).append({ event: late, status: "canon" })).rejects.toThrow(/changed or was decided/);
    } finally { await secondDatabase.close(); }
  });

  it("serializes reviewed identity commands from independent SDK instances and reads one canonical tenant event", async () => {
    const tenant = { organizationId: `identity-${workspaceId}`, workspaceId: "identity" };
    const access = { ...tenant, principalId: "admin", workspaceRole: "owner" as const, spaceRoles: {} };
    const context = { access, author: { kind: "human" as const, id: "admin" } };
    const review = { reason: "Reviewed source records", active: true, evidenceEventIds: [] };
    const secondDatabase = new PostgresFoldDatabase({ connectionString: connectionString!, schema });
    try {
      const first = new FoldSdk(database.store(tenant)); const second = new FoldSdk(secondDatabase.store(tenant));
      const commands = [first, second].map((sdk, index) => sdk.reviseIdentity(context, null, { kind: "entity", input: { id: `person-${index}`, kind: "person", label: "Person", ...review } }));
      const results = await Promise.allSettled(commands);
      expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
      expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
      const snapshot = await first.identities(access);
      expect(snapshot.entities).toHaveLength(1);
      expect(await database.eventById(tenant, snapshot.revision!)).toMatchObject({ status: "canon", event: { kind: "identity.revised" } });
      expect(await database.eventById({ ...tenant, organizationId: "foreign" }, snapshot.revision!)).toBeUndefined();
      for (const [index, id] of ["a", "b"].entries()) await database.store(tenant).append({ status: "canon", event: makeTranscriptProjectEvent({ author: { kind: "ingest", id: "test" }, capture: { scope: { workspace: tenant.workspaceId }, identity: { source: "codex" } } }, { id: `project-${id}`, t: index + 1, worldDate: "2026-09-15" }, { id, name: id, identityKeyHash: String(index).repeat(64), roots: [`/${id}`], resolution: "resolved" }) });
      const left = { aliasProjectId: "a", canonicalProjectId: "b", ...review }; const right = { aliasProjectId: "b", canonicalProjectId: "a", ...review };
      const previews = await Promise.all([first.previewProjectAlias(access, left), second.previewProjectAlias(access, right)]);
      const aliases = await Promise.allSettled([first.reviseIdentity(context, previews[0]!.revision, { kind: "project-alias", input: left }, previews[0]!.previewToken), second.reviseIdentity(context, previews[1]!.revision, { kind: "project-alias", input: right }, previews[1]!.previewToken)]);
      expect(aliases.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
      expect((await new FoldSdk(database.store(tenant)).identities(access)).aliases).toHaveLength(1);
    } finally { await secondDatabase.close(); }
  });

  it("selects run-bound derivations without double-counting imports or crossing tenants", async () => {
    const tenant = { organizationId: `derivations-${workspaceId}`, workspaceId: "archives" };
    const access = { principalId: "operator", workspaceId: tenant.workspaceId, workspaceRole: "owner" as const, spaceRoles: {} };
    const context = { access, author: { kind: "ingest" as const, id: "importer" }, capture: { scope: { workspace: tenant.workspaceId }, identity: { source: "codex", run: "run-a" } } };
    const sdk = new FoldSdk(database.store(tenant));
    const artifact = { id: "artifact-a", source: "codex" as const, sha256: "a".repeat(64), sourcePathHash: "b".repeat(64), byteLength: 20, mediaType: "application/x-ndjson", parser: { id: "test", version: "1" }, contentPolicy: "redacted" as const, stored: true, redactionCount: 0 };
    const run = { id: "run-a", nativeId: "native-a", source: "codex" as const, artifactId: artifact.id, projectResolution: "unassigned" as const, counts: { records: 1, turns: 0, messages: 0, actions: 0, unknown: 1 }, segments: [] };
    await sdk.importTranscript(context, { projects: [], artifact, run, chunks: [] }, { importId: "import", importedAt: 1 });
    const records = [{ ordinal: 0, line: 1, kind: "usage" as const, sourceType: "token_usage_record", data: { tokens: 42 } }];
    const manifest = { runId: run.id, artifactId: artifact.id, sourceSha256: artifact.sha256, inputSha256: "c".repeat(64), inputKind: "retained-policy-artifact" as const, parser: { id: "test", version: "1" }, policy: { contentPolicy: "redacted" as const }, records: 1, sourceRecords: 1, byKind: { usage: 1 }, unclassifiedTypes: {}, chunkHashes: [derivationHash(records)] };
    const kinds = ["transcript.project-recorded", "transcript.artifact-imported", "transcript.run-imported", "transcript.derivation-recorded", "transcript.derivation-chunk-recorded"];
    const selected = () => new FoldSdk(database.store(tenant, { kinds, transcriptRunId: run.id }));
    await selected().recordTranscriptDerivation(context, { manifest });
    await selected().recordTranscriptDerivation(context, { chunk: { runId: run.id, derivationId: derivationHash(manifest), sequence: 0, records } });
    expect(await selected().transcriptDerivations(access, run.id)).toMatchObject([{ complete: true }]);
    expect((await database.workspaceDataQuality(tenant, access)).corpus).toMatchObject({ archivedRecords: 2, derivedRecords: 2 });
    expect((await database.readEntries(tenant, { kinds, transcriptRunId: "other-run" })).some(({ event }) => event.kind.startsWith("transcript.derivation"))).toBe(false);
    expect(await database.readEntries({ ...tenant, organizationId: "other-org" })).toEqual([]);
    for (let index = 0; index < 20; index += 1) await database.readSnapshot(tenant, { kinds, transcriptRunId: `unused-${index}` });
    expect(await selected().transcriptDerivations(access, run.id)).toMatchObject([{ complete: true }]);
  });

  it("loads only incoming transcript chunks while preserving snapshot retries and conflicts", async () => {
    const tenant = { organizationId: `imports-${workspaceId}`, workspaceId: "archives" };
    const access = { principalId: "operator", workspaceId: tenant.workspaceId, workspaceRole: "owner" as const, spaceRoles: {} };
    const context = { access, author: { kind: "ingest" as const, id: "importer" }, capture: { scope: { workspace: tenant.workspaceId }, identity: { source: "codex", run: "run-a" } } };
    const artifact = { id: "artifact-a", source: "codex" as const, sha256: "a".repeat(64), sourcePathHash: "b".repeat(64), byteLength: 20, mediaType: "application/x-ndjson", parser: { id: "test", version: "1" }, contentPolicy: "metadata-only" as const, stored: false, redactionCount: 0 };
    const run = { id: "run-a", nativeId: "native-a", source: "codex" as const, artifactId: artifact.id, projectResolution: "unassigned" as const, counts: { records: 1, turns: 0, messages: 0, actions: 0, unknown: 1 }, segments: [] };
    const bundle = { projects: [], artifact, run, chunks: [{ runId: run.id, sequence: 0, turns: [], actions: [] }] };
    const sdk = new FoldSdk(database.store(tenant));
    await sdk.importTranscript(context, bundle, { importId: "import-a", importedAt: 1 });
    await sdk.importTranscript(context, { ...bundle, artifact: { ...artifact, id: "artifact-b", sha256: "b".repeat(64) }, run: { ...run, id: "run-b", nativeId: "native-b", artifactId: "artifact-b" }, chunks: [{ ...bundle.chunks[0], runId: "run-b" }] }, { importId: "import-b", importedAt: 10 });
    const snapshot = { ...bundle, artifact: { ...artifact, id: "artifact-c", sha256: "c".repeat(64) }, run: { ...run, artifactId: "artifact-c", counts: { ...run.counts, records: 2 } } };
    const selection = { kinds: ["transcript.project-recorded", "transcript.artifact-imported", "transcript.run-imported", "transcript.chunk-imported"], transcriptChunkRunIds: [run.id, `${run.id}:snapshot:${"c".repeat(16)}`] };
    const selected = () => new FoldSdk(database.store(tenant, selection));
    const imported = await selected().importTranscript(context, snapshot, { importId: "snapshot", importedAt: 20 });
    expect(imported.run.id).toBe(selection.transcriptChunkRunIds[1]);
    expect((await selected().importTranscript(context, snapshot, { importId: "retry", importedAt: 30 })).events).toHaveLength(0);
    expect((await selected().importTranscript(context, bundle, { importId: "retry-original", importedAt: 40 })).events).toHaveLength(0);
    await expect(selected().importTranscript(context, { ...snapshot, chunks: [{ ...snapshot.chunks[0], turns: [{ id: "changed", ordinal: 0, messageCount: 0, actionCount: 0, roles: [] }] }] }, { importId: "conflict", importedAt: 50 })).rejects.toThrow(/changed after import/);
    const entries = await database.readEntries(tenant, selection);
    expect(entries.filter(({ event }) => event.kind === "transcript.run-imported")).toHaveLength(3);
    expect(entries.filter(({ event }) => event.kind === "transcript.chunk-imported")).toHaveLength(2);
    expect((await selected().transcriptRuns(access))).toHaveLength(3);
  });

  it("projects retrospective verdicts consistently and prevents concurrent review forks", async () => {
    const tenant = { organizationId: `outcomes-${workspaceId}`, workspaceId: "outcomes" };
    const access = { principalId: "operator", workspaceId: tenant.workspaceId, workspaceRole: "owner" as const, spaceRoles: { private: "reader" as const } };
    const context = { access, author: { kind: "human" as const, id: "operator" }, capture: { scope: { workspace: tenant.workspaceId, space: "private" }, identity: { principal: "operator", workspace: tenant.workspaceId } } };
    const sdk = new FoldSdk(database.store(tenant));
    const stamp = (id: string, t: number) => ({ id, t, worldDate: "2026-09-10" });
    await sdk.recordTrajectoryTree(context, stamp("tree", 1), { taskId: "task", rootNodeId: "root", nodes: [{ id: "root", kind: "observation", label: "Observed response" }], edges: [] });
    await sdk.recordTrajectory(context, stamp("run", 2), { id: "run-a", taskId: "task", model: { id: "test" }, outcome: "success", steps: [{ id: "step", stepNumber: 1, role: "model_output", content: "Response" }], assignments: { step: { kind: "mapped", nodeId: "root", method: { kind: "manual", id: "test" } } } });
    const review = { taskId: "task", trajectoryId: "run-a", outcome: "failure" as const, reason: "Operator reproduced the broken refresh", previousEventId: null };
    const results = await Promise.allSettled([
      new FoldSdk(database.store(tenant)).recordTrajectoryOutcome(context, stamp("review-a", 3), review),
      new FoldSdk(database.store(tenant)).recordTrajectoryOutcome(context, stamp("review-b", 4), review),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    const history = await new FoldSdk(database.store(tenant)).trajectoryOutcomes(access, "task", "run-a");
    expect(history).toHaveLength(1);
    await new FoldSdk(database.store(tenant)).recordTrajectoryOutcome(context, stamp("withdraw", 6), { ...review, outcome: "unknown", previousEventId: history[0]!.eventId });
    const selected = new FoldSdk(database.store(tenant, { kindPrefixes: ["trajectory."], trajectoryTaskId: "task" }));
    expect((await selected.trajectoryReport(access, "task"))?.outcomeCounts).toEqual({ success: 0, failure: 0, unknown: 1 });
    expect((await database.workspaceTrajectoryTasks(tenant, access, { limit: 100 })).tasks).toMatchObject([{ taskId: "task", successCount: 0, failureCount: 0, unknownCount: 1, lastRecordedAt: 6 }]);
    expect((await database.workspaceDataQuality(tenant, access)).trajectories).toMatchObject({ runs: 1, successful: 0, failed: 0, unknown: 1, reviewed: 1 });
    const hidden = { ...access, spaceRoles: {} };
    expect((await database.workspaceTrajectoryTasks(tenant, hidden, { limit: 100 })).tasks).toEqual([]);
    expect((await database.workspaceDataQuality(tenant, hidden)).trajectories.runs).toBe(0);
    expect(await database.readEntries({ ...tenant, organizationId: "unrelated" })).toHaveLength(0);
  });

  it("counts revised evidence, including removal and late-arriving revisions, without leaking scopes", async () => {
    const tenant = { organizationId: `quality-${workspaceId}`, workspaceId: "quality" };
    const store = database.store(tenant);
    const access = { principalId: "test-user", workspaceId: tenant.workspaceId, workspaceRole: "owner" as const, spaceRoles: {} };
    const append = async (id: string, t: number, kind: string, after: Record<string, unknown>, creator?: string) => {
      const base = entry(id, t);
      await store.append({ ...base, event: parseEvent({ ...base.event, kind,
        capture: { scope: { workspace: tenant.workspaceId, ...(creator === undefined ? {} : { creator }) } },
        changes: [{ ...base.event.changes[0], after }],
      }) });
    };
    await append("quality-memory", 1, "memory.recorded", { memory: { id: "memory-a" } });
    expect((await database.workspaceDataQuality(tenant, access)).memories).toMatchObject({ total: 1, withEvidence: 0 });
    await append("quality-evidence", 2, "memory.revised", { memoryId: "memory-a", patch: { evidence: [{ eventId: "source-a" }] } });
    expect((await database.workspaceDataQuality(tenant, access)).memories.withEvidence).toBe(1);
    await append("quality-summary", 3, "memory.revised", { memoryId: "memory-a", patch: { summary: "Edited" } });
    expect((await database.workspaceDataQuality(tenant, access)).memories.withEvidence).toBe(1);
    await append("quality-remove", 5, "memory.revised", { memoryId: "memory-a", patch: { evidence: [] } });
    await append("quality-late", 4, "memory.revised", { memoryId: "memory-a", patch: { evidence: [{ eventId: "late" }] } });
    await append("quality-private", 6, "memory.revised", { memoryId: "memory-a", patch: { evidence: [{ eventId: "private" }] } }, "another-user");
    expect((await database.workspaceDataQuality(tenant, access)).memories.withEvidence).toBe(0);
    await append("quality-forgotten", 7, "memory.forgotten", { memoryId: "memory-a" });
    expect((await database.workspaceDataQuality(tenant, access)).memories).toMatchObject({ total: 0, withEvidence: 0 });
  });

  it("isolates the same workspace and event identifiers across organizations", async () => {
    const left = database.store({ organizationId: `org-left-${workspaceId}`, workspaceId: "shared" });
    const right = database.store({ organizationId: `org-right-${workspaceId}`, workspaceId: "shared" });
    await left.append(entry("same-event", 1));
    await expect(right.read()).resolves.toMatchObject({ entries: [] });
    await right.append(entry("same-event", 1));
    await expect(left.read()).resolves.toMatchObject({ entries: [{ event: { id: "same-event" } }] });
    await expect(right.read()).resolves.toMatchObject({ entries: [{ event: { id: "same-event" } }] });
  });

  it("enforces the production RLS role guard", async () => {
    const pool = new Pool({ connectionString: connectionString! });
    const role = await pool.query<{ readonly rolsuper: boolean; readonly rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    );
    const rowSecurity = await pool.query<{ readonly row_security: string }>("SHOW row_security");
    await pool.end();

    const strictDatabase = new PostgresFoldDatabase({
      connectionString: connectionString!,
      schema,
      requireRlsEnforcement: true,
    });
    try {
      if (role.rows[0]?.rolsuper === true || role.rows[0]?.rolbypassrls === true) {
        await expect(strictDatabase.open()).rejects.toThrow(/superuser or BYPASSRLS/);
      } else if (rowSecurity.rows[0]?.row_security !== "on") {
        await expect(strictDatabase.open()).rejects.toThrow(/row_security=on/);
      } else {
        await expect(strictDatabase.open()).resolves.toBeUndefined();
      }
    } finally {
      await strictDatabase.close();
    }
  });

  it("rolls back an entire invalid append batch", async () => {
    const atomicWorkspace = `${workspaceId}-atomic`;
    const store = database.store(atomicWorkspace);
    await store.append(entry("event-z", 5));
    await expect(store.appendMany!([
      entry("event-first", 6),
      entry("event-y", 5),
    ])).rejects.toBeInstanceOf(PostgresFoldConflictError);
    await expect(store.read()).resolves.toMatchObject({
      entries: [{ event: { id: "event-z" } }],
    });
  });

  it("resumes equivalent imports and rejects changed records", async () => {
    const importedWorkspace = `${workspaceId}-import`;
    const original = entry("event-import", 3);
    await expect(database.importEntries(importedWorkspace, [original])).resolves.toBe(1);
    await expect(database.importEntries(importedWorkspace, [original])).resolves.toBe(0);
    await expect(database.importEntries(importedWorkspace, [{ ...original, status: "draft" }]))
      .rejects.toBeInstanceOf(PostgresFoldConflictError);
  });

  it("persists monotonic consumer cursors", async () => {
    await expect(database.consumerCursor(workspaceId, "hermes-a")).resolves.toBeUndefined();
    await database.commitConsumerCursor(workspaceId, "hermes-a", { t: 4, eventId: "event-d" });
    await expect(database.consumerCursor(workspaceId, "hermes-a")).resolves.toEqual({
      t: 4,
      eventId: "event-d",
    });
    await expect(database.commitConsumerCursor(
      workspaceId,
      "hermes-a",
      { t: 3, eventId: "event-c" },
    )).rejects.toBeInstanceOf(PostgresFoldConflictError);
  });

  it("streams late historical events by ingestion sequence and explicitly replays legacy consumers after restart", async () => {
    const tenant = { organizationId: `ingestion-${workspaceId}`, workspaceId: "late" };
    const original = entry("source-high", 9000);
    await database.appendEntries(tenant, [original]);
    const head = await database.latestIngestionCursor(tenant);
    await database.commitConsumerCursor(tenant, "legacy", { t: 9000, eventId: original.event.id });
    const late = entry("historical", 1);
    await database.appendEntries(tenant, [late]);
    expect((await database.readIngestionPage(tenant, { after: head, limit: 1 })).items.map(({ entry }) => entry.event.id)).toEqual(["historical"]);
    expect((await database.store(tenant).read()).entries.map(({ event }) => event.id)).toEqual(["historical", "source-high"]);
    const before = await database.ingestionConsumerStatus(tenant, "legacy");
    expect(before).toMatchObject({ cursor: null, migrationRequired: true, legacyCursor: { t: 9000 } });
    await expect(database.commitIngestionCursor(tenant, "legacy", head)).rejects.toThrow(/migration required/);
    await database.migrateConsumerCursor(tenant, "legacy");
    const replay = await database.readIngestionPage(tenant, { after: { kind: "ingestion", sequence: "0" }, limit: 1 });
    expect(replay.items.map(({ entry }) => entry.event.id)).toEqual(["source-high"]);
    await database.commitIngestionCursor(tenant, "legacy", replay.items[0]!.cursor);
    await database.migrateConsumerCursor(tenant, "legacy");
    const reopened = new PostgresFoldDatabase({ connectionString: connectionString!, schema });
    try {
      const status = await reopened.ingestionConsumerStatus(tenant, "legacy");
      expect(status).toMatchObject({ cursor: replay.items[0]!.cursor, migrationRequired: false, legacyCursor: before.legacyCursor });
      const remaining = await reopened.readIngestionPage(tenant, { after: status.cursor!, limit: 1 });
      expect(remaining.items.map(({ entry }) => entry.event.id)).toEqual(["historical"]);
      await reopened.commitIngestionCursor(tenant, "legacy", remaining.items[0]!.cursor);
      await expect(reopened.commitIngestionCursor(tenant, "legacy", head)).rejects.toThrow(/backward/);
      await expect(reopened.commitIngestionCursor(tenant, "legacy", { kind: "ingestion", sequence: "9223372036854775807" })).rejects.toThrow(/beyond/);
      expect((await reopened.ingestionConsumerStatus({ ...tenant, organizationId: "elsewhere" }, "legacy")).cursor).toBeNull();
    } finally { await reopened.close(); }
  });

  it("enumerates every numeric ingestion position across 10, 100, and 1000 without loss or duplicates", async () => {
    const isolatedSchema = `ingestion_order_${randomUUID().replaceAll("-", "")}`;
    const isolated = new PostgresFoldDatabase({ connectionString: connectionString!, schema: isolatedSchema });
    const tenant = { organizationId: "ordering", workspaceId: "ordering" };
    try {
      await isolated.appendEntries(tenant, Array.from({ length: 1205 }, (_, index) => entry(`row-${index + 1}`, 1205 - index)));
      const ids: string[] = [];
      const sequences: string[] = [];
      let cursor = { kind: "ingestion" as const, sequence: "0" };
      for (;;) {
        const page = await isolated.readIngestionPage(tenant, { after: cursor, limit: 100 });
        if (page.items.length === 0) break;
        for (const item of page.items) { ids.push(item.entry.event.id); sequences.push(item.cursor.sequence); }
        expect(BigInt(page.scannedThrough!.sequence)).toBeGreaterThan(BigInt(cursor.sequence));
        cursor = page.scannedThrough!;
      }
      const pool = new Pool({ connectionString: connectionString! });
      try {
        await pool.query("BEGIN");
        await pool.query("SELECT set_config('app.organization_id',$1,true)", [tenant.organizationId]);
        const numeric = await pool.query<{ event_id: string; sequence: string }>(`SELECT event_id, sequence::text AS sequence FROM "${isolatedSchema}".fold_events AS e WHERE organization_id=$1 AND workspace_id=$2 ORDER BY e.sequence`, [tenant.organizationId, tenant.workspaceId]);
        expect(ids).toEqual(numeric.rows.map(row => row.event_id));
        expect(sequences).toEqual(numeric.rows.map(row => row.sequence));
        expect(new Set(ids).size).toBe(1205);
        expect(sequences.slice(98, 102)).toEqual(["99", "100", "101", "102"]);
        expect(sequences.slice(998, 1002)).toEqual(["999", "1000", "1001", "1002"]);
        await pool.query("COMMIT");
      } finally { await pool.end(); }
    } finally {
      await isolated.close();
      const pool = new Pool({ connectionString: connectionString! });
      try { await pool.query(`DROP SCHEMA "${isolatedSchema}" CASCADE`); } finally { await pool.end(); }
    }
  });

  it("does not advance readers past a tenant writer that has allocated sequence but not committed", async () => {
    const tenant = { organizationId: `serial-${workspaceId}`, workspaceId: "concurrent" };
    const pool = new Pool({ connectionString: connectionString! });
    const blocker = await pool.connect();
    let pending: Promise<void> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT set_config('app.organization_id',$1,true)", [tenant.organizationId]);
      await blocker.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`fold:${JSON.stringify([tenant.organizationId, tenant.workspaceId])}`]);
      const first = entry("first-uncommitted", 99);
      await blocker.query(`INSERT INTO "${schema}".fold_events (organization_id,workspace_id,t,event_id,kind,status,event) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
        [tenant.organizationId, tenant.workspaceId, first.event.at.t, first.event.id, first.event.kind, first.status, JSON.stringify(first.event)]);
      let committed = false;
      pending = database.appendEntries(tenant, [entry("second-committed", 1)]).then(() => { committed = true; });
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(committed).toBe(false);
      expect((await database.readIngestionPage(tenant)).items).toEqual([]);
      expect(await database.latestIngestionCursor(tenant)).toEqual({ kind: "ingestion", sequence: "0" });
      await blocker.query("COMMIT");
      await pending;
      const page = await database.readIngestionPage(tenant);
      expect(page.items.map(({ entry }) => entry.event.id)).toEqual(["first-uncommitted", "second-committed"]);
      expect(BigInt(page.items[0]!.cursor.sequence)).toBeLessThan(BigInt(page.items[1]!.cursor.sequence));
    } finally {
      await blocker.query("ROLLBACK"); blocker.release();
      await pending?.catch(() => undefined); await pool.end();
    }
  });

  it("resets an expected ingestion cursor to replay zero with an append-only audit and retained legacy offset", async () => {
    const tenant = { organizationId: `reset-${workspaceId}`, workspaceId: "reset" };
    await database.appendEntries(tenant, [entry("reset-event", 20)]);
    const head = await database.latestIngestionCursor(tenant);
    const legacy = { t: 20, eventId: "reset-event" };
    await database.commitConsumerCursor(tenant, "worker", legacy);
    await database.migrateConsumerCursor(tenant, "worker");
    await database.commitIngestionCursor(tenant, "worker", head);
    await database.commitIngestionCursor(tenant, "other-worker", head);
    await expect(database.resetConsumerCursor(tenant, "worker", "operator", { kind: "ingestion", sequence: "0" }, "Repair ingestion sequence ordering")).rejects.toThrow(/changed/);
    const raced = await Promise.allSettled([
      database.resetConsumerCursor(tenant, "worker", "operator", head, "Repair ingestion sequence ordering"),
      database.resetConsumerCursor(tenant, "worker", "operator", head, "Repair ingestion sequence ordering"),
    ]);
    expect(raced.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(raced.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(await database.ingestionConsumerStatus(tenant, "worker")).toMatchObject({ cursor: { kind: "ingestion", sequence: "0" }, legacyCursor: legacy, migrationRequired: false });
    expect((await database.ingestionConsumerStatus(tenant, "other-worker")).cursor).toEqual(head);
    expect((await database.readIngestionPage(tenant, { after: { kind: "ingestion", sequence: "0" } })).items).toHaveLength(1);
    const pool = new Pool({ connectionString: connectionString! });
    const client = await pool.connect();
    try {
      await client.query("BEGIN"); await client.query("SELECT set_config('app.organization_id',$1,true)", [tenant.organizationId]);
      const audit = await client.query(`SELECT consumer_id,actor_id,previous_sequence::text,next_sequence::text,reason FROM "${schema}".fold_ingestion_cursor_resets WHERE organization_id=$1 AND workspace_id=$2`, [tenant.organizationId, tenant.workspaceId]);
      expect(audit.rows).toEqual([{ consumer_id: "worker", actor_id: "operator", previous_sequence: head.sequence, next_sequence: "0", reason: "Repair ingestion sequence ordering" }]);
      await client.query("SELECT set_config('app.organization_id',$1,true)", ["foreign"]);
      expect((await client.query(`SELECT * FROM "${schema}".fold_ingestion_cursor_resets WHERE organization_id=$1`, [tenant.organizationId])).rows).toEqual([]);
      await client.query("COMMIT");
    } finally { client.release(); await pool.end(); }
  });

  it("round-trips rebuildable projection checkpoints", async () => {
    await database.saveProjectionCheckpoint(workspaceId, {
      projection: "transcript-catalog-v1",
      through: { t: 4, eventId: "event-d" },
      state: { projects: 71, runs: 760 },
      configurationDigest: "sha256:test",
    });
    await expect(database.projectionCheckpoint(workspaceId, "transcript-catalog-v1"))
      .resolves.toMatchObject({
        projection: "transcript-catalog-v1",
        through: { t: 4, eventId: "event-d" },
        state: { projects: 71, runs: 760 },
        configurationDigest: "sha256:test",
      });
    await expect(database.saveProjectionCheckpoint(workspaceId, {
      projection: "transcript-catalog-v1",
      through: { t: 3, eventId: "event-c" },
      state: {},
      configurationDigest: "sha256:older",
    })).rejects.toBeInstanceOf(PostgresFoldConflictError);
  });

  it("persists memberships, immutable repository enrollment, and platform audits per tenant", async () => {
    const organizationId = `org-admin-${workspaceId}`;
    const tenantWorkspace = "shared";
    await administration.replaceStaticMemberships([{
      organizationId,
      organizationRole: "owner",
      workspaceId: tenantWorkspace,
      workspaceRole: "admin",
      principalId: "principal-a",
      spaceRoles: { "space-a": "reader" },
    }]);
    await expect(administration.resolveMembership(organizationId, tenantWorkspace, "principal-a"))
      .resolves.toMatchObject({ organizationRole: "owner", workspaceRole: "admin" });
    await administration.replaceStaticMemberships([]);
    await expect(administration.resolveMembership(organizationId, tenantWorkspace, "principal-a"))
      .resolves.toBeUndefined();
    const enrolled = await administration.enrollRepository({
      organizationId,
      workspaceId: tenantWorkspace,
      normalizedRemote: "github.com/example/repository",
      projectId: "project-a",
      enrolledBy: "principal-a",
    });
    await expect(administration.enrollRepository({
      organizationId,
      workspaceId: tenantWorkspace,
      normalizedRemote: enrolled.normalizedRemote,
      projectId: "project-b",
      enrolledBy: "principal-a",
    })).rejects.toThrow(/already enrolled/);
    await administration.recordPlatformAccess({
      organizationId,
      workspaceId: tenantWorkspace,
      principalId: "support-a",
      credentialId: "credential-a",
      reason: "Investigating incident SB-42",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await expect(administration.listPlatformAccessAudit(organizationId, tenantWorkspace))
      .resolves.toMatchObject([{ principalId: "support-a", reason: "Investigating incident SB-42" }]);
  });

  it("replaces and revokes external identity bindings and provider memberships", async () => {
    const organizationId = `org-clerk-${workspaceId}`;
    const principalId = "principal-clerk";
    await administration.replaceExternalIdentityBindings(
      "clerk",
      [{ externalId: "org_external", organizationId }],
      [{ externalId: "user:user_external", principalId }],
    );
    await administration.replaceProviderMemberships("clerk", [{
      organizationId,
      organizationRole: "admin",
      workspaceId: "workspace-clerk",
      workspaceRole: "member",
      principalId,
      spaceRoles: {},
    }]);

    await expect(administration.resolveExternalOrganization("clerk", "org_external"))
      .resolves.toBe(organizationId);
    await expect(administration.resolveExternalPrincipal("clerk", "user:user_external"))
      .resolves.toBe(principalId);
    await expect(administration.resolveMembership(organizationId, "workspace-clerk", principalId))
      .resolves.toMatchObject({ organizationRole: "admin", workspaceRole: "member" });

    await administration.replaceExternalIdentityBindings("clerk", [], []);
    await administration.replaceProviderMemberships("clerk", []);
    await expect(administration.resolveExternalOrganization("clerk", "org_external"))
      .resolves.toBeUndefined();
    await expect(administration.resolveExternalPrincipal("clerk", "user:user_external"))
      .resolves.toBeUndefined();
    await expect(administration.resolveMembership(organizationId, "workspace-clerk", principalId))
      .resolves.toBeUndefined();
  });

  it("applies external identity provisioning once and revokes access without deleting tenant data", async () => {
    const externalOrganizationId = `org_webhook_${workspaceId}`;
    const organizationId = `clerk:${externalOrganizationId}`;
    const principalId = "clerk:user:user_webhook";
    const base = {
      provider: "clerk",
      externalOrganizationId,
      organizationId,
      organizationName: "Webhook organization",
    } as const;
    await expect(administration.applyExternalIdentityProvisioningEvent({
      ...base,
      eventId: `membership-${workspaceId}`,
      type: "membership.upsert",
      externalPrincipalId: "user:user_webhook",
      principalId,
      organizationRole: "admin",
      workspaceId: "default",
      workspaceRole: "admin",
    })).resolves.toBe(true);
    await expect(administration.applyExternalIdentityProvisioningEvent({
      ...base,
      eventId: `membership-${workspaceId}`,
      type: "membership.upsert",
      externalPrincipalId: "user:user_webhook",
      principalId,
      organizationRole: "member",
      workspaceId: "default",
      workspaceRole: "member",
    })).resolves.toBe(false);
    await expect(administration.resolveMembership(organizationId, "default", principalId))
      .resolves.toMatchObject({ organizationRole: "admin", workspaceRole: "admin" });

    await database.store({ organizationId, workspaceId: "default" }).append(entry("retained-after-revoke", 1));
    await administration.applyExternalIdentityProvisioningEvent({
      ...base,
      eventId: `deleted-${workspaceId}`,
      type: "organization.delete",
    });
    await expect(administration.resolveExternalOrganization("clerk", externalOrganizationId))
      .resolves.toBeUndefined();
    await expect(administration.resolveMembership(organizationId, "default", principalId))
      .resolves.toBeUndefined();
    await expect(database.store({ organizationId, workspaceId: "default" }).read())
      .resolves.toMatchObject({ entries: [{ event: { id: "retained-after-revoke" } }] });
  });

  it("provisions and revokes an organization-scoped machine credential", async () => {
    const organizationId = `org-machine-${workspaceId}`;
    const principalId = `clerk:machine:worker-${workspaceId}`;
    const common = {
      provider: "clerk",
      externalOrganizationId: `internal:${organizationId}`,
      organizationId,
      externalPrincipalId: `machine:worker-${workspaceId}`,
      workspaceId: "primary",
    } as const;
    await administration.applyExternalIdentityProvisioningEvent({
      ...common,
      eventId: `machine-add-${workspaceId}`,
      type: "credential.upsert",
      principalId,
      organizationRole: "member",
      workspaceRole: "member",
    });
    await expect(administration.resolveExternalPrincipal("clerk", common.externalPrincipalId))
      .resolves.toBe(principalId);
    await expect(administration.resolveMembership(organizationId, "primary", principalId))
      .resolves.toMatchObject({ workspaceRole: "member" });

    await administration.applyExternalIdentityProvisioningEvent({
      ...common,
      eventId: `machine-delete-${workspaceId}`,
      type: "credential.delete",
    });
    await expect(administration.resolveExternalPrincipal("clerk", common.externalPrincipalId))
      .resolves.toBeUndefined();
    await expect(administration.resolveMembership(organizationId, "primary", principalId))
      .resolves.toBeUndefined();
    await expect(administration.listIdentityProvisioningAudit(organizationId))
      .resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ eventType: "credential.upsert", externalPrincipalId: common.externalPrincipalId }),
        expect.objectContaining({ eventType: "credential.delete", externalPrincipalId: common.externalPrincipalId }),
      ]));
  });

  it("indexes authorized memory documents and ranks them through pgvector", async () => {
    const ranker = new PostgresVectorMemoryRanker({
      connectionString: connectionString!,
      schema,
      provider: {
        descriptor: { id: `test-embedding-${workspaceId}`, dimensions: 3 },
        async embed(inputs) {
          return inputs.map((input) => {
            const normalized = input.toLocaleLowerCase();
            return [
              normalized.includes("postgres") ? 1 : 0,
              normalized.includes("sqlite") ? 1 : 0,
              normalized.includes("network") ? 1 : 0,
            ];
          });
        },
      },
    });
    try {
      const result = await ranker.rank({
        workspaceId,
        query: "postgres database",
        limit: 2,
        documents: [
          {
            memoryId: "memory-postgres",
            source: "test",
            summary: "Postgres is canonical",
            content: null,
            tags: ["database"],
            entities: [],
            createdAt: 1,
            updatedAt: 1,
            revision: 0,
          },
          {
            memoryId: "memory-sqlite",
            source: "test",
            summary: "SQLite is local",
            content: null,
            tags: ["database"],
            entities: [],
            createdAt: 2,
            updatedAt: 2,
            revision: 0,
          },
        ],
      });
      expect(result[0]).toMatchObject({ memoryId: "memory-postgres", score: 1 });
      expect(result[1]).toMatchObject({ memoryId: "memory-sqlite", score: 0 });

      const sharedDocument = (summary: string) => ({
        memoryId: "memory-shared",
        source: "test",
        summary,
        content: null,
        tags: ["database"],
        entities: [],
        createdAt: 3,
        updatedAt: 3,
        revision: 0,
      });
      const leftRequest = {
        organizationId: `vector-left-${workspaceId}`,
        workspaceId: "shared",
        query: "postgres database",
        limit: 1,
        documents: [sharedDocument("Postgres tenant memory")],
      };
      await expect(ranker.rank(leftRequest)).resolves.toMatchObject([{ score: 1 }]);
      await expect(ranker.rank({
        ...leftRequest,
        organizationId: `vector-right-${workspaceId}`,
        documents: [sharedDocument("SQLite tenant memory")],
      })).resolves.toMatchObject([{ score: 0 }]);
      await expect(ranker.rank(leftRequest)).resolves.toMatchObject([{ score: 1 }]);
    } finally {
      await ranker.close();
    }
  });
});
