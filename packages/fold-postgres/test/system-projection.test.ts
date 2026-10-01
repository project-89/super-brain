import { randomUUID } from "node:crypto";

import { fold, parseEvent, serializeFoldState, sortLog, type FoldLogEntry } from "@_89/fold";
import { authorizeEventAccess, FoldSdk, type FoldSdkAccessContext } from "@_89/fold-sdk";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PostgresFoldDatabase } from "../src/index.js";
import { systemProjectionKey } from "../src/system-projection.js";

const connectionString = process.env.FOLD_TEST_DATABASE_URL;
const integrationDescribe = connectionString === undefined ? describe.skip : describe;

integrationDescribe("durable System projection", () => {
  const schema = `system_test_${randomUUID().replaceAll("-", "")}`;
  const tenant = { organizationId: "organization-a", workspaceId: "workspace-a" };
  const access: FoldSdkAccessContext = { ...tenant, principalId: "operator", workspaceRole: "owner", spaceRoles: {} };
  const options = { connectionString: connectionString!, schema, requireRlsEnforcement: true };
  let database: PostgresFoldDatabase;
  let pool: Pool;

  const event = (id: string, t: number, changes: unknown[], scope: Record<string, string> = {}, status: FoldLogEntry["status"] = "canon"): FoldLogEntry => ({
    status,
    event: parseEvent({ specVersion: "0.7", id, at: { t, worldDate: "2026-09-11" }, kind: "system.test", title: id,
      author: { kind: "human", id: "operator" }, capture: { scope: { workspace: tenant.workspaceId, ...scope } },
      changes: changes.map((change) => ({ ...(change as object), provenance: { basis: "authored" } })),
    }),
  });
  const create = (subject: string, after: object = {}) => ({ verb: "create", subject, nodeKind: "fact", after });
  const oracle = async (who = access, include: "canon" | "canon+draft" = "canon") => {
    const entries = sortLog((await database.readEntries(tenant)).filter((entry) =>
      (include === "canon+draft" || entry.status === "canon") && authorizeEventAccess(entry.event, who).allowed));
    const projected = await new FoldSdk(database.store(tenant)).systemProjection(who, include);
    expect(serializeFoldState(projected.state)).toBe(serializeFoldState(fold(entries, {
      include: "canon+draft", existingCreate: "replace", retainApplied: false,
    })));
    expect(projected.appliedEventCount).toBe(entries.length);
    expect(projected.appliedChangeCount).toBe(entries.reduce((n, entry) => n + entry.event.changes.length, 0));
    return projected;
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString });
    database = new PostgresFoldDatabase(options);
    await database.open();
  });
  afterAll(async () => {
    await database.close();
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  });

  it("matches replay across append, late arrivals, deletes, diagnostics and drafts", async () => {
    expect((await oracle()).appliedEventCount).toBe(0);
    await database.appendEntries(tenant, [event("initial", 10, [create("urn:a", { old: "remove-me", "drama.tension": 0.2 })])]);
    await oracle();
    await database.appendEntries(tenant, [event("replace", 30, [create("urn:a", { "drama.tension": 0.4 })]),
      event("link", 40, [{ verb: "link", subject: "urn:a", object: "urn:b", edgeType: "related", edgeId: "edge" }])]);
    await oracle();
    await database.appendEntries(tenant, [event("late", 20, [create("urn:b", { text: "arrived late" })])]);
    await oracle();
    await database.appendEntries(tenant, [event("unlink", 50, [{ verb: "unlink", subject: "urn:a", object: "urn:b", edgeType: "related", edgeId: "edge" }]),
      event("adjust", 60, [{ verb: "adjust", subject: "urn:a", component: "drama.tension", amount: 0.8, before: 0, after: 1 }]),
      event("merge", 70, [{ verb: "merge", subject: "urn:a", object: "urn:b", before: {}, after: null }]),
      event("draft", 80, [create("urn:draft")], {}, "draft")]);
    await oracle();
    expect((await oracle(access, "canon+draft")).state.nodes.has("urn:draft")).toBe(true);
  });

  it("isolates authorization variants, revocation, private creators and platform reads", async () => {
    await database.appendEntries(tenant, [event("space", 90, [create("urn:space")], { space: "secret" }),
      event("creator", 100, [create("urn:creator")], { creator: "other" })]);
    const allowed = { ...access, spaceRoles: { secret: "reader" as const } };
    expect((await oracle(allowed)).state.nodes.has("urn:space")).toBe(true);
    expect((await oracle(access)).state.nodes.has("urn:space")).toBe(false);
    expect((await oracle(access)).state.nodes.has("urn:creator")).toBe(false);
    expect((await oracle({ ...access, principalId: "other" })).state.nodes.has("urn:creator")).toBe(true);
    expect((await oracle({ ...access, platformDataAccess: true })).state.nodes.has("urn:creator")).toBe(true);
    expect((await oracle(access)).state.nodes.has("urn:creator")).toBe(false);
    await expect(database.systemProjection(tenant, { ...access, organizationId: "wrong" }, "canon")).rejects.toThrow("tenant mismatch");
    const otherTenant = { ...tenant, organizationId: "organization-b" };
    await database.appendEntries(otherTenant, [event("other-tenant", 1, [create("urn:other")])]);
    const other = await database.systemProjection(otherTenant, { ...access, ...otherTenant }, "canon");
    expect([...other.state.nodes.keys()]).toEqual(["urn:other"]);
    expect((await oracle()).state.nodes.has("urn:other")).toBe(false);
  });

  it("restores per-cell checkpoints after restart without rewriting them and resumes deltas", async () => {
    const before = await oracle();
    const updatedAt = async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.organization_id', $1, true)", [tenant.organizationId]);
        const result = await client.query(`SELECT updated_at FROM "${schema}".fold_projection_checkpoints WHERE projection = $1`, [systemProjectionKey(access, "canon")]);
        await client.query("COMMIT");
        return result.rows[0].updated_at;
      } finally { client.release(); }
    };
    const saved = await updatedAt();
    await database.close();
    database = new PostgresFoldDatabase(options);
    await database.open();
    const restored = await oracle();
    expect(serializeFoldState(restored.state)).toBe(serializeFoldState(before.state));
    expect(await updatedAt()).toEqual(saved);
    await database.appendEntries(tenant, [event("after-restart", 110, [create("urn:restart")])]);
    await oracle();
    await database.appendEntries(tenant, [event("late-after-restart", 15, [create("urn:late-restart")])]);
    await oracle();
    expect((await pool.query(`SELECT count(*)::int AS count FROM "${schema}".fold_system_projection_cells`)).rows[0].count).toBe(0);
  });

  it("rolls back a failed reducer without changing the previous checkpoint", async () => {
    const isolated = { ...tenant, workspaceId: "failure" };
    const who = { ...access, ...isolated };
    await database.systemProjection(isolated, who, "canon");
    const bad = event("bad", 1, [{ verb: "adjust", subject: "urn:a", component: "x.undeclared", amount: 1, before: 0, after: 1 }], { workspace: isolated.workspaceId });
    await database.appendEntries(isolated, [bad]);
    await expect(database.systemProjection(isolated, who, "canon")).rejects.toThrow("declared numeric");
    expect((await database.projectionCheckpoint(isolated, systemProjectionKey(who, "canon")))?.state).toMatchObject({ sequence: "0", appliedEventCount: 0 });
  });

  it("does not retain stale cells when two processes advance the same projection", async () => {
    const other = new PostgresFoldDatabase(options);
    try {
      await oracle();
      await database.appendEntries(tenant, [event("concurrent-link", 120, [{ verb: "link", subject: "urn:a", object: "urn:b", edgeType: "related", edgeId: "temporary-edge" }])]);
      expect((await other.systemProjection(tenant, access, "canon")).state.edges.has("temporary-edge")).toBe(true);
      await database.appendEntries(tenant, [event("concurrent-unlink", 130, [{ verb: "unlink", subject: "urn:a", object: "urn:b", edgeType: "related", edgeId: "temporary-edge" }])]);
      const next = await oracle();
      expect(next.state.edges.has("temporary-edge")).toBe(false);
      await other.close();
      const restored = new PostgresFoldDatabase(options);
      try {
        expect(serializeFoldState((await restored.systemProjection(tenant, access, "canon")).state)).toBe(serializeFoldState(next.state));
      } finally { await restored.close(); }
    } finally { await other.close(); }
  });

  it("keeps equal-time UTF-16 ordering intact across cursor batches", async () => {
    const isolated = { ...tenant, workspaceId: "boundary" };
    const who = { ...access, ...isolated };
    const ids = [...Array.from({ length: 505 }, (_, index) => `batch-${String(index).padStart(4, "0")}`), "batch-\ud800\udc00", "batch-\ue000"];
    const entries = ids.map((id) => event(id, 1, [create("urn:replaced", { winner: id })], { workspace: isolated.workspaceId }));
    await database.appendEntries(isolated, entries);
    const result = await database.systemProjection(isolated, who, "canon");
    expect(serializeFoldState(result.state)).toBe(serializeFoldState(fold(entries, { include: "canon", existingCreate: "replace", retainApplied: false })));
    expect(result.appliedEventCount).toBe(entries.length);
  });

  it("does not rebuild on later same-timestamp IDs or invisible older arrivals", async () => {
    const isolated = { ...tenant, workspaceId: "late-visibility" };
    const who = { ...access, ...isolated };
    await database.appendEntries(isolated, [event("same-a", 10, [create("urn:same-a")], { workspace: isolated.workspaceId })]);
    const initial = await database.systemProjection(isolated, who, "canon");
    await database.appendEntries(isolated, [event("same-b", 10, [create("urn:same-b")], { workspace: isolated.workspaceId })]);
    const second = await database.systemProjection(isolated, who, "canon");
    expect(second.state.nodes.get("urn:same-a")).toBe(initial.state.nodes.get("urn:same-a"));
    await database.appendEntries(isolated, [event("hidden-old", 1, [create("urn:hidden-old")], { workspace: isolated.workspaceId, creator: "other" })]);
    const hidden = await database.systemProjection(isolated, who, "canon");
    expect(hidden.state.nodes.get("urn:same-a")).toBe(initial.state.nodes.get("urn:same-a"));
    expect(hidden.appliedEventCount).toBe(2);
  });
});
