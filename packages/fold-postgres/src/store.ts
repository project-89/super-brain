import { isDeepStrictEqual } from "node:util";

import { Pool, type PoolClient, type PoolConfig, type QueryResultRow } from "pg";

import type { FoldLogEntry } from "@_89/fold";
import type { FoldSdkCursor, FoldSdkStore } from "@_89/fold-sdk";

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/i;

interface EventRow extends QueryResultRow {
  readonly event: unknown;
  readonly status: "canon" | "draft";
}

interface SequencedEventRow extends EventRow {
  readonly sequence: number | string;
}

interface WorkspaceEventCache {
  sequence: number;
  readonly entries: FoldLogEntry[];
  readonly eventIds: Set<string>;
}

interface EventPageRow extends EventRow {
  readonly t: number | string;
  readonly event_id: string;
}

interface CursorRow extends QueryResultRow {
  readonly cursor_t: number | string;
  readonly cursor_event_id: string;
}

export interface PostgresFoldDatabaseOptions {
  readonly connectionString: string;
  readonly schema?: string;
  readonly pool?: Omit<PoolConfig, "connectionString">;
}

export interface FoldProjectionCheckpoint {
  readonly projection: string;
  readonly through: FoldSdkCursor;
  readonly state: unknown;
  readonly configurationDigest: string;
  readonly updatedAt: string;
}

export interface PostgresEventPageOptions {
  readonly after?: FoldSdkCursor;
  readonly includeDrafts?: boolean;
  readonly kinds?: readonly string[];
  readonly limit?: number;
}

export interface PostgresEventPage {
  readonly entries: readonly FoldLogEntry[];
  readonly scannedThrough?: FoldSdkCursor;
}

export class PostgresFoldConflictError extends Error {
  override readonly name = "PostgresFoldConflictError";
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

export class PostgresFoldDatabase {
  private readonly pool: Pool;
  private readonly schema: string;
  private readonly ready: Promise<void>;
  private closed = false;
  private readonly eventCaches = new Map<string, WorkspaceEventCache>();

