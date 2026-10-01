import type { PoolClient } from "pg";

export type PostgresSchemaMode = "migrate" | "verify";

export class PostgresSchemaError extends Error {
  override readonly name = "PostgresSchemaError";
  readonly code = "postgres_schema_unavailable";
}

export function checkedSchemaMode(value: PostgresSchemaMode | undefined): PostgresSchemaMode {
  if (value !== undefined && value !== "migrate" && value !== "verify") throw new TypeError("schemaMode must be migrate or verify");
  return value ?? "migrate";
}

export function postgresIdentifier(value: string): string {
  if (value.length > 63 || !/^[a-z_][a-z0-9_]*$/i.test(value)) throw new TypeError("Invalid PostgreSQL identifier");
  return `"${value}"`;
}

interface SchemaTable {
  readonly name: string;
  readonly tenant?: boolean;
  readonly columns?: readonly string[];
  readonly privileges?: readonly string[];
  readonly immutable?: boolean;
}

export const STORE_SCHEMA = {
  component: "store", version: 2,
  tables: [
    { name: "fold_events", tenant: true, privileges: ["SELECT", "INSERT"], columns: ["sequence", "organization_id", "workspace_id", "t", "event_id", "kind", "status", "event"] },
    { name: "fold_consumer_offsets", tenant: true, columns: ["cursor_sequence"] },
    { name: "fold_command_receipts", tenant: true, privileges: ["SELECT", "INSERT"] },
    { name: "fold_projection_checkpoints", tenant: true, columns: ["format_version", "state_version", "source_revision", "ingestion_sequence", "access_digest", "configuration_digest"] },
  ],
} as const;

export const TENANCY_SCHEMA = {
  component: "tenancy", version: 1,
  tables: [
    { name: "fold_organizations" },
    { name: "fold_workspaces", tenant: true },
    { name: "fold_organization_memberships", tenant: true, columns: ["source"] },
    { name: "fold_workspace_memberships", tenant: true, columns: ["source", "space_roles"] },
    { name: "fold_repository_enrollments", tenant: true },
    { name: "fold_platform_access_audit", tenant: true, privileges: ["SELECT", "INSERT"] },
    { name: "fold_external_organization_bindings" },
    { name: "fold_external_principal_bindings" },
    { name: "fold_identity_provisioning_audit", tenant: true, privileges: ["SELECT", "INSERT"] },
    { name: "fold_identity_versions", tenant: true },
  ],
} as const;

export const EMBEDDING_SCHEMA = {
  component: "embeddings", version: 1,
  tables: [
    { name: "fold_memory_embedding_config", privileges: ["SELECT"], immutable: true },
    { name: "fold_memory_embeddings", tenant: true, columns: ["organization_id", "workspace_id", "memory_id", "revision", "model_id", "content_digest", "embedding"] },
  ],
} as const;

export interface PostgresSchemaContract {
  readonly component: string;
  readonly version: number;
  readonly tables: readonly SchemaTable[];
}

/** Called in the same exclusive schema transaction as the component's DDL. */
export async function recordSchemaVersion(client: PoolClient, schema: string, contract: PostgresSchemaContract): Promise<void> {
  const table = `${postgresIdentifier(schema)}.fold_schema_versions`;
  await client.query(`CREATE TABLE IF NOT EXISTS ${table} (
    component text PRIMARY KEY, version integer NOT NULL CHECK (version > 0),
    migrated_at timestamptz NOT NULL DEFAULT clock_timestamp()
  )`);
  const current = await client.query<{ version: number }>(`SELECT version FROM ${table} WHERE component = $1`, [contract.component]);
  if ((current.rows[0]?.version ?? 0) > contract.version) throw new PostgresSchemaError("A newer schema requires a matching application version");
  await client.query(`INSERT INTO ${table} (component, version) VALUES ($1, $2)
    ON CONFLICT (component) DO UPDATE SET version = EXCLUDED.version, migrated_at = clock_timestamp()`, [contract.component, contract.version]);
}

