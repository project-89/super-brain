import { randomUUID } from "node:crypto";

import { parseEvent, type FoldLogEntry } from "@_89/fold";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PostgresFoldConflictError,
  PostgresFoldDatabase,
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
  const workspaceId = `test-${randomUUID()}`;
  let database: PostgresFoldDatabase;

  beforeAll(async () => {
    database = new PostgresFoldDatabase({ connectionString: connectionString! });
    await database.open();
  });

  afterAll(async () => {
    await database.close();
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

  it("indexes authorized memory documents and ranks them through pgvector", async () => {
    const ranker = new PostgresVectorMemoryRanker({
      connectionString: connectionString!,
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
    } finally {
      await ranker.close();
    }
  });
});
