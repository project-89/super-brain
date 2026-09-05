import { isDeepStrictEqual } from "node:util";

import { Pool, type PoolClient, type PoolConfig, type QueryResult, type QueryResultRow } from "pg";

import type { FoldLogEntry } from "@_89/fold";
import type { FoldSdkCursor, FoldSdkStore, FoldDeliveryCursor, FoldConsumerCursor, FoldCommandReceipt, FoldCommitOptions } from "@_89/fold-sdk";

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/i;

interface EventRow extends QueryResultRow {
  readonly event: unknown;
  readonly status: "canon" | "draft";
}

interface SequencedEventRow extends EventRow {
  readonly sequence: number | string;
}

interface WorkspaceEventCache {
  sequence: bigint;
  readonly entries: FoldLogEntry[];
  readonly eventIds: Set<string>;
}

interface EventPageRow extends EventRow {
  readonly t: number | string;
  readonly event_id: string;
  readonly sequence: string;
}

interface CursorRow extends QueryResultRow {
  readonly cursor_t: number | string;
  readonly cursor_event_id: string;
}

export interface PostgresFoldDatabaseOptions {
  readonly connectionString: string;
  readonly schema?: string;
  readonly pool?: Omit<PoolConfig, "connectionString">;
  readonly requireRlsEnforcement?: boolean;
}

export interface PostgresTenantScope {
  readonly organizationId: string;
  readonly workspaceId: string;
}

export type PostgresTenantInput = PostgresTenantScope | string;

export const POSTGRES_DEFAULT_ORGANIZATION_ID = "local";

export interface FoldProjectionCheckpoint {
  readonly projection: string;
  readonly through: FoldSdkCursor;
  readonly state: unknown;
  readonly configurationDigest: string;
  readonly updatedAt: string;
}

export interface PostgresEventPageOptions {
  readonly after?: FoldConsumerCursor;
  readonly includeDrafts?: boolean;
  readonly kinds?: readonly string[];
  readonly limit?: number;
}

export interface PostgresEventPage {
  readonly entries: readonly FoldLogEntry[];
  readonly scannedThrough?: FoldDeliveryCursor;
  readonly cursors: readonly FoldDeliveryCursor[];
}

export class PostgresFoldConflictError extends Error {
  override readonly name = "PostgresFoldConflictError";
}

export class PostgresFoldRevisionConflictError extends Error {
  override readonly name = "PostgresFoldRevisionConflictError";
  readonly code = "revision_conflict";
}

function checkedIdentifier(value: string): string {
  if (!IDENTIFIER.test(value)) throw new TypeError(`invalid PostgreSQL identifier: ${value}`);
  return `"${value}"`;
}

function databaseErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;
}

function tenantScope(input: PostgresTenantInput): PostgresTenantScope {
  const tenant = typeof input === "string"
    ? { organizationId: POSTGRES_DEFAULT_ORGANIZATION_ID, workspaceId: input }
    : input;
  if (tenant.organizationId.trim().length === 0) throw new TypeError("organizationId must not be empty");
  if (tenant.workspaceId.trim().length === 0) throw new TypeError("workspaceId must not be empty");
  return tenant;
}

function tenantCacheKey(tenant: PostgresTenantScope): string {
  return JSON.stringify([tenant.organizationId, tenant.workspaceId]);
}

export class PostgresFoldDatabase {
  private readonly pool: Pool;
  private readonly schema: string;
  private readonly ready: Promise<void>;
  private readonly requireRlsEnforcement: boolean;
  private closed = false;
  private readonly eventCaches = new Map<string, WorkspaceEventCache>();

  constructor(options: PostgresFoldDatabaseOptions) {
    if (options.connectionString.trim().length === 0) {
      throw new TypeError("connectionString must not be empty");
    }
    this.schema = checkedIdentifier(options.schema ?? "public");
    this.pool = new Pool({ connectionString: options.connectionString, ...options.pool });
    this.requireRlsEnforcement = options.requireRlsEnforcement === true;
    this.ready = this.initialize();
  }

