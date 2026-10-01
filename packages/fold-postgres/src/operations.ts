import { Pool, type PoolClient } from "pg";
import { EMBEDDING_SCHEMA, postgresIdentifier, STORE_SCHEMA, TENANCY_SCHEMA, verifyPostgresSchema } from "./schema.js";

export interface PostgresOperationsOptions {
  readonly connectionString: string;
  readonly schema?: string;
  readonly embeddings?: boolean;
  readonly verifyRuntimeRole?: boolean;
}

/** Dedicated bounded pool, so saturated request pools cannot queue health work.
 * Use through a single-flight readiness controller. Both server and client
 * query deadlines apply; failed/cancelled clients are destroyed, not reused. */
export class PostgresOperations {
  private readonly pool: Pool;
  private readonly schema: string;
  private readingLag = false;
  constructor(private readonly options: PostgresOperationsOptions) {
    this.schema = options.schema ?? "public";
    postgresIdentifier(this.schema);
    this.pool = new Pool({ connectionString: options.connectionString, max: 1,
      connectionTimeoutMillis: 1_000, statement_timeout: 1_000, query_timeout: 1_500,
      idleTimeoutMillis: 5_000 });
    // Health reports errors through its returned observation, never an unhandled
    // pool error or a log containing connection configuration.
    this.pool.on("error", () => undefined);
  }

  async probe(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const client = await this.pool.connect();
    let released = false;
    const release = (destroy: boolean) => { if (!released) { released = true; client.release(destroy); } };
    const abort = () => release(true);
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      await client.query("BEGIN READ ONLY");
      await client.query("SELECT pg_advisory_xact_lock_shared(hashtext('fold-schema-v1'))");
      if (this.options.verifyRuntimeRole === true) {
        await verifyPostgresSchema(client, this.schema, STORE_SCHEMA);
        await verifyPostgresSchema(client, this.schema, TENANCY_SCHEMA);
        if (this.options.embeddings === true) await verifyPostgresSchema(client, this.schema, EMBEDDING_SCHEMA);
      } else {
        const result = await client.query<{ component: string; version: number }>(`SELECT component, version FROM ${postgresIdentifier(this.schema)}.fold_schema_versions`);
        const versions = new Map(result.rows.map((row) => [row.component, row.version]));
        for (const contract of [STORE_SCHEMA, TENANCY_SCHEMA, ...(this.options.embeddings === true ? [EMBEDDING_SCHEMA] : [])]) {
          if (versions.get(contract.component) !== contract.version) throw new Error("Required schema version is unavailable");
        }
      }
      await client.query("COMMIT");
      signal.throwIfAborted();
      release(false);
    } catch (error) { release(true); throw error; }
    finally { signal.removeEventListener("abort", abort); }
  }

  close(): Promise<void> { return this.pool.end(); }

  async consumerLag(tenant: { readonly organizationId: string; readonly workspaceId: string }): Promise<Readonly<Record<string, unknown>>> {
    if (this.readingLag) return { status: "unknown", reason: "probe_busy" };
    this.readingLag = true;
    let client: PoolClient | undefined;
    try {
      client = await this.pool.connect();
      await client.query("BEGIN READ ONLY");
      await client.query("SELECT pg_advisory_xact_lock_shared(hashtext('fold-schema-v1'))");
      await client.query("SELECT set_config('app.organization_id', $1, true)", [tenant.organizationId]);
      const schema = postgresIdentifier(this.schema);
      const result = await client.query<{ consumers: number; unversioned: number; position_gap: string; oldest_age_ms: number | null }>(`WITH head AS (
        SELECT COALESCE(max(sequence),0) AS sequence FROM ${schema}.fold_events WHERE organization_id=$1 AND workspace_id=$2
      ) SELECT count(*)::int AS consumers, count(*) FILTER (WHERE cursor_sequence IS NULL)::int AS unversioned,
        COALESCE(max(GREATEST(head.sequence - cursor_sequence, 0)),0)::text AS position_gap,
        max(EXTRACT(EPOCH FROM (clock_timestamp()-updated_at))*1000)::float8 AS oldest_age_ms
        FROM ${schema}.fold_consumer_offsets CROSS JOIN head WHERE organization_id=$1 AND workspace_id=$2`, [tenant.organizationId, tenant.workspaceId]);
      await client.query("COMMIT");
      const row = result.rows[0]!;
      return { status: row.consumers === 0 ? "unknown" : "observed", registeredConsumers: row.consumers,
        unversionedConsumers: row.unversioned, largestCursorPositionGap: row.position_gap,
        oldestCheckpointAgeMs: row.oldest_age_ms, observedAt: new Date().toISOString() };
    } finally { client?.release(true); this.readingLag = false; }
  }
}

export interface PostgresRuntimeGrantOptions {
  readonly connectionString: string;
  readonly schema: string;
  readonly runtimeRole: string;
  readonly recoveryRole?: string;
  readonly embeddings?: boolean;
}

/** Explicit migration-owner operation; never invoked by runtime verification. */
export async function grantPostgresRuntimePrivileges(options: PostgresRuntimeGrantOptions): Promise<void> {
  const schema = postgresIdentifier(options.schema);
  const runtime = postgresIdentifier(options.runtimeRole);
  const recovery = options.recoveryRole === undefined ? undefined : postgresIdentifier(options.recoveryRole);
  const pool = new Pool({ connectionString: options.connectionString, max: 1, connectionTimeoutMillis: 5_000, statement_timeout: 10_000 });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('fold-schema-v1'))");
    await client.query(`REVOKE ALL ON SCHEMA ${schema} FROM PUBLIC`);
    await client.query(`REVOKE ALL ON SCHEMA ${schema} FROM ${runtime}`);
    await client.query(`GRANT USAGE ON SCHEMA ${schema} TO ${runtime}`);
    await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${schema} FROM ${runtime}`);
    const tables = [...STORE_SCHEMA.tables, ...TENANCY_SCHEMA.tables, ...(options.embeddings === true ? EMBEDDING_SCHEMA.tables : [])];
    for (const table of tables) {
      const privileges = "privileges" in table ? table.privileges : ["SELECT", "INSERT", "UPDATE", "DELETE"];
      await client.query(`GRANT ${privileges.join(", ")} ON TABLE ${schema}.${postgresIdentifier(table.name)} TO ${runtime}`);
    }
    await client.query(`GRANT SELECT ON TABLE ${schema}.fold_schema_versions TO ${runtime}`);
    await client.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${schema} FROM ${runtime}`);
    await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${runtime}`);
    if (recovery !== undefined) {
      await client.query(`REVOKE ALL ON SCHEMA ${schema} FROM ${recovery}`);
      await client.query(`GRANT USAGE ON SCHEMA ${schema} TO ${recovery}`);
      await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${schema} FROM ${recovery}`);
      await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ${recovery}`);
      await client.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${schema} FROM ${recovery}`);
      await client.query(`GRANT SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${recovery}`);
    }
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
  finally { client.release(); await pool.end(); }
}
