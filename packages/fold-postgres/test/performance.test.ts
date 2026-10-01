import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { FoldSdk, type MemoryRankingRequest } from "@_89/fold-sdk";
import { PostgresFoldDatabase, PostgresVectorMemoryRanker } from "../src/index.js";

const url = process.env.FOLD_TEST_DATABASE_URL;
const suite = url === undefined ? describe.skip : describe;
const tenant = { organizationId: "performance-test-org", workspaceId: "performance-test-workspace" };
const access = { ...tenant, principalId: "owner", workspaceRole: "owner" as const, spaceRoles: {} };
const context = { access, author: { kind: "human" as const, id: "owner" }, capture: { scope: { workspace: tenant.workspaceId }, identity: { workspace: tenant.workspaceId, principal: "owner" } } };
const id = "01890f47-7c00-7000-8000-000000000001";
const stamp = (name: string, t: number) => ({ id: name, t, worldDate: "2026-09-05" });
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const schema = `fold_perf_${randomUUID().replaceAll("-", "")}`;
  const database = new PostgresFoldDatabase({ connectionString: url!, schema, eventPageSize: 1 });
  await database.open();
  cleanups.push(async () => { const pool = new Pool({ connectionString: url! }); await pool.query(`DROP SCHEMA "${schema}" CASCADE`); await pool.end(); });
  cleanups.push(() => database.close());
  return { schema, database };
}

suite("bounded exact snapshot and embedding runtime", () => {
  it("does not let a later reader join a flight pinned before a completed forget", async () => {
    const { database, schema } = await fixture();
    const writer = new PostgresFoldDatabase({ connectionString: url!, schema }); cleanups.push(() => writer.close());
    const sdk = new FoldSdk(writer.store(tenant));
    await sdk.recordMemory(context, stamp("created", 100), { id, audience: "workspace", source: "test", applicability: { kind: "global" } });
    const internal = database as unknown as { tenantQuery: (...args: any[]) => Promise<any> };
    const query = internal.tenantQuery.bind(database);
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    let first = true;
    internal.tenantQuery = async (...args) => { if (first && String(args[1]).includes("ORDER BY sequence LIMIT")) { first = false; entered(); await held; } return query(...args); };
    const before = database.readSnapshot(tenant); await started;
    await sdk.forgetMemory(context, stamp("forgotten", 200), id, "committed while earlier reader waits");
    let observed!: () => void; const minimumSeen = new Promise<void>((resolve) => { observed = resolve; });
    const revision = database.workspaceRevision.bind(database);
    database.workspaceRevision = async (scope) => { const result = await revision(scope); observed(); return result; };
    const after = database.readSnapshot(tenant);
    try { await minimumSeen; } finally { release(); }
    expect((await before).entries.map(({ event }) => event.id)).toEqual(["created"]);
    expect((await after).entries.map(({ event }) => event.id)).toEqual(["created", "forgotten"]);
    expect(await new FoldSdk(database.store(tenant)).recallMemories(access)).toEqual([]);
  });

  it("persists a light read checkpoint, reuses it on restart, and rejects obsolete ingestion metadata", async () => {
    const { database, schema } = await fixture();
    const sdk = new FoldSdk(database.store(tenant));
    await sdk.recordMemory(context, stamp("created", 100), { id, audience: "workspace", source: "test", applicability: { kind: "global" } });
    const expected = await sdk.recallMemories(access);
    const restarted = new PostgresFoldDatabase({ connectionString: url!, schema }); cleanups.push(() => restarted.close());
    const internal = restarted as unknown as { tenantQuery: (...args: any[]) => Promise<any> };
    const query = internal.tenantQuery.bind(restarted); let pages = 0;
    internal.tenantQuery = async (...args) => { if (String(args[1]).includes("ORDER BY sequence LIMIT")) pages++; return query(...args); };
    expect(await new FoldSdk(restarted.store(tenant)).recallMemories(access)).toEqual(expected); expect(pages).toBe(0);
    const snapshot = await database.readSnapshot(tenant);
    expect(() => { (snapshot.entries[0]!.event.changes[0] as any).after.memory.summary = "mutated"; }).toThrow();
    await sdk.forgetMemory(context, stamp("forgotten", 200), id, "invalidate checkpoint");
    expect(await new FoldSdk(restarted.store(tenant)).recallMemories(access)).toEqual([]); expect(pages).toBeGreaterThan(0);
  });

  const document = (revision: number, summary: string) => ({ memoryId: id, revision, source: "test", summary, content: null, tags: [], entities: [], createdAt: 100, updatedAt: 100 + revision });
  const request = (revision: number, summary: string): MemoryRankingRequest => ({ ...tenant, query: "banana", limit: 1, documents: [document(revision, summary)] });
  const vector = (text: string) => text.includes("banana") ? [0, 1, 0] : [1, 0, 0];

  it("keeps newer embeddings when an older process finishes later and filters exact requested revisions", async () => {
    const { schema } = await fixture();
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const old = new PostgresVectorMemoryRanker({ connectionString: url!, schema, provider: { descriptor: { id: "same-config", dimensions: 3 }, async embed(inputs) { entered(); await held; return inputs.map(vector); } } });
    const current = new PostgresVectorMemoryRanker({ connectionString: url!, schema, provider: { descriptor: { id: "same-config", dimensions: 3 }, async embed(inputs) { return inputs.map(vector); } } });
    cleanups.push(() => old.close(), () => current.close());
    const pending = old.refresh(request(0, "apple")); await started;
    try { await current.refresh(request(1, "banana")); } finally { release(); }
    await pending;
    expect(await current.rankWithMetadata(request(1, "banana"))).toMatchObject({ ranking: { kind: "semantic" }, candidates: [{ memoryId: id, score: 1 }] });
    expect(await current.rankWithMetadata(request(0, "apple"))).toMatchObject({ ranking: { kind: "lexical" } });
  });

  it("falls back with bounded physical calls when a provider ignores deadlines and shutdown", async () => {
    const { schema } = await fixture(); let calls = 0;
    const ranker = new PostgresVectorMemoryRanker({ connectionString: url!, schema, queryTimeoutMs: 10, refreshTimeoutMs: 10, provider: { descriptor: { id: "never", dimensions: 3 }, embed: async () => { calls++; return new Promise(() => undefined); } } });
    cleanups.push(() => ranker.close());
    for (let i = 0; i < 8; i++) expect((await ranker.rankWithMetadata(request(0, "banana"))).ranking.kind).toBe("lexical");
    expect(calls).toBeLessThanOrEqual(4); expect(ranker.refreshStatus().providerCalls).toBeLessThanOrEqual(4);
    await ranker.close();
  });
});