  private table(name: string): string {
    return `${this.schema}.${checkedIdentifier(name)}`;
  }

  private async initialize(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('fold-schema-v1'))");
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${this.schema}`);
      if (this.requireRlsEnforcement) {
        const role = await client.query<{ readonly rolsuper: boolean; readonly rolbypassrls: boolean }>(`
          SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user
        `);
        if (role.rows[0]?.rolsuper === true || role.rows[0]?.rolbypassrls === true) {
          throw new Error("FOLD_REQUIRE_TENANT_RLS rejects PostgreSQL roles with superuser or BYPASSRLS");
        }
        const rowSecurity = await client.query<{ readonly row_security: string }>("SHOW row_security");
        if (rowSecurity.rows[0]?.row_security !== "on") {
          throw new Error("FOLD_REQUIRE_TENANT_RLS requires PostgreSQL row_security=on");
        }
      }
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.table("fold_events")} (
          sequence bigint GENERATED ALWAYS AS IDENTITY,
          organization_id text NOT NULL DEFAULT '${POSTGRES_DEFAULT_ORGANIZATION_ID}',
          workspace_id text NOT NULL,
          t double precision NOT NULL,
          event_id text NOT NULL,
          kind text NOT NULL,
          status text NOT NULL CHECK (status IN ('canon', 'draft')),
          event jsonb NOT NULL,
          inserted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
          PRIMARY KEY (organization_id, workspace_id, event_id),
          UNIQUE (organization_id, workspace_id, sequence)
        )
      `);
      await client.query(`
        ALTER TABLE ${this.table("fold_events")}
        ADD COLUMN IF NOT EXISTS organization_id text NOT NULL DEFAULT '${POSTGRES_DEFAULT_ORGANIZATION_ID}'
      `);
      await client.query(`
        DO $migration$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conrelid = '${this.table("fold_events")}'::regclass
              AND contype = 'p'
              AND pg_get_constraintdef(oid) LIKE 'PRIMARY KEY (organization_id,%'
          ) THEN
            ALTER TABLE ${this.table("fold_events")} DROP CONSTRAINT IF EXISTS fold_events_pkey;
            ALTER TABLE ${this.table("fold_events")}
              ADD CONSTRAINT fold_events_pkey PRIMARY KEY (organization_id, workspace_id, event_id);
          END IF;
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conrelid = '${this.table("fold_events")}'::regclass
              AND contype = 'u'
              AND pg_get_constraintdef(oid) LIKE 'UNIQUE (organization_id,%sequence%'
          ) THEN
            ALTER TABLE ${this.table("fold_events")}
              DROP CONSTRAINT IF EXISTS fold_events_workspace_id_sequence_key;
            ALTER TABLE ${this.table("fold_events")}
              ADD CONSTRAINT fold_events_tenant_sequence_key UNIQUE (organization_id, workspace_id, sequence);
          END IF;
        END
        $migration$
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS fold_events_tenant_canonical_order
        ON ${this.table("fold_events")} (organization_id, workspace_id, t, event_id)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS fold_events_tenant_kind_order
        ON ${this.table("fold_events")} (organization_id, workspace_id, kind, t, event_id)
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.table("fold_consumer_offsets")} (
          organization_id text NOT NULL DEFAULT '${POSTGRES_DEFAULT_ORGANIZATION_ID}',
          workspace_id text NOT NULL,
          consumer_id text NOT NULL,
          cursor_t double precision NOT NULL,
          cursor_event_id text NOT NULL,
          updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
          PRIMARY KEY (organization_id, workspace_id, consumer_id)
        )
      `);
      await client.query(`ALTER TABLE ${this.table("fold_consumer_offsets")}
        ADD COLUMN IF NOT EXISTS organization_id text NOT NULL DEFAULT '${POSTGRES_DEFAULT_ORGANIZATION_ID}'`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.table("fold_projection_checkpoints")} (
          organization_id text NOT NULL DEFAULT '${POSTGRES_DEFAULT_ORGANIZATION_ID}',
          workspace_id text NOT NULL,
          projection text NOT NULL,
          cursor_t double precision NOT NULL,
          cursor_event_id text NOT NULL,
          state jsonb NOT NULL,
          configuration_digest text NOT NULL,
          updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
          PRIMARY KEY (organization_id, workspace_id, projection)
        )
      `);
      await client.query(`ALTER TABLE ${this.table("fold_projection_checkpoints")}
        ADD COLUMN IF NOT EXISTS organization_id text NOT NULL DEFAULT '${POSTGRES_DEFAULT_ORGANIZATION_ID}'`);
      for (const [tableName, oldConstraint, columns] of [
        ["fold_consumer_offsets", "fold_consumer_offsets_pkey", "organization_id, workspace_id, consumer_id"],
        ["fold_projection_checkpoints", "fold_projection_checkpoints_pkey", "organization_id, workspace_id, projection"],
      ] as const) {
        await client.query(`
          DO $migration$
          BEGIN
            IF NOT EXISTS (
              SELECT 1 FROM pg_constraint
              WHERE conrelid = '${this.table(tableName)}'::regclass
                AND contype = 'p'
                AND pg_get_constraintdef(oid) LIKE 'PRIMARY KEY (organization_id,%'
            ) THEN
              ALTER TABLE ${this.table(tableName)} DROP CONSTRAINT IF EXISTS ${oldConstraint};
              ALTER TABLE ${this.table(tableName)} ADD CONSTRAINT ${oldConstraint} PRIMARY KEY (${columns});
            END IF;
          END
          $migration$
        `);
      }
      await client.query(`ALTER TABLE ${this.table("fold_consumer_offsets")}
        ADD COLUMN IF NOT EXISTS cursor_sequence bigint`);
      await client.query(`CREATE TABLE IF NOT EXISTS ${this.table("fold_command_receipts")} (
        organization_id text NOT NULL, workspace_id text NOT NULL, command_id text NOT NULL,
        request jsonb NOT NULL, result jsonb NOT NULL, entries jsonb NOT NULL, revision bigint NOT NULL,
        PRIMARY KEY (organization_id, workspace_id, command_id)
      )`);
      for (const tableName of ["fold_events", "fold_consumer_offsets", "fold_projection_checkpoints", "fold_command_receipts"] as const) {
        await client.query(`ALTER TABLE ${this.table(tableName)} ENABLE ROW LEVEL SECURITY`);
        await client.query(`ALTER TABLE ${this.table(tableName)} FORCE ROW LEVEL SECURITY`);
        await client.query(`DROP POLICY IF EXISTS fold_organization_isolation ON ${this.table(tableName)}`);
        await client.query(`CREATE POLICY fold_organization_isolation ON ${this.table(tableName)}
          USING (organization_id = current_setting('app.organization_id', true))
          WITH CHECK (organization_id = current_setting('app.organization_id', true))`);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async open(): Promise<void> {
    if (this.closed) throw new Error("PostgreSQL Fold database is closed");
    await this.ready;
  }

  private async setTenant(client: PoolClient, tenant: PostgresTenantScope): Promise<void> {
    await client.query("SELECT set_config('app.organization_id', $1, true)", [tenant.organizationId]);
  }

  private async tenantQuery<R extends QueryResultRow>(
    tenant: PostgresTenantScope,
    text: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<R>> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.setTenant(client, tenant);
      const result = await client.query<R>(text, [...values]);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  store(input: PostgresTenantInput): PostgresFoldStore {
    return new PostgresFoldStore(this, tenantScope(input));
  }

  async readSnapshot(input: PostgresTenantInput): Promise<{ readonly entries: readonly FoldLogEntry[]; readonly revision: string }> {
    await this.open();
    const tenant = tenantScope(input);
    const key = tenantCacheKey(tenant);
    let cache = this.eventCaches.get(key);
    if (cache === undefined) {
      cache = { sequence: 0n, entries: [], eventIds: new Set() };
      this.eventCaches.set(key, cache);
    }
    const result = await this.tenantQuery<SequencedEventRow>(tenant, `
      SELECT sequence, event, status
      FROM ${this.table("fold_events")}
      WHERE organization_id = $1 AND workspace_id = $2 AND sequence > $3
      ORDER BY sequence
    `, [tenant.organizationId, tenant.workspaceId, cache.sequence.toString()]);
    for (const row of result.rows) {
      cache.sequence = BigInt(row.sequence) > cache.sequence ? BigInt(row.sequence) : cache.sequence;
      const event = row.event as FoldLogEntry["event"];
      if (cache.eventIds.has(event.id)) continue;
      cache.eventIds.add(event.id);
      cache.entries.push({ event, status: row.status });
    }
    cache.entries.sort((left, right) =>
      left.event.at.t - right.event.at.t || (left.event.id < right.event.id ? -1 : left.event.id > right.event.id ? 1 : 0));
    return { entries: [...cache.entries], revision: cache.sequence.toString() };
  }

  async readEntries(input: PostgresTenantInput): Promise<readonly FoldLogEntry[]> {
    return (await this.readSnapshot(input)).entries;
  }

  async workspaceRevision(input: PostgresTenantInput): Promise<string> {
    await this.open();
    const tenant = tenantScope(input);
    const result = await this.tenantQuery<{ readonly sequence: number | string }>(tenant, `
      SELECT COALESCE(MAX(sequence), 0) AS sequence
      FROM ${this.table("fold_events")}
      WHERE organization_id = $1 AND workspace_id = $2
    `, [tenant.organizationId, tenant.workspaceId]);
    return String(result.rows[0]?.sequence ?? "0");
  }

  async readEventPage(
    input: PostgresTenantInput,
    options: PostgresEventPageOptions = {},
  ): Promise<PostgresEventPage> {
    await this.open();
    const tenant = tenantScope(input);
    const limit = options.limit ?? 500;
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
      throw new TypeError("event page limit must be an integer within [1, 10000]");
    }
    const parameters: unknown[] = [tenant.organizationId, tenant.workspaceId];
    const conditions = ["organization_id = $1", "workspace_id = $2"];
    if (options.after !== undefined && "version" in options.after) {
      if (options.after.version !== 2 || (!/^(0|[1-9][0-9]*)$/.test(options.after.sequence) || BigInt(options.after.sequence) > 9223372036854775807n)) throw new TypeError("invalid delivery cursor");
      parameters.push(options.after.sequence);
      conditions.push(`sequence > $${parameters.length}::bigint`);
    }
    // A legacy event-time cursor replays from origin: converting its event ID would lose late arrivals.
    if (!options.includeDrafts) conditions.push("status = 'canon'");
    if (options.kinds !== undefined && options.kinds.length > 0) {
      parameters.push([...options.kinds]);
      conditions.push(`kind = ANY($${parameters.length}::text[])`);
    }
    parameters.push(limit);
    const result = await this.tenantQuery<EventPageRow>(tenant, `
      SELECT event, status, t, event_id, sequence
      FROM ${this.table("fold_events")}
      WHERE ${conditions.join(" AND ")}
      ORDER BY sequence
      LIMIT $${parameters.length}
    `, parameters);
    const last = result.rows.at(-1);
    return {
      entries: result.rows.map(({ event, status }) => ({
        event: event as FoldLogEntry["event"],
        status,
      })),
      cursors: result.rows.map((row) => ({ version: 2 as const, sequence: String(row.sequence) })),
      ...(last === undefined ? {} : {
        scannedThrough: { version: 2 as const, sequence: String(last.sequence) },
      }),
    };
  }

  async latestDeliveryCursor(input: PostgresTenantInput): Promise<FoldDeliveryCursor> {
    return { version: 2, sequence: await this.workspaceRevision(input) };
  }

  async latestEventCursor(input: PostgresTenantInput): Promise<FoldSdkCursor | undefined> {
    await this.open();
    const tenant = tenantScope(input);
    const result = await this.tenantQuery<{ t: number; event_id: string }>(tenant, `
      SELECT t, event_id FROM ${this.table("fold_events")}
      WHERE organization_id = $1 AND workspace_id = $2 ORDER BY t DESC, event_id DESC LIMIT 1
    `, [tenant.organizationId, tenant.workspaceId]);
    const row = result.rows[0];
    return row === undefined ? undefined : { t: Number(row.t), eventId: row.event_id };
  }

  async commandReceipt(input: PostgresTenantInput, commandId: string): Promise<FoldCommandReceipt | undefined> {
    await this.open();
    const tenant = tenantScope(input);
    const result = await this.tenantQuery<{ request: unknown; result: unknown; entries: FoldLogEntry[]; revision: string }>(tenant, `
      SELECT request, result, entries, revision FROM ${this.table("fold_command_receipts")}
      WHERE organization_id = $1 AND workspace_id = $2 AND command_id = $3
    `, [tenant.organizationId, tenant.workspaceId, commandId]);
    const row = result.rows[0];
    return row === undefined ? undefined : { commandId, ...row, revision: String(row.revision) };
  }

  async commitEntries(input: PostgresTenantInput, entries: readonly FoldLogEntry[], options: FoldCommitOptions): Promise<FoldCommandReceipt> {
    await this.open();
    const tenant = tenantScope(input);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.setTenant(client, tenant);
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`fold:${tenantCacheKey(tenant)}`]);
      const prior = await client.query<{ request: unknown; result: unknown; entries: FoldLogEntry[]; revision: string }>(`
        SELECT request, result, entries, revision FROM ${this.table("fold_command_receipts")}
        WHERE organization_id = $1 AND workspace_id = $2 AND command_id = $3
      `, [tenant.organizationId, tenant.workspaceId, options.command.commandId]);
      const existing = prior.rows[0];
      if (existing !== undefined) {
        if (!isDeepStrictEqual(existing.request, JSON.parse(JSON.stringify(options.command.request)))) {
          throw new PostgresFoldConflictError("command identity is already used with a different request");
        }
        await client.query("COMMIT");
        return { commandId: options.command.commandId, ...existing, revision: String(existing.revision) };
      }
      const revisionQuery = `SELECT COALESCE(MAX(sequence), 0) AS revision FROM ${this.table("fold_events")}
        WHERE organization_id = $1 AND workspace_id = $2`;
      const current = await client.query<{ revision: string }>(revisionQuery, [tenant.organizationId, tenant.workspaceId]);
      if (String(current.rows[0]!.revision) !== options.expectedRevision) {
        throw new PostgresFoldRevisionConflictError("workspace changed during command validation; retry with a fresh snapshot");
      }
      for (const entry of entries) await this.insertEntry(client, tenant, entry);
      const committed = await client.query<{ revision: string }>(revisionQuery, [tenant.organizationId, tenant.workspaceId]);
      const revision = String(committed.rows[0]!.revision);
      await client.query(`INSERT INTO ${this.table("fold_command_receipts")}
        (organization_id, workspace_id, command_id, request, result, entries, revision)
        VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::bigint)`, [
        tenant.organizationId, tenant.workspaceId, options.command.commandId,
        JSON.stringify(options.command.request), JSON.stringify(options.command.result), JSON.stringify(entries), revision,
      ]);
      await client.query("COMMIT");
      return { ...options.command, entries, revision };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  private async insertEntry(client: PoolClient, tenant: PostgresTenantScope, entry: FoldLogEntry): Promise<void> {
    const previous = await client.query<{ readonly event_id: string }>(`
      SELECT event_id
      FROM ${this.table("fold_events")}
      WHERE organization_id = $1 AND workspace_id = $2 AND t = $3
      ORDER BY sequence DESC
      LIMIT 1
    `, [tenant.organizationId, tenant.workspaceId, entry.event.at.t]);
    const previousId = previous.rows[0]?.event_id;
    if (previousId !== undefined && previousId >= entry.event.id) {
      throw new PostgresFoldConflictError(
        `event id ${entry.event.id} is not monotonic after ${previousId} at t=${entry.event.at.t}`,
      );
    }
    try {
      await client.query(`
        INSERT INTO ${this.table("fold_events")}
          (organization_id, workspace_id, t, event_id, kind, status, event)
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
      `, [
        tenant.organizationId,
        tenant.workspaceId,
        entry.event.at.t,
        entry.event.id,
        entry.event.kind,
        entry.status,
        JSON.stringify(entry.event),
      ]);
    } catch (error) {
      if (databaseErrorCode(error) === "23505") {
        throw new PostgresFoldConflictError(`event already exists: ${entry.event.id}`);
      }
      throw error;
    }
  }

  async appendEntries(input: PostgresTenantInput, entries: readonly FoldLogEntry[]): Promise<void> {
    if (entries.length === 0) return;
    await this.open();
    const tenant = tenantScope(input);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.setTenant(client, tenant);
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`fold:${tenantCacheKey(tenant)}`]);
      for (const entry of entries) await this.insertEntry(client, tenant, entry);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async importEntries(input: PostgresTenantInput, entries: readonly FoldLogEntry[]): Promise<number> {
    if (entries.length === 0) return 0;
    await this.open();
    const tenant = tenantScope(input);
    const client = await this.pool.connect();
    let imported = 0;
    try {
      await client.query("BEGIN");
      await this.setTenant(client, tenant);
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`fold:${tenantCacheKey(tenant)}`]);
      for (const entry of entries) {
        const existing = await client.query<EventRow>(`
          SELECT event, status
          FROM ${this.table("fold_events")}
          WHERE organization_id = $1 AND workspace_id = $2 AND event_id = $3
        `, [tenant.organizationId, tenant.workspaceId, entry.event.id]);
        const current = existing.rows[0];
        if (current !== undefined) {
          if (current.status !== entry.status || !isDeepStrictEqual(current.event, entry.event)) {
            throw new PostgresFoldConflictError(`imported event changed: ${entry.event.id}`);
          }
          continue;
        }
        await this.insertEntry(client, tenant, entry);
        imported += 1;
      }
      await client.query("COMMIT");
      return imported;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async consumerCursor(input: PostgresTenantInput, consumerId: string): Promise<FoldDeliveryCursor | undefined> {
    await this.open();
    const tenant = tenantScope(input);
    const result = await this.tenantQuery<{ cursor_sequence: string | null }>(tenant, `
      SELECT cursor_sequence FROM ${this.table("fold_consumer_offsets")}
      WHERE organization_id = $1 AND workspace_id = $2 AND consumer_id = $3
    `, [tenant.organizationId, tenant.workspaceId, consumerId]);
    const row = result.rows[0];
    return row === undefined ? undefined : { version: 2, sequence: String(row.cursor_sequence ?? "0") };
  }

  async commitConsumerCursor(input: PostgresTenantInput, consumerId: string, cursor: FoldConsumerCursor): Promise<void> {
    if (consumerId.trim().length === 0) throw new TypeError("consumerId must not be empty");
    if (!("version" in cursor)) throw new TypeError("legacy consumer commits are unsupported; replay using delivery cursor v2");
    if (cursor.version !== 2 || (!/^(0|[1-9][0-9]*)$/.test(cursor.sequence) || BigInt(cursor.sequence) > 9223372036854775807n)) throw new TypeError("invalid delivery cursor");
    await this.open();
    const tenant = tenantScope(input);
    const result = await this.tenantQuery(tenant, `
      INSERT INTO ${this.table("fold_consumer_offsets")}
        (organization_id, workspace_id, consumer_id, cursor_t, cursor_event_id, cursor_sequence)
      SELECT $1, $2, $3, 0, '', $4::bigint
      WHERE $4::bigint <= (SELECT COALESCE(MAX(sequence), 0) FROM ${this.table("fold_events")}
        WHERE organization_id = $1 AND workspace_id = $2)
      ON CONFLICT (organization_id, workspace_id, consumer_id) DO UPDATE SET
        cursor_sequence = EXCLUDED.cursor_sequence, updated_at = clock_timestamp()
      WHERE COALESCE(${this.table("fold_consumer_offsets")}.cursor_sequence, 0) <= EXCLUDED.cursor_sequence
      RETURNING cursor_sequence
    `, [tenant.organizationId, tenant.workspaceId, consumerId, cursor.sequence]);
    if (result.rowCount === 0) throw new PostgresFoldConflictError(`consumer cursor cannot move backward or beyond delivery head: ${consumerId}`);
  }

  async projectionCheckpoint(
    input: PostgresTenantInput,
    projection: string,
  ): Promise<FoldProjectionCheckpoint | undefined> {
    await this.open();
    const tenant = tenantScope(input);
    const result = await this.tenantQuery<CursorRow & QueryResultRow & {
      readonly state: unknown;
      readonly configuration_digest: string;
      readonly updated_at: Date | string;
    }>(tenant, `
      SELECT cursor_t, cursor_event_id, state, configuration_digest, updated_at
      FROM ${this.table("fold_projection_checkpoints")}
      WHERE organization_id = $1 AND workspace_id = $2 AND projection = $3
    `, [tenant.organizationId, tenant.workspaceId, projection]);
    const row = result.rows[0];
    return row === undefined ? undefined : {
      projection,
      through: { t: Number(row.cursor_t), eventId: row.cursor_event_id },
      state: row.state,
      configurationDigest: row.configuration_digest,
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }

  async saveProjectionCheckpoint(
    input: PostgresTenantInput,
    checkpoint: Omit<FoldProjectionCheckpoint, "updatedAt">,
  ): Promise<void> {
    await this.open();
    const tenant = tenantScope(input);
    const result = await this.tenantQuery(tenant, `
      INSERT INTO ${this.table("fold_projection_checkpoints")}
        (organization_id, workspace_id, projection, cursor_t, cursor_event_id, state, configuration_digest)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
      ON CONFLICT (organization_id, workspace_id, projection) DO UPDATE SET
        cursor_t = EXCLUDED.cursor_t,
        cursor_event_id = EXCLUDED.cursor_event_id,
        state = EXCLUDED.state,
        configuration_digest = EXCLUDED.configuration_digest,
        updated_at = clock_timestamp()
      WHERE (${this.table("fold_projection_checkpoints")}.cursor_t, ${this.table("fold_projection_checkpoints")}.cursor_event_id)
        <= (EXCLUDED.cursor_t, EXCLUDED.cursor_event_id)
      RETURNING cursor_t
    `, [
      tenant.organizationId,
      tenant.workspaceId,
      checkpoint.projection,
      checkpoint.through.t,
      checkpoint.through.eventId,
      JSON.stringify(checkpoint.state),
      checkpoint.configurationDigest,
    ]);
    if (result.rowCount === 0) {
      throw new PostgresFoldConflictError(
        `projection checkpoint cannot move backward: ${checkpoint.projection}`,
      );
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.ready.catch(() => undefined);
    await this.pool.end();
  }
}

export class PostgresFoldStore implements FoldSdkStore {
  constructor(
    private readonly database: PostgresFoldDatabase,
    readonly tenant: PostgresTenantScope,
  ) {}

  async read(): Promise<{ readonly entries: readonly FoldLogEntry[]; readonly revision: string }> {
    return this.database.readSnapshot(this.tenant);
  }

  append(entry: FoldLogEntry): Promise<void> {
    return this.database.appendEntries(this.tenant, [entry]);
  }

  appendMany(entries: readonly FoldLogEntry[]): Promise<void> {
    return this.database.appendEntries(this.tenant, entries);
  }

  commit(entries: readonly FoldLogEntry[], options: FoldCommitOptions): Promise<FoldCommandReceipt> {
    return this.database.commitEntries(this.tenant, entries, options);
  }

  commandReceipt(commandId: string): Promise<FoldCommandReceipt | undefined> {
    return this.database.commandReceipt(this.tenant, commandId);
  }

  revision(): Promise<string> {
    return this.database.workspaceRevision(this.tenant);
  }
}
