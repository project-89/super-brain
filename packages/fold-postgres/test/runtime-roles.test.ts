import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresFoldDatabase, PostgresTenantAdministration, grantPostgresRuntimePrivileges, withRecoveryBarrier, readRecoveryEventPages } from "../src/index.js";

const adminUrl = process.env.FOLD_TEST_ADMIN_DATABASE_URL;
const integration = adminUrl === undefined ? describe.skip : describe;

integration("migrated runtime roles and recovery boundary", () => {
  const suffix = randomUUID().replaceAll("-", "");
  const schema = `runtime_${suffix}`;
  const migrator = `m_${suffix}`;
  const runtime = `r_${suffix}`;
  const recovery = `b_${suffix}`;
  const password = randomUUID();
  const roleUrl = (role: string) => { const url = new URL(adminUrl!); url.username = role; url.password = password; return url.toString(); };
  const admin = new Pool({ connectionString: adminUrl });
  let database: PostgresFoldDatabase | undefined;
  let tenancy: PostgresTenantAdministration | undefined;

  beforeAll(async () => {
    const db = (await admin.query<{ name: string }>("SELECT current_database() AS name")).rows[0]!.name.replaceAll('"', '""');
    for (const [role, bypass] of [[migrator, false], [runtime, false], [recovery, true]] as const) {
      await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE ${bypass ? "BYPASSRLS" : "NOBYPASSRLS"}`);
      await admin.query(`GRANT CONNECT ON DATABASE "${db}" TO "${role}"`);
    }
    await admin.query(`GRANT CREATE ON DATABASE "${db}" TO "${migrator}"`);
    await admin.query(`CREATE SCHEMA "${schema}" AUTHORIZATION "${migrator}"`);
    const migration = new PostgresFoldDatabase({ connectionString: roleUrl(migrator), schema });
    const migrationTenancy = new PostgresTenantAdministration({ connectionString: roleUrl(migrator), schema });
    try { await Promise.all([migration.open(), migrationTenancy.open()]); }
    finally { await Promise.all([migration.close(), migrationTenancy.close()]); }
    await grantPostgresRuntimePrivileges({ connectionString: roleUrl(migrator), schema, runtimeRole: runtime, recoveryRole: recovery });
    database = new PostgresFoldDatabase({ connectionString: roleUrl(runtime), schema, schemaMode: "verify" });
    tenancy = new PostgresTenantAdministration({ connectionString: roleUrl(runtime), schema, schemaMode: "verify" });
    await Promise.all([database.open(), tenancy.open()]);
  }, 20_000);

  afterAll(async () => {
    await Promise.all([database?.close(), tenancy?.close()]);
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    for (const role of [runtime, recovery, migrator]) {
      await admin.query(`DROP OWNED BY "${role}"`).catch(() => undefined);
      await admin.query(`DROP ROLE IF EXISTS "${role}"`);
    }
    await admin.end();
  });

  it("serves scoped data while refusing DDL, metadata mutation, and RLS bypass", async () => {
    const pool = new Pool({ connectionString: roleUrl(runtime) });
    try {
      await expect(pool.query(`ALTER TABLE "${schema}".fold_events DISABLE ROW LEVEL SECURITY`)).rejects.toMatchObject({ code: "42501" });
      await expect(pool.query(`ALTER TABLE "${schema}".fold_workspace_memberships ADD COLUMN malicious text`)).rejects.toMatchObject({ code: "42501" });
      await expect(pool.query(`UPDATE "${schema}".fold_schema_versions SET version=99`)).rejects.toMatchObject({ code: "42501" });
      await expect(pool.query(`SET ROLE "${migrator}"`)).rejects.toMatchObject({ code: "42501" });
      expect((await pool.query(`SELECT * FROM "${schema}".fold_events`)).rows).toEqual([]);
      await tenancy!.replaceStaticMemberships([{ organizationId: "org", workspaceId: "workspace", principalId: "person", organizationRole: "owner", workspaceRole: "owner", spaceRoles: {} }]);
      expect(await tenancy!.resolveMembership("org", "workspace", "person")).toMatchObject({ principalId: "person" });
    } finally { await pool.end(); }
  });

  it("fails closed on schema-version tampering and rolls back an incompatible migration", async () => {
    await admin.query(`UPDATE "${schema}".fold_schema_versions SET version=999 WHERE component='store'`);
    const old = new PostgresFoldDatabase({ connectionString: roleUrl(runtime), schema, schemaMode: "verify" });
    try { await expect(old.open()).rejects.toThrow(/requires migration/); } finally { await old.close(); }
    const rollback = new PostgresFoldDatabase({ connectionString: roleUrl(migrator), schema });
    try { await expect(rollback.open()).rejects.toThrow(/newer schema/); } finally { await rollback.close(); }
    expect((await admin.query<{ version: number }>(`SELECT version FROM "${schema}".fold_schema_versions WHERE component='store'`)).rows[0]!.version).toBe(999);
    await admin.query(`UPDATE "${schema}".fold_schema_versions SET version=2 WHERE component='store'`);
    await admin.query(`GRANT UPDATE ON "${schema}".fold_schema_versions TO "${runtime}"`);
    const mutable = new PostgresFoldDatabase({ connectionString: roleUrl(runtime), schema, schemaMode: "verify" });
    try { await expect(mutable.open()).rejects.toThrow(/outside its contract/); } finally { await mutable.close(); }
    await admin.query(`REVOKE UPDATE ON "${schema}".fold_schema_versions FROM "${runtime}"`);
  });

  it("exports a snapshot that includes the writer which committed during gate acquisition", async () => {
    const writer = await admin.connect();
    let barrier: Promise<void> | undefined;
    try {
      await writer.query("BEGIN");
      await writer.query("SELECT pg_advisory_xact_lock_shared(hashtext('fold-schema-v1'))");
      const event = { specVersion: "0.7", id: "barrier-event", kind: "test.observed", title: "Snapshot witness", at: { t: 1, worldDate: "2026-09-05" }, author: { kind: "human", id: "person" }, capture: { scope: { organization: "org", workspace: "workspace" } }, changes: [{ verb: "create", subject: "urn:test:barrier", nodeKind: "fact", after: { observed: true }, provenance: { basis: "authored" } }] };
      await writer.query(`INSERT INTO "${schema}".fold_events (organization_id,workspace_id,t,event_id,kind,status,event) VALUES ('org','workspace',1,'barrier-event','test.observed','canon',$1::jsonb)`, [JSON.stringify(event)]);
      barrier = withRecoveryBarrier({ connectionString: roleUrl(recovery), schema }, async (receipt) => {
        expect(BigInt(receipt.maxIngestionPosition)).toBeGreaterThan(0n);
        expect(receipt.snapshotId).toMatch(/^[0-9A-F-]+$/);
        const ids: string[] = [];
        expect(await readRecoveryEventPages({ connectionString: roleUrl(recovery), schema, snapshotId: receipt.snapshotId }, async (page) => { ids.push(...page.map(({ id }) => id)); })).toEqual({ events: 1 });
        expect(ids).toEqual(["barrier-event"]);
        const reader = await admin.connect();
        try {
          await reader.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
          await reader.query(`SET TRANSACTION SNAPSHOT '${receipt.snapshotId}'`);
          expect((await reader.query(`SELECT event_id FROM "${schema}".fold_events WHERE event_id='barrier-event'`)).rows).toEqual([{ event_id: "barrier-event" }]);
        } finally { await reader.query("ROLLBACK"); reader.release(); }
      });
      void barrier.catch(() => undefined);
      let waiting = false;
      for (let index = 0; index < 100; index += 1) {
        waiting = (await admin.query("SELECT 1 FROM pg_stat_activity WHERE usename=$1 AND wait_event='advisory'", [recovery])).rowCount === 1;
        if (waiting) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await writer.query("COMMIT");
      await barrier;
    } finally { await writer.query("ROLLBACK"); writer.release(); await barrier?.catch(() => undefined); }
  }, 15_000);

  it("retains the gate until timed-out work finishes cleanup and rejects runtime recovery credentials", async () => {
    await expect(withRecoveryBarrier({ connectionString: roleUrl(runtime), schema }, async () => undefined)).rejects.toThrow(/dedicated/);
    let signalSeen = false;
    await expect(withRecoveryBarrier({ connectionString: roleUrl(recovery), schema, workTimeoutMs: 10 }, async (_receipt, signal) => {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      signalSeen = true;
      const lock = await admin.query<{ acquired: boolean }>("SELECT pg_try_advisory_lock_shared(hashtext('fold-schema-v1')) AS acquired");
      expect(lock.rows[0]!.acquired).toBe(false);
    })).rejects.toThrow(/deadline/);
    expect(signalSeen).toBe(true);
  });
});