  constructor(options: PostgresFoldDatabaseOptions) {
    if (options.connectionString.trim().length === 0) {
      throw new TypeError("connectionString must not be empty");
    }
    this.schema = checkedIdentifier(options.schema ?? "public");
    this.pool = new Pool({ connectionString: options.connectionString, ...options.pool });
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
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.table("fold_events")} (
          sequence bigint GENERATED ALWAYS AS IDENTITY,
          workspace_id text NOT NULL,
          t double precision NOT NULL,
          event_id text NOT NULL,
          kind text NOT NULL,
          status text NOT NULL CHECK (status IN ('canon', 'draft')),
          event jsonb NOT NULL,
          inserted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
          PRIMARY KEY (workspace_id, event_id),
          UNIQUE (workspace_id, sequence)
        )
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS fold_events_canonical_order
        ON ${this.table("fold_events")} (workspace_id, t, event_id)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS fold_events_kind_order
        ON ${this.table("fold_events")} (workspace_id, kind, t, event_id)
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.table("fold_consumer_offsets")} (
          workspace_id text NOT NULL,
          consumer_id text NOT NULL,
          cursor_t double precision NOT NULL,
          cursor_event_id text NOT NULL,
          updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
          PRIMARY KEY (workspace_id, consumer_id)
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.table("fold_projection_checkpoints")} (
          workspace_id text NOT NULL,
          projection text NOT NULL,
          cursor_t double precision NOT NULL,
          cursor_event_id text NOT NULL,
          state jsonb NOT NULL,
          configuration_digest text NOT NULL,
          updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
          PRIMARY KEY (workspace_id, projection)
        )
      `);
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

  store(workspaceId: string): PostgresFoldStore {
    if (workspaceId.trim().length === 0) throw new TypeError("workspaceId must not be empty");
    return new PostgresFoldStore(this, workspaceId);
  }

  async readSnapshot(workspaceId: string): Promise<{ readonly entries: readonly FoldLogEntry[]; readonly revision: string }> {
    await this.open();
    let cache = this.eventCaches.get(workspaceId);
    if (cache === undefined) {
      cache = { sequence: 0, entries: [], eventIds: new Set() };
      this.eventCaches.set(workspaceId, cache);
    }
    const result = await this.pool.query<SequencedEventRow>(`
      SELECT sequence, event, status
      FROM ${this.table("fold_events")}
      WHERE workspace_id = $1 AND sequence > $2
      ORDER BY sequence
    `, [workspaceId, cache.sequence]);
    for (const row of result.rows) {
      cache.sequence = Math.max(cache.sequence, Number(row.sequence));
      const event = row.event as FoldLogEntry["event"];
      if (cache.eventIds.has(event.id)) continue;
      cache.eventIds.add(event.id);
      cache.entries.push({ event, status: row.status });
    }
    cache.entries.sort((left, right) =>
      left.event.at.t - right.event.at.t || left.event.id.localeCompare(right.event.id));
    return { entries: [...cache.entries], revision: cache.sequence.toString() };
  }

  async readEntries(workspaceId: string): Promise<readonly FoldLogEntry[]> {
    return (await this.readSnapshot(workspaceId)).entries;
  }

  async workspaceRevision(workspaceId: string): Promise<string> {
    await this.open();
    const result = await this.pool.query<{ readonly sequence: number | string }>(`
      SELECT COALESCE(MAX(sequence), 0) AS sequence
      FROM ${this.table("fold_events")}
      WHERE workspace_id = $1
    `, [workspaceId]);
    return Number(result.rows[0]?.sequence ?? 0).toString();
  }

  async readEventPage(
    workspaceId: string,
    options: PostgresEventPageOptions = {},
  ): Promise<PostgresEventPage> {
    await this.open();
    const limit = options.limit ?? 500;
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
      throw new TypeError("event page limit must be an integer within [1, 10000]");
    }
    const parameters: unknown[] = [workspaceId];
    const conditions = ["workspace_id = $1"];
    if (options.after !== undefined) {
      parameters.push(options.after.t, options.after.eventId);
      conditions.push(`(t, event_id) > ($${parameters.length - 1}, $${parameters.length})`);
    }
    if (!options.includeDrafts) conditions.push("status = 'canon'");
    if (options.kinds !== undefined && options.kinds.length > 0) {
      parameters.push([...options.kinds]);
      conditions.push(`kind = ANY($${parameters.length}::text[])`);
    }
    parameters.push(limit);
    const result = await this.pool.query<EventPageRow>(`
      SELECT event, status, t, event_id
      FROM ${this.table("fold_events")}
      WHERE ${conditions.join(" AND ")}
      ORDER BY t, event_id
      LIMIT $${parameters.length}
    `, parameters);
    const last = result.rows.at(-1);
    return {
      entries: result.rows.map(({ event, status }) => ({
        event: event as FoldLogEntry["event"],
        status,
      })),
      ...(last === undefined ? {} : {
        scannedThrough: { t: Number(last.t), eventId: last.event_id },
      }),
    };
  }

  async latestEventCursor(workspaceId: string): Promise<FoldSdkCursor | undefined> {
    await this.open();
    const result = await this.pool.query<{ readonly t: number | string; readonly event_id: string }>(`
      SELECT t, event_id
      FROM ${this.table("fold_events")}
      WHERE workspace_id = $1
      ORDER BY t DESC, event_id DESC
      LIMIT 1
    `, [workspaceId]);
    const row = result.rows[0];
    return row === undefined ? undefined : { t: Number(row.t), eventId: row.event_id };
  }

  private async insertEntry(client: PoolClient, workspaceId: string, entry: FoldLogEntry): Promise<void> {
    const previous = await client.query<{ readonly event_id: string }>(`
      SELECT event_id
      FROM ${this.table("fold_events")}
      WHERE workspace_id = $1 AND t = $2
      ORDER BY sequence DESC
      LIMIT 1
    `, [workspaceId, entry.event.at.t]);
    const previousId = previous.rows[0]?.event_id;
    if (previousId !== undefined && previousId >= entry.event.id) {
      throw new PostgresFoldConflictError(
        `event id ${entry.event.id} is not monotonic after ${previousId} at t=${entry.event.at.t}`,
      );
    }
    try {
      await client.query(`
        INSERT INTO ${this.table("fold_events")}
          (workspace_id, t, event_id, kind, status, event)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb)
      `, [
        workspaceId,
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

  async appendEntries(workspaceId: string, entries: readonly FoldLogEntry[]): Promise<void> {
    if (entries.length === 0) return;
    await this.open();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`fold:${workspaceId}`]);
      for (const entry of entries) await this.insertEntry(client, workspaceId, entry);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async importEntries(workspaceId: string, entries: readonly FoldLogEntry[]): Promise<number> {
    if (entries.length === 0) return 0;
    await this.open();
    const client = await this.pool.connect();
    let imported = 0;
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`fold:${workspaceId}`]);
      for (const entry of entries) {
        const existing = await client.query<EventRow>(`
          SELECT event, status
          FROM ${this.table("fold_events")}
          WHERE workspace_id = $1 AND event_id = $2
        `, [workspaceId, entry.event.id]);
        const current = existing.rows[0];
        if (current !== undefined) {
          if (current.status !== entry.status || !isDeepStrictEqual(current.event, entry.event)) {
            throw new PostgresFoldConflictError(`imported event changed: ${entry.event.id}`);
          }
          continue;
        }
        await this.insertEntry(client, workspaceId, entry);
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

  async consumerCursor(workspaceId: string, consumerId: string): Promise<FoldSdkCursor | undefined> {
    await this.open();
    const result = await this.pool.query<CursorRow>(`
      SELECT cursor_t, cursor_event_id
      FROM ${this.table("fold_consumer_offsets")}
      WHERE workspace_id = $1 AND consumer_id = $2
    `, [workspaceId, consumerId]);
    const row = result.rows[0];
    return row === undefined ? undefined : { t: Number(row.cursor_t), eventId: row.cursor_event_id };
  }

  async commitConsumerCursor(
    workspaceId: string,
    consumerId: string,
    cursor: FoldSdkCursor,
  ): Promise<void> {
    if (consumerId.trim().length === 0) throw new TypeError("consumerId must not be empty");
    await this.open();
    const result = await this.pool.query(`
      INSERT INTO ${this.table("fold_consumer_offsets")}
        (workspace_id, consumer_id, cursor_t, cursor_event_id)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (workspace_id, consumer_id) DO UPDATE SET
        cursor_t = EXCLUDED.cursor_t,
        cursor_event_id = EXCLUDED.cursor_event_id,
        updated_at = clock_timestamp()
      WHERE (${this.table("fold_consumer_offsets")}.cursor_t, ${this.table("fold_consumer_offsets")}.cursor_event_id)
        <= (EXCLUDED.cursor_t, EXCLUDED.cursor_event_id)
      RETURNING cursor_t
    `, [workspaceId, consumerId, cursor.t, cursor.eventId]);
    if (result.rowCount === 0) {
      throw new PostgresFoldConflictError(`consumer cursor cannot move backward: ${consumerId}`);
    }
  }

  async projectionCheckpoint(
    workspaceId: string,
    projection: string,
  ): Promise<FoldProjectionCheckpoint | undefined> {
    await this.open();
    const result = await this.pool.query<CursorRow & QueryResultRow & {
      readonly state: unknown;
      readonly configuration_digest: string;
      readonly updated_at: Date | string;
    }>(`
      SELECT cursor_t, cursor_event_id, state, configuration_digest, updated_at
      FROM ${this.table("fold_projection_checkpoints")}
      WHERE workspace_id = $1 AND projection = $2
    `, [workspaceId, projection]);
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
    workspaceId: string,
    checkpoint: Omit<FoldProjectionCheckpoint, "updatedAt">,
  ): Promise<void> {
    await this.open();
    const result = await this.pool.query(`
      INSERT INTO ${this.table("fold_projection_checkpoints")}
        (workspace_id, projection, cursor_t, cursor_event_id, state, configuration_digest)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6)
      ON CONFLICT (workspace_id, projection) DO UPDATE SET
        cursor_t = EXCLUDED.cursor_t,
        cursor_event_id = EXCLUDED.cursor_event_id,
        state = EXCLUDED.state,
        configuration_digest = EXCLUDED.configuration_digest,
        updated_at = clock_timestamp()
      WHERE (${this.table("fold_projection_checkpoints")}.cursor_t, ${this.table("fold_projection_checkpoints")}.cursor_event_id)
        <= (EXCLUDED.cursor_t, EXCLUDED.cursor_event_id)
      RETURNING cursor_t
    `, [
      workspaceId,
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
    readonly workspaceId: string,
  ) {}

  async read(): Promise<{ readonly entries: readonly FoldLogEntry[]; readonly revision: string }> {
    return this.database.readSnapshot(this.workspaceId);
  }

  append(entry: FoldLogEntry): Promise<void> {
    return this.database.appendEntries(this.workspaceId, [entry]);
  }

  appendMany(entries: readonly FoldLogEntry[]): Promise<void> {
    return this.database.appendEntries(this.workspaceId, entries);
  }

  revision(): Promise<string> {
    return this.database.workspaceRevision(this.workspaceId);
  }
}