/** Runtime verification performs no DDL and rejects credentials capable of bypassing the boundary. */
export async function verifyPostgresSchema(client: PoolClient, schema: string, contract: PostgresSchemaContract): Promise<void> {
  const role = await client.query<{ unsafe: boolean }>(`SELECT
    rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb
    OR EXISTS (SELECT 1 FROM pg_roles elevated WHERE (elevated.rolsuper OR elevated.rolbypassrls OR elevated.rolcreaterole OR elevated.rolcreatedb) AND pg_has_role(current_user, elevated.oid, 'MEMBER'))
    OR pg_has_role(current_user, (SELECT datdba FROM pg_database WHERE datname = current_database()), 'MEMBER')
    OR has_database_privilege(current_user, current_database(), 'CREATE') AS unsafe
    FROM pg_roles WHERE rolname = current_user`);
  if (role.rows[0]?.unsafe !== false) throw new PostgresSchemaError("Runtime requires a nonowner role without administrative or RLS-bypass privileges");
  const namespace = await client.query<{ oid: string; unsafe: boolean }>(`SELECT oid::text,
    pg_has_role(current_user, nspowner, 'MEMBER') OR has_schema_privilege(current_user, oid, 'CREATE') AS unsafe
    FROM pg_namespace WHERE nspname = $1`, [schema]);
  if (namespace.rows.length !== 1 || namespace.rows[0]?.unsafe !== false) throw new PostgresSchemaError("Runtime schema is missing or permits ownership/creation");
  const rowSecurity = await client.query<{ row_security: string }>("SHOW row_security");
  if (rowSecurity.rows[0]?.row_security !== "on") throw new PostgresSchemaError("Runtime requires row_security=on");
  const versionsTable = `${postgresIdentifier(schema)}.fold_schema_versions`;
  const exists = await client.query<{ table_name: string | null }>("SELECT to_regclass($1)::text AS table_name", [versionsTable]);
  if (exists.rows[0]?.table_name == null) throw new PostgresSchemaError("Schema migration must complete before runtime starts");
  const version = await client.query<{ version: number }>(`SELECT version FROM ${versionsTable} WHERE component = $1`, [contract.component]);
  if (version.rows[0]?.version !== contract.version) throw new PostgresSchemaError(`Schema component ${contract.component} requires migration to version ${contract.version}`);

  const tables: readonly SchemaTable[] = [{ name: "fold_schema_versions", privileges: ["SELECT"], immutable: true }, ...contract.tables];
  for (const table of tables) {
    const qualified = `${postgresIdentifier(schema)}.${postgresIdentifier(table.name)}`;
    const relation = await client.query<{ oid: string; unsafe: boolean; relrowsecurity: boolean; relforcerowsecurity: boolean }>(`SELECT oid::text,
      pg_has_role(current_user, relowner, 'MEMBER') OR has_table_privilege(current_user, oid, 'TRUNCATE') OR has_table_privilege(current_user, oid, 'TRIGGER') AS unsafe,
      relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = to_regclass($1) AND relkind = 'r'`, [qualified]);
    const row = relation.rows[0];
    if (row === undefined || row.unsafe || (table.tenant === true && (!row.relrowsecurity || !row.relforcerowsecurity))) throw new PostgresSchemaError(`Runtime table ${table.name} is unavailable or lacks its required isolation`);
    const privileges = table.privileges ?? ["SELECT", "INSERT", "UPDATE", "DELETE"];
    const access = await client.query<{ allowed: boolean }>(`SELECT bool_and(has_table_privilege(current_user, $1::oid, privilege)) AS allowed FROM unnest($2::text[]) privilege`, [row.oid, privileges]);
    if (access.rows[0]?.allowed !== true) throw new PostgresSchemaError(`Runtime table ${table.name} lacks required data privileges`);
    const forbidden = ["INSERT", "UPDATE", "DELETE"].filter((privilege) => !privileges.includes(privilege));
    if (forbidden.length > 0) {
      const mutation = await client.query<{ unsafe: boolean }>("SELECT has_table_privilege(current_user, $1::oid, $2) AS unsafe", [row.oid, forbidden.join(", ")]);
      if (mutation.rows[0]?.unsafe !== false) throw new PostgresSchemaError(`Runtime table ${table.name} permits mutation outside its contract`);
    }
    const elevated = await client.query<{ unsafe: boolean }>(`SELECT
      has_table_privilege(current_user, $1::oid, 'SELECT WITH GRANT OPTION, INSERT WITH GRANT OPTION, UPDATE WITH GRANT OPTION, DELETE WITH GRANT OPTION, REFERENCES, TRUNCATE, TRIGGER')
      OR ($2::boolean AND has_table_privilege(current_user, $1::oid, 'INSERT, UPDATE, DELETE')) AS unsafe`, [row.oid, table.immutable === true]);
    if (elevated.rows[0]?.unsafe !== false) throw new PostgresSchemaError(`Runtime table ${table.name} permits mutation or privilege delegation outside its contract`);
    if (table.tenant === true) {
      const policies = await client.query<{ polname: string; polcmd: string; public_permissive: boolean; qual: string; check_expression: string }>(`SELECT polname, polcmd, polpermissive AND polroles = ARRAY[0::oid] AS public_permissive, pg_get_expr(polqual, polrelid) AS qual, pg_get_expr(polwithcheck, polrelid) AS check_expression FROM pg_policy WHERE polrelid = $1::oid`, [row.oid]);
      const policy = policies.rows[0];
      const expected = "(organization_id = current_setting('app.organization_id'::text, true))";
      if (policies.rows.length !== 1 || policy?.polname !== "fold_organization_isolation" || policy.polcmd !== "*" || !policy.public_permissive || policy.qual !== expected || policy.check_expression !== expected) throw new PostgresSchemaError(`Runtime table ${table.name} has an unexpected tenant policy`);
    }
    if (table.columns !== undefined) {
      const columns = await client.query<{ attname: string }>("SELECT attname FROM pg_attribute WHERE attrelid = $1::oid AND attnum > 0 AND NOT attisdropped", [row.oid]);
      const names = new Set(columns.rows.map(({ attname }) => attname));
      if (table.columns.some((column) => !names.has(column))) throw new PostgresSchemaError(`Runtime table ${table.name} requires migration`);
    }
  }
}
