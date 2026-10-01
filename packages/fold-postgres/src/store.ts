import { isDeepStrictEqual } from "node:util";

import { Pool, type PoolClient, type PoolConfig, type QueryResult, type QueryResultRow } from "pg";

import { compareEventKeys, type FoldLogEntry } from "@_89/fold";
import { BoundedCache, EpisodeService, immutable } from "@_89/fold-sdk";
import { episodeWindowFromEvent } from "@_89/fold-epistemic";
import type { MemoryCandidateDecision, MemoryCandidateView, PersonalMemory } from "@_89/fold-epistemic";
import { validateAccessContext, mergeMemoryCandidateEvidence, rebuildMemoryCandidates, candidateSupportSourceMatches } from "@_89/fold-epistemic";
import { rebuildIdentities, resolveProjectIds, rebuildTranscriptCatalog } from "@_89/fold-transcript";
import { advanceSystemProjection, systemProjectionKey, type SystemCheckpoint } from "./system-projection.js";
import type {
  FoldSdkAccessContext,
  FoldSdkProjectionCheckpoint,
  FoldSdkProjectionCheckpointKey,
  FoldSdkCursor,
  FoldIngestionCursor,
  FoldSdkStore,
  FoldSdkSystemProjection,
  FoldDeliveryCursor,
  FoldConsumerCursor,
  FoldCommandReceipt,
  FoldCommitOptions,
} from "@_89/fold-sdk";
import { checkedSchemaMode, recordSchemaVersion, STORE_SCHEMA, verifyPostgresSchema, type PostgresSchemaMode } from "./schema.js";

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/i;

function ingestionSequence(cursor: FoldIngestionCursor): string {
  if (cursor.kind !== "ingestion" || !/^(?:0|[1-9][0-9]{0,18})$/.test(cursor.sequence) || BigInt(cursor.sequence) > 9223372036854775807n) {
    throw new TypeError("invalid ingestion cursor");
  }
  return cursor.sequence;
}

interface EventRow extends QueryResultRow {
  readonly event: unknown;
  readonly status: "canon" | "draft";
}

interface SequencedEventRow extends EventRow {
  readonly sequence: number | string;
}

interface WorkspaceEventCache {
  sequence: bigint;
  readonly entries: readonly FoldLogEntry[];
  readonly bytes: number;
}

interface SelectionEventCache {
  sequence: bigint;
  readonly entries: FoldLogEntry[];
  readonly eventIds: Set<string>;
  snapshot?: readonly FoldLogEntry[];
}

export interface PostgresEventSelection {
  readonly kinds?: readonly string[];
  readonly kindPrefixes?: readonly string[];
  readonly latestBySession?: boolean;
  readonly trajectoryTaskId?: string;
  readonly transcriptRunId?: string;
  readonly transcriptChunkRunIds?: readonly string[];
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
  readonly schemaMode?: PostgresSchemaMode;
  readonly eventCacheBytes?: number;
  readonly eventPageSize?: number;
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

export interface PostgresVisibleEventPageOptions {
  readonly includeDrafts?: boolean;
  readonly kinds?: readonly string[];
  readonly limit: number;
  readonly before?: FoldSdkCursor;
  readonly identity?: Readonly<Partial<Record<"session" | "run" | "project" | "agent", string>>>;
}

export interface PostgresVisibleEventPage {
  readonly entries: readonly FoldLogEntry[];
  readonly total: number;
  readonly nextCursor?: FoldSdkCursor;
}

export interface PostgresWorkspaceDataQuality {
  readonly generatedAt: number;
  readonly corpus: {
    readonly events: number;
    readonly firstEventAt?: number;
    readonly lastEventAt?: number;
    readonly observations: number;
    readonly lifecycleSignals: number;
    readonly archivedRecords: number;
    readonly derivedRecords: number;
    readonly observedProjects: number;
    readonly observedSessions: number;
  };
  readonly transcripts: {
    readonly projects: number;
    readonly runs: number;
    readonly resolvedRuns: number;
    readonly turns: number;
    readonly actions: number;
    readonly unknownRecords: number;
    readonly artifacts: number;
    readonly storedArtifacts: number;
    readonly policyDeclaredArtifacts: number;
    readonly reasoningIncludedArtifacts: number;
    readonly redactions: number;
    readonly bySource: readonly { readonly source: string; readonly runs: number; readonly turns: number; readonly actions: number; readonly unknownRecords: number }[];
  };
  readonly memories: {
    readonly total: number;
    readonly withEvidence: number;
    readonly proposed: number;
    readonly accepted: number;
    readonly rejected: number;
    readonly highConfidencePending: number;
    readonly projectScopedPending: number;
    readonly duplicatePending: number;
    readonly oldestPendingAt?: number;
    readonly recalled: number;
    readonly validated: number;
    readonly feedback: { readonly recalled: number; readonly helpful: number; readonly unhelpful: number; readonly superseded: number };
    readonly candidateSources: readonly { readonly source: string; readonly proposed: number; readonly accepted: number; readonly rejected: number }[];
  };
  readonly trajectories: {
    readonly tasks: number;
    readonly runs: number;
    readonly successful: number;
    readonly failed: number;
    readonly unknown: number;
    readonly reviewed: number;
    readonly tasksWithDecisions: number;
    readonly tasksWithOutcomes: number;
    readonly nodes: number;
    readonly decisionNodes: number;
    readonly mappedSteps: number;
    readonly totalSteps: number;
  };
}

interface QualityCorpusRow extends QueryResultRow {
  readonly events: string;
  readonly first_event_at: number | string | null;
  readonly last_event_at: number | string | null;
  readonly observations: string;
  readonly lifecycle_signals: string;
  readonly archived_records: string;
  readonly derived_records: string;
  readonly observed_projects: string;
  readonly observed_sessions: string;
}

interface QualityTranscriptRow extends QueryResultRow {
  readonly projects: string;
  readonly runs: string;
  readonly resolved_runs: string;
  readonly turns: string;
  readonly actions: string;
  readonly unknown_records: string;
  readonly artifacts: string;
  readonly stored_artifacts: string;
  readonly policy_declared_artifacts: string;
  readonly reasoning_included_artifacts: string;
  readonly redactions: string;
}

interface QualityTranscriptSourceRow extends QueryResultRow {
  readonly source: string;
  readonly runs: string;
  readonly turns: string;
  readonly actions: string;
  readonly unknown_records: string;
}

interface QualityMemoryRow extends QueryResultRow {
  readonly total: string;
  readonly with_evidence: string;
  readonly proposed: string;
  readonly accepted: string;
  readonly rejected: string;
  readonly high_confidence_pending: string;
  readonly project_scoped_pending: string;
  readonly duplicate_pending: string;
  readonly oldest_pending_at: number | string | null;
  readonly recalled: string;
  readonly validated: string;
  readonly feedback_recalled: string;
  readonly feedback_helpful: string;
  readonly feedback_unhelpful: string;
  readonly feedback_superseded: string;
}

interface QualityCandidateSourceRow extends QueryResultRow {
  readonly source: string;
  readonly proposed: string;
  readonly accepted: string;
  readonly rejected: string;
}

interface QualityTrajectoryRow extends QueryResultRow {
  readonly tasks: string;
  readonly runs: string;
  readonly successful: string;
  readonly failed: string;
  readonly unknown: string;
  readonly reviewed: string;
  readonly tasks_with_decisions: string;
  readonly tasks_with_outcomes: string;
  readonly nodes: string;
  readonly decision_nodes: string;
  readonly mapped_steps: string;
  readonly total_steps: string;
}

interface TrajectoryTaskSummaryRow extends QueryResultRow {
  readonly task_id: string;
  readonly trajectory_count: string;
  readonly success_count: string;
  readonly failure_count: string;
  readonly unknown_count: string;
  readonly last_recorded_at: number | string;
}

export interface PostgresTrajectoryTaskSummary {
  readonly taskId: string;
  readonly trajectoryCount: number;
  readonly successCount: number;
  readonly failureCount: number;
  readonly unknownCount: number;
  readonly lastRecordedAt: number;
}

interface EpistemicProjectionRow extends QueryResultRow {
  readonly sequence: number | string;
  readonly event_id: string;
  readonly kind: string;
  readonly payload: unknown;
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

function numeric(value: number | string | null | undefined): number {
  return value === null || value === undefined ? 0 : Number(value);
}

export class PostgresFoldDatabase {
  private readonly pool: Pool;
  private readonly schema: string;
  private readonly ready: Promise<void>;
  private readonly requireRlsEnforcement: boolean;
  private readonly schemaMode: PostgresSchemaMode;
  private readonly schemaName: string;
  private closed = false;
  private readonly eventCaches: BoundedCache<string, WorkspaceEventCache>;
  private readonly eventReads = new Map<string, { readonly minimum: bigint; readonly promise: Promise<{ readonly entries: readonly FoldLogEntry[]; readonly revision: string }> }>();
  private readonly eventPageSize: number;
  private readonly selectionCaches = new Map<string, SelectionEventCache>();
  private readonly systemProjections = new Map<string, SystemCheckpoint>();

  constructor(options: PostgresFoldDatabaseOptions) {
    if (options.connectionString.trim().length === 0) {
      throw new TypeError("connectionString must not be empty");
    }
    this.schemaName = options.schema ?? "public";
    this.schema = checkedIdentifier(this.schemaName);
    this.schemaMode = checkedSchemaMode(options.schemaMode);
    this.pool = new Pool({ connectionString: options.connectionString, connectionTimeoutMillis: 5_000, ...options.pool });
    this.requireRlsEnforcement = options.requireRlsEnforcement === true;
    const budget = options.eventCacheBytes ?? 128 * 1024 * 1024;
    this.eventPageSize = options.eventPageSize ?? 1_000;
    if (!Number.isSafeInteger(budget) || budget < 0 || !Number.isInteger(this.eventPageSize) || this.eventPageSize < 1 || this.eventPageSize > 10_000) throw new TypeError("invalid bounded snapshot options");
    this.eventCaches = new BoundedCache(budget, 64, (cache) => cache.bytes);
    this.ready = this.initialize();
  }

  private table(name: string): string {
    return `${this.schema}.${checkedIdentifier(name)}`;
  }

  private async initialize(): Promise<void> {
    const client = await this.pool.connect();
    try {
      if (this.schemaMode === "verify") {
        await client.query("BEGIN READ ONLY");
        await client.query("SELECT pg_advisory_xact_lock_shared(hashtext('fold-schema-v1'))");
        await verifyPostgresSchema(client, this.schemaName, STORE_SCHEMA);
        await client.query("COMMIT");
        return;
      }
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
        CREATE INDEX IF NOT EXISTS fold_events_tenant_kind_ingestion
        ON ${this.table("fold_events")} (organization_id, workspace_id, kind, sequence)
        WHERE status = 'canon'
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS fold_events_transcript_run_identity
        ON ${this.table("fold_events")} (
          organization_id, workspace_id,
          (COALESCE(event #>> '{changes,0,after,run,id}', event #>> '{changes,0,after,chunk,runId}', event #>> '{changes,0,after,manifest,runId}')),
          sequence
        )
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS fold_events_trajectory_tree_task
        ON ${this.table("fold_events")} (
          organization_id,
          workspace_id,
          (event #>> '{changes,0,after,tree,taskId}'),
          sequence DESC,
          t
        )
        WHERE status = 'canon' AND kind = 'trajectory.tree-recorded'
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS fold_events_trajectory_run_task_outcome
        ON ${this.table("fold_events")} (
          organization_id,
          workspace_id,
          (event #>> '{changes,0,after,trajectory,taskId}'),
          (event #>> '{changes,0,after,trajectory,outcome}'),
          t
        )
        WHERE status = 'canon' AND kind = 'trajectory.recorded'
      `);
      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS fold_events_trajectory_outcome_predecessor
        ON ${this.table("fold_events")} (
          organization_id, workspace_id,
          (event #>> '{changes,0,after,trajectoryId}'),
          (COALESCE(event #>> '{changes,0,after,previousEventId}', ''))
        )
        WHERE status = 'canon' AND kind = 'trajectory.outcome-recorded'
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS fold_events_trajectory_tree_task_access
        ON ${this.table("fold_events")} (
          organization_id,
          workspace_id,
          (event #>> '{changes,0,after,tree,taskId}'),
          (event #>> '{capture,scope,creator}'),
          (event #>> '{capture,scope,space}'),
          sequence DESC,
          t
        )
        WHERE status = 'canon' AND kind = 'trajectory.tree-recorded'
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS fold_events_trajectory_run_task_outcome_access
        ON ${this.table("fold_events")} (
          organization_id,
          workspace_id,
          (event #>> '{changes,0,after,trajectory,taskId}'),
          (event #>> '{changes,0,after,trajectory,outcome}'),
          (event #>> '{capture,scope,creator}'),
          (event #>> '{capture,scope,space}'),
          t
        )
        WHERE status = 'canon' AND kind = 'trajectory.recorded'
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
      await client.query(`CREATE TABLE IF NOT EXISTS ${this.table("fold_ingestion_cursor_resets")} (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        organization_id text NOT NULL,
        workspace_id text NOT NULL,
        consumer_id text NOT NULL,
        actor_id text NOT NULL,
        previous_sequence bigint NOT NULL CHECK (previous_sequence >= 0),
        next_sequence bigint NOT NULL DEFAULT 0 CHECK (next_sequence = 0),
        reason text NOT NULL,
        reset_at timestamptz NOT NULL DEFAULT clock_timestamp()
      )`);
      await client.query(`CREATE INDEX IF NOT EXISTS fold_ingestion_cursor_resets_consumer
        ON ${this.table("fold_ingestion_cursor_resets")} (organization_id,workspace_id,consumer_id,id DESC)`);
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
      await client.query(`ALTER TABLE ${this.table("fold_projection_checkpoints")}
        ADD COLUMN IF NOT EXISTS format_version integer NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS state_version text,
        ADD COLUMN IF NOT EXISTS source_revision text,
        ADD COLUMN IF NOT EXISTS ingestion_sequence bigint,
        ADD COLUMN IF NOT EXISTS access_digest text`);
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
      await client.query(`CREATE TABLE IF NOT EXISTS ${this.table("fold_system_projection_cells")} (
        organization_id text NOT NULL,
        workspace_id text NOT NULL,
        projection text NOT NULL,
        section text NOT NULL CHECK (section IN ('nodes', 'edges', 'values', 'redirects', 'diagnostics')),
        cell_id text NOT NULL,
        value jsonb NOT NULL,
        PRIMARY KEY (organization_id, workspace_id, projection, section, cell_id)
      )`);
      for (const tableName of ["fold_events", "fold_consumer_offsets", "fold_ingestion_cursor_resets", "fold_projection_checkpoints", "fold_command_receipts", "fold_system_projection_cells"] as const) {
        await client.query(`ALTER TABLE ${this.table(tableName)} ENABLE ROW LEVEL SECURITY`);
        await client.query(`ALTER TABLE ${this.table(tableName)} FORCE ROW LEVEL SECURITY`);
        await client.query(`DROP POLICY IF EXISTS fold_organization_isolation ON ${this.table(tableName)}`);
        await client.query(`CREATE POLICY fold_organization_isolation ON ${this.table(tableName)}
          USING (organization_id = current_setting('app.organization_id', true))
          WITH CHECK (organization_id = current_setting('app.organization_id', true))`);
      }
      await recordSchemaVersion(client, this.schemaName, STORE_SCHEMA);
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
      // Runtime transactions share the schema gate before taking table/tenant locks.
      // Initializers hold it exclusively, preventing DDL/bootstrap lock inversions.
      await client.query("SELECT pg_advisory_xact_lock_shared(hashtext('fold-schema-v1'))");
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

  store(input: PostgresTenantInput, selection?: PostgresEventSelection): PostgresFoldStore {
    return new PostgresFoldStore(this, tenantScope(input), selection);
  }

  async systemProjection(input: PostgresTenantInput, access: FoldSdkAccessContext, include: "canon" | "canon+draft"): Promise<FoldSdkSystemProjection> {
    await this.open();
    validateAccessContext(access);
    const tenant = tenantScope(input);
    if (access.workspaceId !== tenant.workspaceId ||
      (access.organizationId !== undefined && access.organizationId !== tenant.organizationId)) {
      throw new TypeError("system projection access tenant mismatch");
    }
    const key = systemProjectionKey(access, include);
    const cacheKey = JSON.stringify([tenant.organizationId, tenant.workspaceId, key]);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock_shared(hashtext('fold-schema-v1'))");
      await this.setTenant(client, tenant);
      const result = await advanceSystemProjection(client, {
        events: this.table("fold_events"), checkpoints: this.table("fold_projection_checkpoints"), cells: this.table("fold_system_projection_cells"),
      }, tenant, access, include, key, this.systemProjections.get(cacheKey));
      await client.query("COMMIT");
      this.systemProjections.delete(cacheKey);
      this.systemProjections.set(cacheKey, result);
      while (this.systemProjections.size > 4) this.systemProjections.delete(this.systemProjections.keys().next().value!);
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async readSnapshot(
    input: PostgresTenantInput,
    selection?: PostgresEventSelection,
  ): Promise<{ readonly entries: readonly FoldLogEntry[]; readonly revision: string }> {
    await this.open();
    if (selection !== undefined && Object.keys(selection).length > 0) return this.readSelectionSnapshot(tenantScope(input), selection);
    const tenant = tenantScope(input), key = tenantCacheKey(tenant);
    const minimum = BigInt(await this.workspaceRevision(tenant));
    const active = this.eventReads.get(key);
    if (active !== undefined && active.minimum >= minimum) return active.promise;
    const load = () => this.loadSnapshot(tenant, key, minimum);
    const reading = active === undefined ? load() : active.promise.then(load, load);
    const flight = { minimum, promise: reading };
    this.eventReads.set(key, flight);
    try { return await reading; }
    finally { if (this.eventReads.get(key) === flight) this.eventReads.delete(key); }
  }

  private async loadSnapshot(tenant: PostgresTenantScope, key: string, head: bigint): Promise<{ readonly entries: readonly FoldLogEntry[]; readonly revision: string }> {
    // Pin ingestion head first. New/backdated arrivals cannot extend this read indefinitely.
    let prior = this.eventCaches.get(key);
    if (prior !== undefined && prior.sequence > head) prior = undefined;
    if (prior?.sequence === head) return { entries: prior.entries, revision: head.toString() };
    let sequence = prior?.sequence ?? 0n, bytes = prior?.bytes ?? 0;
    const added: FoldLogEntry[] = [];
    while (sequence < head) {
      const page = await this.tenantQuery<SequencedEventRow>(tenant, `
        SELECT sequence, event, status FROM ${this.table("fold_events")}
        WHERE organization_id = $1 AND workspace_id = $2 AND sequence > $3 AND sequence <= $4
        ORDER BY sequence LIMIT $5
      `, [tenant.organizationId, tenant.workspaceId, sequence.toString(), head.toString(), this.eventPageSize]);
      if (page.rows.length === 0) throw new PostgresFoldConflictError("pinned ingestion snapshot is incomplete");
      for (const row of page.rows) {
        const entry = immutable({ event: row.event as FoldLogEntry["event"], status: row.status });
        added.push(entry); bytes += 2 * Buffer.byteLength(JSON.stringify(entry)) + 128;
        sequence = BigInt(row.sequence);
      }
    }
    const entries = Object.freeze([...(prior?.entries ?? []), ...added].sort((left, right) =>
      left.event.at.t - right.event.at.t || (left.event.id < right.event.id ? -1 : left.event.id > right.event.id ? 1 : 0)));
    this.eventCaches.set(key, { sequence: head, entries, bytes });
    return { entries, revision: head.toString() };
  }

  /** SQL predicates shared by selected snapshots, their revision, and command CAS. */
  private selectionSql(selection: PostgresEventSelection | undefined, parameters: unknown[], column = ""): string {
    const selectionConditions: string[] = [];
    if ((selection?.kinds?.length ?? 0) > 0) {
      parameters.push([...selection!.kinds!]);
      selectionConditions.push(`${column}kind = ANY($${parameters.length}::text[])`);
    }
    if ((selection?.kindPrefixes?.length ?? 0) > 0) {
      parameters.push(selection!.kindPrefixes!.map((prefix) => `${prefix}%`));
      selectionConditions.push(`${column}kind LIKE ANY($${parameters.length}::text[])`);
    }
    let sql = selectionConditions.length === 0 ? "" : ` AND (${selectionConditions.join(" OR ")})`;
    if (selection?.trajectoryTaskId !== undefined) {
      parameters.push(selection.trajectoryTaskId);
      sql += ` AND (
        ${column}event #>> '{changes,0,after,tree,taskId}' = $${parameters.length}
        OR ${column}event #>> '{changes,0,after,trajectory,taskId}' = $${parameters.length}
        OR (${column}kind = 'trajectory.outcome-recorded' AND ${column}event #>> '{changes,0,after,taskId}' = $${parameters.length})
      )`;
    }
    if (selection?.transcriptRunId !== undefined) {
      parameters.push(selection.transcriptRunId);
      sql += ` AND (
        ${column}kind = 'transcript.project-recorded'
        OR (${column}kind = 'transcript.artifact-imported' AND ${column}event #>> '{changes,0,after,artifact,id}' IN (
          SELECT source.event #>> '{changes,0,after,run,artifactId}' FROM ${this.table("fold_events")} source
          WHERE source.organization_id = $1 AND source.workspace_id = $2
            AND source.kind = 'transcript.run-imported' AND source.event #>> '{changes,0,after,run,id}' = $${parameters.length}
        ))
        OR COALESCE(${column}event #>> '{changes,0,after,run,id}', ${column}event #>> '{changes,0,after,chunk,runId}', ${column}event #>> '{changes,0,after,manifest,runId}') = $${parameters.length}
      )`;
    }
    if (selection?.transcriptChunkRunIds !== undefined) {
      parameters.push(selection.transcriptChunkRunIds);
      sql += ` AND (${column}kind <> 'transcript.chunk-imported' OR ${column}event #>> '{changes,0,after,chunk,runId}' = ANY($${parameters.length}::text[]))`;
    }
    return sql;
  }

  /**
   * A selected snapshot is pinned to the selection's ingestion head, and its revision is the
   * head of that selection; commands committed through a selected store compare the same head.
   */
  private async readSelectionSnapshot(tenant: PostgresTenantScope, selection: PostgresEventSelection): Promise<{ readonly entries: readonly FoldLogEntry[]; readonly revision: string }> {
    const key = `${tenantCacheKey(tenant)}:${JSON.stringify(selection)}`;
    const head = BigInt(await this.workspaceRevision(tenant, selection));
    let cache = this.selectionCaches.get(key);
    if (cache === undefined || cache.sequence > head) cache = { sequence: 0n, entries: [], eventIds: new Set() };
    // Backfills visit many selections; evicted snapshots rebuild from canonical rows.
    this.selectionCaches.delete(key);
    this.selectionCaches.set(key, cache);
    while (this.selectionCaches.size > 16) this.selectionCaches.delete(this.selectionCaches.keys().next().value!);
    if (cache.sequence === head && cache.snapshot !== undefined) return { entries: cache.snapshot, revision: head.toString() };
    const parameters: unknown[] = [tenant.organizationId, tenant.workspaceId, cache.sequence.toString(), head.toString()];
    const filters = this.selectionSql(selection, parameters);
    const sinceSql = selection.transcriptRunId === undefined
      ? "sequence > $3::bigint AND sequence <= $4::bigint"
      : "((sequence > $3::bigint AND sequence <= $4::bigint) OR kind = 'transcript.artifact-imported')";
    const result = selection.latestBySession === true
      ? await this.tenantQuery<SequencedEventRow>(tenant, `
          SELECT sequence, event, status
          FROM (
            SELECT sequence, event, status,
              row_number() OVER (
                PARTITION BY event #>> '{capture,identity,session}', kind,
                  CASE
                    WHEN kind = 'lifecycle' AND event #>> '{lifecycle,phase}' <> 'heartbeat'
                    THEN 'declared'
                    ELSE 'current'
                  END
                ORDER BY sequence DESC
              ) AS session_rank
            FROM ${this.table("fold_events")}
            WHERE organization_id = $1 AND workspace_id = $2 AND ${sinceSql}${filters}
          ) latest_session_events
          WHERE session_rank = 1
          ORDER BY sequence
        `, parameters)
      : await this.tenantQuery<SequencedEventRow>(tenant, `
          SELECT sequence, event, status
          FROM ${this.table("fold_events")}
          WHERE organization_id = $1 AND workspace_id = $2 AND ${sinceSql}${filters}
          ORDER BY sequence
        `, parameters);
    for (const row of result.rows) {
      const event = row.event as FoldLogEntry["event"];
      if (cache.eventIds.has(event.id)) continue;
      cache.eventIds.add(event.id);
      cache.entries.push(immutable({ event, status: row.status }));
    }
    cache.sequence = head;
    cache.entries.sort((left, right) =>
      left.event.at.t - right.event.at.t || (left.event.id < right.event.id ? -1 : left.event.id > right.event.id ? 1 : 0));
    cache.snapshot = Object.freeze([...cache.entries]);
    return { entries: cache.snapshot, revision: head.toString() };
  }

  eventCacheUsageBytes(): number { return this.eventCaches.bytes; }

  async readEntries(input: PostgresTenantInput, selection?: PostgresEventSelection): Promise<readonly FoldLogEntry[]> {
    return (await this.readSnapshot(input, selection)).entries;
  }

  async workspaceRevision(input: PostgresTenantInput, selection?: PostgresEventSelection): Promise<string> {
    await this.open();
    const tenant = tenantScope(input);
    const parameters: unknown[] = [tenant.organizationId, tenant.workspaceId];
    const filters = this.selectionSql(selection, parameters);
    const result = await this.tenantQuery<{ readonly sequence: number | string }>(tenant, `
      SELECT COALESCE(MAX(sequence), 0) AS sequence
      FROM ${this.table("fold_events")}
      WHERE organization_id = $1 AND workspace_id = $2${filters}
    `, parameters);
    return String(result.rows[0]?.sequence ?? "0");
  }

  async workspaceDataQuality(
    input: PostgresTenantInput,
    access: FoldSdkAccessContext,
  ): Promise<PostgresWorkspaceDataQuality> {
    await this.open();
    const tenant = tenantScope(input);
    if (access.workspaceId !== tenant.workspaceId) throw new TypeError("data quality access workspace mismatch");
    const parameters: unknown[] = [tenant.organizationId, tenant.workspaceId];
    const accessConditions: string[] = [];
    if (access.platformDataAccess !== true) {
      parameters.push(access.principalId, Object.keys(access.spaceRoles));
      accessConditions.push(`
        (event #>> '{capture,scope,creator}' IS NULL OR event #>> '{capture,scope,creator}' = $3)
        AND (event #>> '{capture,scope,space}' IS NULL OR event #>> '{capture,scope,space}' = ANY($4::text[]))
      `);
    }
    const visible = `
      organization_id = $1 AND workspace_id = $2 AND status = 'canon'
      ${accessConditions.length === 0 ? "" : `AND (${accessConditions.join(" AND ")})`}
    `;
    const [corpusResult, transcriptResult, transcriptSourcesResult, memoryResult, candidateSourcesResult, trajectoryResult] = await Promise.all([
      this.tenantQuery<QualityCorpusRow>(tenant, `
        SELECT
          count(*) AS events,
          min(t) AS first_event_at,
          max(t) AS last_event_at,
          count(*) FILTER (WHERE kind = 'terminal.observation') AS observations,
          count(*) FILTER (WHERE kind = 'lifecycle') AS lifecycle_signals,
          count(*) FILTER (WHERE kind LIKE 'transcript.%' AND kind NOT LIKE 'transcript.derivation%') AS archived_records,
          count(*) FILTER (WHERE kind LIKE 'memory.%' OR kind LIKE 'trajectory.%' OR kind LIKE 'transcript.derivation%') AS derived_records,
          count(DISTINCT event #>> '{capture,identity,project}') FILTER (WHERE kind = 'terminal.observation') AS observed_projects,
          count(DISTINCT event #>> '{capture,identity,session}') FILTER (WHERE kind = 'terminal.observation') AS observed_sessions
        FROM ${this.table("fold_events")}
        WHERE ${visible}
      `, parameters),
      this.tenantQuery<QualityTranscriptRow>(tenant, `
        SELECT
          count(*) FILTER (WHERE kind = 'transcript.project-recorded') AS projects,
          count(*) FILTER (WHERE kind = 'transcript.run-imported') AS runs,
          count(*) FILTER (WHERE kind = 'transcript.run-imported' AND event #>> '{changes,0,after,run,projectResolution}' = 'resolved') AS resolved_runs,
          COALESCE(sum((event #>> '{changes,0,after,run,counts,turns}')::bigint) FILTER (WHERE kind = 'transcript.run-imported'), 0) AS turns,
          COALESCE(sum((event #>> '{changes,0,after,run,counts,actions}')::bigint) FILTER (WHERE kind = 'transcript.run-imported'), 0) AS actions,
          COALESCE(sum((event #>> '{changes,0,after,run,counts,unknown}')::bigint) FILTER (WHERE kind = 'transcript.run-imported'), 0) AS unknown_records,
          count(*) FILTER (WHERE kind = 'transcript.artifact-imported') AS artifacts,
          count(*) FILTER (WHERE kind = 'transcript.artifact-imported' AND (event #>> '{changes,0,after,artifact,stored}')::boolean) AS stored_artifacts,
          count(*) FILTER (WHERE kind = 'transcript.artifact-imported' AND event #>> '{changes,0,after,artifact,reasoningPolicy}' IS NOT NULL) AS policy_declared_artifacts,
          count(*) FILTER (WHERE kind = 'transcript.artifact-imported' AND event #>> '{changes,0,after,artifact,reasoningPolicy}' = 'included') AS reasoning_included_artifacts,
          COALESCE(sum((event #>> '{changes,0,after,artifact,redactionCount}')::bigint) FILTER (WHERE kind = 'transcript.artifact-imported'), 0) AS redactions
        FROM ${this.table("fold_events")}
        WHERE ${visible} AND kind LIKE 'transcript.%'
      `, parameters),
      this.tenantQuery<QualityTranscriptSourceRow>(tenant, `
        SELECT
          event #>> '{changes,0,after,run,source}' AS source,
          count(*) AS runs,
          COALESCE(sum((event #>> '{changes,0,after,run,counts,turns}')::bigint), 0) AS turns,
          COALESCE(sum((event #>> '{changes,0,after,run,counts,actions}')::bigint), 0) AS actions,
          COALESCE(sum((event #>> '{changes,0,after,run,counts,unknown}')::bigint), 0) AS unknown_records
        FROM ${this.table("fold_events")}
        WHERE ${visible} AND kind = 'transcript.run-imported'
        GROUP BY 1 ORDER BY runs DESC, source
      `, parameters),
      this.tenantQuery<QualityMemoryRow>(tenant, `
        WITH proposals AS MATERIALIZED (
          SELECT sequence, event #> '{changes,0,after,candidate}' AS candidate
          FROM ${this.table("fold_events")} WHERE ${visible} AND kind = 'memory.candidate-proposed'
        ), decision_events AS MATERIALIZED (
          SELECT sequence,
                 event #>> '{changes,0,after,candidateId}' AS candidate_id,
                 event #>> '{changes,0,after,recordType}' AS status
          FROM ${this.table("fold_events")}
          WHERE ${visible} AND kind IN ('memory.candidate-accepted', 'memory.candidate-rejected')
        ), decisions AS MATERIALIZED (
          SELECT DISTINCT ON (candidate_id) candidate_id, status
          FROM decision_events
          ORDER BY candidate_id, sequence DESC
        ), candidate_views AS (
          SELECT candidate, COALESCE(decisions.status, 'proposed') AS status
          FROM proposals LEFT JOIN decisions ON decisions.candidate_id = candidate->>'id'
        ), pending AS (
          SELECT candidate FROM candidate_views WHERE status = 'proposed'
        ), recorded_events AS MATERIALIZED (
          SELECT sequence, event #> '{changes,0,after,memory}' AS memory
          FROM ${this.table("fold_events")} WHERE ${visible} AND kind = 'memory.recorded'
        ), recorded AS (
          SELECT DISTINCT ON (memory->>'id') memory
          FROM recorded_events
          ORDER BY memory->>'id', sequence DESC
        ), forgotten AS (
          SELECT event #>> '{changes,0,after,memoryId}' AS memory_id
          FROM ${this.table("fold_events")} WHERE ${visible} AND kind = 'memory.forgotten'
        ), revised_evidence AS (
          SELECT DISTINCT ON (event #>> '{changes,0,after,memoryId}')
            event #>> '{changes,0,after,memoryId}' AS memory_id,
            event #> '{changes,0,after,patch,evidence}' AS evidence
          FROM ${this.table("fold_events")}
          WHERE ${visible} AND kind = 'memory.revised'
            AND (event #> '{changes,0,after,patch}') ? 'evidence'
          ORDER BY event #>> '{changes,0,after,memoryId}', t DESC, event_id DESC
        ), current_memories AS (
          SELECT CASE WHEN revised_evidence.memory_id IS NULL THEN memory
            ELSE memory || jsonb_build_object('evidence', revised_evidence.evidence) END AS memory
          FROM recorded LEFT JOIN revised_evidence ON revised_evidence.memory_id = memory->>'id'
          WHERE NOT EXISTS (SELECT 1 FROM forgotten WHERE forgotten.memory_id = memory->>'id')
        ), feedback AS (
          SELECT event #>> '{changes,0,after,memoryId}' AS memory_id,
                 event #>> '{changes,0,after,signal}' AS signal
          FROM ${this.table("fold_events")} WHERE ${visible} AND kind = 'memory.feedback-recorded'
        )
        SELECT
          (SELECT count(*) FROM current_memories) AS total,
          (SELECT count(*) FROM current_memories WHERE jsonb_array_length(COALESCE(memory->'evidence', '[]'::jsonb)) > 0) AS with_evidence,
          (SELECT count(*) FROM candidate_views WHERE status = 'proposed') AS proposed,
          (SELECT count(*) FROM candidate_views WHERE status = 'accepted') AS accepted,
          (SELECT count(*) FROM candidate_views WHERE status = 'rejected') AS rejected,
          (SELECT count(*) FROM pending WHERE (candidate->>'confidence')::numeric >= 0.8) AS high_confidence_pending,
          (SELECT count(*) FROM pending WHERE jsonb_array_length(candidate->'projectIds') > 0) AS project_scoped_pending,
          (SELECT count(*) - count(DISTINCT lower(regexp_replace(candidate->>'summary', '[^a-zA-Z0-9]+', ' ', 'g'))) FROM pending) AS duplicate_pending,
          (SELECT min((candidate->>'proposedAt')::double precision) FROM pending) AS oldest_pending_at,
          (SELECT count(DISTINCT memory_id) FROM feedback WHERE signal = 'recalled') AS recalled,
          (SELECT count(DISTINCT memory_id) FROM feedback WHERE signal IN ('helpful', 'unhelpful', 'superseded')) AS validated,
          (SELECT count(*) FROM feedback WHERE signal = 'recalled') AS feedback_recalled,
          (SELECT count(*) FROM feedback WHERE signal = 'helpful') AS feedback_helpful,
          (SELECT count(*) FROM feedback WHERE signal = 'unhelpful') AS feedback_unhelpful,
          (SELECT count(*) FROM feedback WHERE signal = 'superseded') AS feedback_superseded
      `, parameters),
      this.tenantQuery<QualityCandidateSourceRow>(tenant, `
        WITH proposals AS MATERIALIZED (
          SELECT sequence, event #> '{changes,0,after,candidate}' AS candidate
          FROM ${this.table("fold_events")} WHERE ${visible} AND kind = 'memory.candidate-proposed'
        ), decision_events AS MATERIALIZED (
          SELECT sequence,
                 event #>> '{changes,0,after,candidateId}' AS candidate_id,
                 event #>> '{changes,0,after,recordType}' AS status
          FROM ${this.table("fold_events")}
          WHERE ${visible} AND kind IN ('memory.candidate-accepted', 'memory.candidate-rejected')
        ), decisions AS MATERIALIZED (
          SELECT DISTINCT ON (candidate_id) candidate_id, status
          FROM decision_events
          ORDER BY candidate_id, sequence DESC
        ), views AS (
          SELECT candidate, COALESCE(decisions.status, 'proposed') AS status
          FROM proposals LEFT JOIN decisions ON decisions.candidate_id = candidate->>'id'
        )
        SELECT candidate->>'source' AS source,
          count(*) FILTER (WHERE status = 'proposed') AS proposed,
          count(*) FILTER (WHERE status = 'accepted') AS accepted,
          count(*) FILTER (WHERE status = 'rejected') AS rejected
        FROM views GROUP BY 1 ORDER BY count(*) DESC, source
      `, parameters),
      this.tenantQuery<QualityTrajectoryRow>(tenant, `
        WITH tree_revisions AS (
          SELECT sequence, event #> '{changes,0,after,tree}' AS tree
          FROM ${this.table("fold_events")} WHERE ${visible} AND kind = 'trajectory.tree-recorded'
        ), trees AS (
          SELECT DISTINCT ON (tree->>'taskId') tree
          FROM tree_revisions ORDER BY tree->>'taskId', sequence DESC
        ), outcome_reviews AS (
          SELECT DISTINCT ON (event #>> '{changes,0,after,trajectoryId}')
            event #>> '{changes,0,after,trajectoryId}' AS trajectory_id,
            event #>> '{changes,0,after,outcome}' AS outcome
          FROM ${this.table("fold_events")} WHERE ${visible} AND kind = 'trajectory.outcome-recorded'
          ORDER BY event #>> '{changes,0,after,trajectoryId}', sequence DESC
        ), original_runs AS (
          SELECT event #> '{changes,0,after}' AS record
          FROM ${this.table("fold_events")} WHERE ${visible} AND kind = 'trajectory.recorded'
        ), trajectory_runs AS (
          SELECT record,
            COALESCE(outcome_reviews.outcome, record #>> '{trajectory,outcome}') AS outcome,
            outcome_reviews.trajectory_id IS NOT NULL OR length(trim(COALESCE(record->>'reviewText', ''))) > 0 AS reviewed
          FROM original_runs LEFT JOIN outcome_reviews ON outcome_reviews.trajectory_id = record #>> '{trajectory,id}'
        )
        SELECT
          (SELECT count(*) FROM trees) AS tasks,
          (SELECT count(*) FROM trajectory_runs) AS runs,
          (SELECT count(*) FROM trajectory_runs WHERE outcome = 'success') AS successful,
          (SELECT count(*) FROM trajectory_runs WHERE outcome = 'failure') AS failed,
          (SELECT count(*) FROM trajectory_runs WHERE outcome = 'unknown') AS unknown,
          (SELECT count(*) FROM trajectory_runs WHERE reviewed) AS reviewed,
          (SELECT count(*) FROM trees WHERE jsonb_path_exists(tree, '$.nodes[*] ? (@.kind == "decision")')) AS tasks_with_decisions,
          (SELECT count(*) FROM trees WHERE jsonb_path_exists(tree, '$.nodes[*] ? (@.kind == "outcome")')) AS tasks_with_outcomes,
          (SELECT COALESCE(sum(jsonb_array_length(tree->'nodes')), 0) FROM trees) AS nodes,
          (SELECT count(*) FROM trees CROSS JOIN LATERAL jsonb_array_elements(tree->'nodes') node WHERE node->>'kind' = 'decision') AS decision_nodes,
          (SELECT count(*) FROM trajectory_runs CROSS JOIN LATERAL jsonb_each(record->'assignments') assignment WHERE assignment.value->>'kind' = 'mapped') AS mapped_steps,
          (SELECT COALESCE(sum(jsonb_array_length(record #> '{trajectory,steps}')), 0) FROM trajectory_runs) AS total_steps
      `, parameters),
    ]);
    const corpus = corpusResult.rows[0]!;
    const transcript = transcriptResult.rows[0]!;
    const memory = memoryResult.rows[0]!;
    const trajectory = trajectoryResult.rows[0]!;
    return {
      generatedAt: Date.now(),
      corpus: {
        events: numeric(corpus.events),
        ...(corpus.first_event_at === null ? {} : { firstEventAt: numeric(corpus.first_event_at) }),
        ...(corpus.last_event_at === null ? {} : { lastEventAt: numeric(corpus.last_event_at) }),
        observations: numeric(corpus.observations),
        lifecycleSignals: numeric(corpus.lifecycle_signals),
        archivedRecords: numeric(corpus.archived_records),
        derivedRecords: numeric(corpus.derived_records),
        observedProjects: numeric(corpus.observed_projects),
        observedSessions: numeric(corpus.observed_sessions),
      },
      transcripts: {
        projects: numeric(transcript.projects),
        runs: numeric(transcript.runs),
        resolvedRuns: numeric(transcript.resolved_runs),
        turns: numeric(transcript.turns),
        actions: numeric(transcript.actions),
        unknownRecords: numeric(transcript.unknown_records),
        artifacts: numeric(transcript.artifacts),
        storedArtifacts: numeric(transcript.stored_artifacts),
        policyDeclaredArtifacts: numeric(transcript.policy_declared_artifacts),
        reasoningIncludedArtifacts: numeric(transcript.reasoning_included_artifacts),
        redactions: numeric(transcript.redactions),
        bySource: transcriptSourcesResult.rows.map((row) => ({
          source: row.source,
          runs: numeric(row.runs),
          turns: numeric(row.turns),
          actions: numeric(row.actions),
          unknownRecords: numeric(row.unknown_records),
        })),
      },
      memories: {
        total: numeric(memory.total),
        withEvidence: numeric(memory.with_evidence),
        proposed: numeric(memory.proposed),
        accepted: numeric(memory.accepted),
        rejected: numeric(memory.rejected),
        highConfidencePending: numeric(memory.high_confidence_pending),
        projectScopedPending: numeric(memory.project_scoped_pending),
        duplicatePending: numeric(memory.duplicate_pending),
        ...(memory.oldest_pending_at === null ? {} : { oldestPendingAt: numeric(memory.oldest_pending_at) }),
        recalled: numeric(memory.recalled),
        validated: numeric(memory.validated),
        feedback: {
          recalled: numeric(memory.feedback_recalled),
          helpful: numeric(memory.feedback_helpful),
          unhelpful: numeric(memory.feedback_unhelpful),
          superseded: numeric(memory.feedback_superseded),
        },
        candidateSources: candidateSourcesResult.rows.map((row) => ({
          source: row.source,
          proposed: numeric(row.proposed),
          accepted: numeric(row.accepted),
          rejected: numeric(row.rejected),
        })),
      },
      trajectories: {
        tasks: numeric(trajectory.tasks),
        runs: numeric(trajectory.runs),
        successful: numeric(trajectory.successful),
        failed: numeric(trajectory.failed),
        unknown: numeric(trajectory.unknown),
        reviewed: numeric(trajectory.reviewed),
        tasksWithDecisions: numeric(trajectory.tasks_with_decisions),
        tasksWithOutcomes: numeric(trajectory.tasks_with_outcomes),
        nodes: numeric(trajectory.nodes),
        decisionNodes: numeric(trajectory.decision_nodes),
        mappedSteps: numeric(trajectory.mapped_steps),
        totalSteps: numeric(trajectory.total_steps),
      },
    };
  }

  async workspaceMemories(
    input: PostgresTenantInput,
    access: FoldSdkAccessContext,
  ): Promise<readonly PersonalMemory[]> {
    await this.open();
    const tenant = tenantScope(input);
    if (access.workspaceId !== tenant.workspaceId) throw new TypeError("memory access workspace mismatch");
    const parameters: unknown[] = [
      tenant.organizationId,
      tenant.workspaceId,
      access.platformDataAccess === true,
      access.principalId,
      Object.keys(access.spaceRoles),
    ];
    const result = await this.tenantQuery<EpistemicProjectionRow>(tenant, `
      SELECT sequence, event_id, kind, event #> '{changes,0,after}' AS payload
      FROM ${this.table("fold_events")}
      WHERE organization_id = $1 AND workspace_id = $2 AND status = 'canon'
        AND kind IN ('memory.recorded', 'memory.revised', 'memory.forgotten')
        AND ($3::boolean OR (
          (event #>> '{capture,scope,creator}' IS NULL OR event #>> '{capture,scope,creator}' = $4)
          AND (event #>> '{capture,scope,space}' IS NULL OR event #>> '{capture,scope,space}' = ANY($5::text[]))
        ))
      ORDER BY sequence
    `, parameters);
    const memories = new Map<string, PersonalMemory>();
    for (const row of result.rows) {
      const payload = row.payload as Record<string, unknown>;
      if (row.kind === "memory.recorded") {
        const memory = payload.memory as unknown as PersonalMemory;
        memories.set(memory.id, memory);
      } else {
        const memoryId = String(payload.memoryId);
        const current = memories.get(memoryId);
        if (current === undefined) continue;
        if (row.kind === "memory.forgotten") {
          memories.delete(memoryId);
        } else {
          memories.set(memoryId, {
            ...current,
            ...(payload.patch as Partial<PersonalMemory>),
            updatedAt: Number(payload.atMs),
            revision: current.revision + 1,
          });
        }
      }
    }
    return [...memories.values()];
  }

  async workspaceMemoryCandidates(
    input: PostgresTenantInput,
    access: FoldSdkAccessContext,
  ): Promise<readonly MemoryCandidateView[]> {
    await this.open();
    const tenant = tenantScope(input);
    if (access.workspaceId !== tenant.workspaceId) throw new TypeError("candidate access workspace mismatch");
    const parameters: unknown[] = [
      tenant.organizationId,
      tenant.workspaceId,
      access.platformDataAccess === true,
      access.principalId,
      Object.keys(access.spaceRoles),
    ];
    const result = await this.tenantQuery<EpistemicProjectionRow>(tenant, `
      SELECT sequence, event_id, kind, event #> '{changes,0,after}' AS payload
      FROM ${this.table("fold_events")}
      WHERE organization_id = $1 AND workspace_id = $2 AND status = 'canon'
        AND kind IN ('memory.candidate-proposed', 'memory.candidate-accepted', 'memory.candidate-rejected', 'memory.candidate-evidence-added')
        AND ($3::boolean OR (
          (event #>> '{capture,scope,creator}' IS NULL OR event #>> '{capture,scope,creator}' = $4)
          AND (event #>> '{capture,scope,space}' IS NULL OR event #>> '{capture,scope,space}' = ANY($5::text[]))
        ))
      ORDER BY sequence
    `, parameters);
    const candidates = new Map<string, MemoryCandidateView["candidate"]>();
    const decisions = new Map<string, MemoryCandidateDecision>();
    for (const row of result.rows) {
      const payload = row.payload as Record<string, unknown>;
      if (row.kind === "memory.candidate-proposed") {
        const candidate = payload.candidate as unknown as MemoryCandidateView["candidate"];
        candidates.set(candidate.id, candidate);
        continue;
      }
      if (row.kind === "memory.candidate-evidence-added") {
        const candidate = candidates.get(String(payload.candidateId));
        if (candidate !== undefined && !decisions.has(candidate.id) &&
          candidate.workspaceId === payload.workspaceId && candidate.spaceId === payload.spaceId &&
          candidate.audience === payload.audience && candidate.proposalEventId === payload.proposalEventId &&
          (candidate.audience !== "personal" || candidate.proposerId === payload.actorId)) {
          candidates.set(candidate.id, { ...candidate,
            evidence: mergeMemoryCandidateEvidence(candidate.evidence, payload.evidence as MemoryCandidateView["candidate"]["evidence"]),
            supportEventIds: [...(candidate.supportEventIds ?? []), row.event_id] });
        }
        continue;
      }
      const kind = payload.recordType as "accepted" | "rejected";
      const candidateId = String(payload.candidateId);
      const base = {
        kind,
        candidateId,
        actorId: String(payload.actorId),
        atMs: Number(payload.atMs),
        eventId: row.event_id,
      } as const;
      decisions.set(candidateId, kind === "accepted"
        ? { ...base, kind, memoryId: String(payload.memoryId) }
        : { ...base, kind, reason: String(payload.reason) });
    }
    return [...candidates.values()].map((candidate) => {
      const decision = decisions.get(candidate.id);
      return {
        candidate,
        status: decision?.kind ?? "proposed",
        ...(decision === undefined ? {} : { decision }),
      };
    });
  }

  async workspaceTrajectoryTasks(
    input: PostgresTenantInput,
    access: FoldSdkAccessContext,
    options: {
      readonly limit: number;
      readonly before?: { readonly lastRecordedAt: number; readonly taskId: string };
    },
  ): Promise<{
    readonly tasks: readonly PostgresTrajectoryTaskSummary[];
    readonly total: number;
    readonly nextCursor?: { readonly lastRecordedAt: number; readonly taskId: string };
  }> {
    await this.open();
    const tenant = tenantScope(input);
    if (access.workspaceId !== tenant.workspaceId) throw new TypeError("trajectory access workspace mismatch");
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 1_000) {
      throw new TypeError("trajectory page limit must be an integer within [1, 1000]");
    }
    const parameters: unknown[] = [tenant.organizationId, tenant.workspaceId];
    const accessConditions: string[] = [];
    if (access.platformDataAccess !== true) {
      parameters.push(access.principalId, Object.keys(access.spaceRoles));
      accessConditions.push(`
        (event #>> '{capture,scope,creator}' IS NULL OR event #>> '{capture,scope,creator}' = $3)
        AND (event #>> '{capture,scope,space}' IS NULL OR event #>> '{capture,scope,space}' = ANY($4::text[]))
      `);
    }
    const visible = `
      organization_id = $1 AND workspace_id = $2 AND status = 'canon'
      ${accessConditions.length === 0 ? "" : `AND (${accessConditions.join(" AND ")})`}
    `;
    const accessParameterCount = parameters.length;
    const cursorConditions: string[] = [];
    if (options.before !== undefined) {
      parameters.push(options.before.lastRecordedAt, options.before.taskId);
      cursorConditions.push(`(
        last_recorded_at < $${parameters.length - 1}
        OR (last_recorded_at = $${parameters.length - 1} AND task_id > $${parameters.length})
      )`);
    }
    parameters.push(options.limit + 1);
    const result = await this.tenantQuery<TrajectoryTaskSummaryRow>(tenant, `
      WITH tree_events AS MATERIALIZED (
        SELECT
          sequence,
          event #>> '{changes,0,after,tree,taskId}' AS task_id,
          t AS recorded_at
        FROM ${this.table("fold_events")}
        WHERE ${visible} AND kind = 'trajectory.tree-recorded'
      ), trees AS (
        SELECT DISTINCT ON (task_id) task_id, recorded_at
        FROM tree_events
        ORDER BY task_id, sequence DESC
      ), outcome_reviews AS MATERIALIZED (
        SELECT DISTINCT ON (event #>> '{changes,0,after,trajectoryId}')
          event #>> '{changes,0,after,trajectoryId}' AS trajectory_id,
          event #>> '{changes,0,after,outcome}' AS outcome,
          t AS recorded_at
        FROM ${this.table("fold_events")} WHERE ${visible} AND kind = 'trajectory.outcome-recorded'
        ORDER BY event #>> '{changes,0,after,trajectoryId}', sequence DESC
      ), run_events AS MATERIALIZED (
        SELECT
          event #>> '{changes,0,after,trajectory,taskId}' AS task_id,
          COALESCE(outcome_reviews.outcome, event #>> '{changes,0,after,trajectory,outcome}') AS outcome,
          GREATEST(t, COALESCE(outcome_reviews.recorded_at, 0)) AS recorded_at
        FROM ${this.table("fold_events")}
        LEFT JOIN outcome_reviews ON outcome_reviews.trajectory_id = event #>> '{changes,0,after,trajectory,id}'
        WHERE ${visible} AND kind = 'trajectory.recorded'
      ), runs AS (
        SELECT
          task_id,
          count(*) AS trajectory_count,
          count(*) FILTER (WHERE outcome = 'success') AS success_count,
          count(*) FILTER (WHERE outcome = 'failure') AS failure_count,
          count(*) FILTER (WHERE outcome = 'unknown') AS unknown_count,
          max(recorded_at) AS last_recorded_at
        FROM run_events
        GROUP BY 1
      )
      , summaries AS (
        SELECT
        trees.task_id,
        COALESCE(runs.trajectory_count, 0) AS trajectory_count,
        COALESCE(runs.success_count, 0) AS success_count,
        COALESCE(runs.failure_count, 0) AS failure_count,
        COALESCE(runs.unknown_count, 0) AS unknown_count,
        GREATEST(
          trees.recorded_at,
          COALESCE(runs.last_recorded_at, 0)
        ) AS last_recorded_at
      FROM trees
      LEFT JOIN runs ON runs.task_id = trees.task_id
      )
      SELECT * FROM summaries
      ${cursorConditions.length === 0 ? "" : `WHERE ${cursorConditions.join(" AND ")}`}
      ORDER BY last_recorded_at DESC, task_id
      LIMIT $${parameters.length}
    `, parameters);
    const hasMore = result.rows.length > options.limit;
    const rows = result.rows.slice(0, options.limit);
    const tasks = rows.map((row) => ({
      taskId: row.task_id,
      trajectoryCount: numeric(row.trajectory_count),
      successCount: numeric(row.success_count),
      failureCount: numeric(row.failure_count),
      unknownCount: numeric(row.unknown_count),
      lastRecordedAt: numeric(row.last_recorded_at),
    }));
    const countParameters = parameters.slice(0, accessParameterCount);
    const count = await this.tenantQuery<{ readonly total: string }>(tenant, `
      SELECT count(DISTINCT event #>> '{changes,0,after,tree,taskId}') AS total
      FROM ${this.table("fold_events")}
      WHERE ${visible} AND kind = 'trajectory.tree-recorded'
    `, countParameters);
    const last = tasks.at(-1);
    return {
      tasks,
      total: numeric(count.rows[0]?.total),
      ...(hasMore && last !== undefined
        ? { nextCursor: { lastRecordedAt: last.lastRecordedAt, taskId: last.taskId } }
        : {}),
    };
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

  /** Ingestion-order page; the ingestion cursor shares the v2 delivery sequence. */
  async readIngestionPage(
    input: PostgresTenantInput,
    options: { readonly after?: FoldIngestionCursor; readonly includeDrafts?: boolean; readonly kinds?: readonly string[]; readonly limit?: number } = {},
  ): Promise<{ readonly items: readonly { readonly entry: FoldLogEntry; readonly cursor: FoldIngestionCursor }[]; readonly scannedThrough?: FoldIngestionCursor }> {
    const page = await this.readEventPage(input, {
      after: { version: 2, sequence: options.after === undefined ? "0" : ingestionSequence(options.after) },
      ...(options.includeDrafts === undefined ? {} : { includeDrafts: options.includeDrafts }),
      ...(options.kinds === undefined ? {} : { kinds: options.kinds }),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    });
    const items = page.entries.map((entry, index) => ({ entry, cursor: { kind: "ingestion" as const, sequence: page.cursors[index]!.sequence } }));
    return { items, ...(items.at(-1) === undefined ? {} : { scannedThrough: items.at(-1)!.cursor }) };
  }

  async latestIngestionCursor(input: PostgresTenantInput, options: { readonly access?: FoldSdkAccessContext; readonly kinds?: readonly string[]; readonly includeDrafts?: boolean } = {}): Promise<FoldIngestionCursor> {
    await this.open();
    const tenant = tenantScope(input);
    const parameters: unknown[] = [tenant.organizationId, tenant.workspaceId];
    const conditions = ["organization_id = $1", "workspace_id = $2"];
    if (!options.includeDrafts) conditions.push("status = 'canon'");
    if (options.access !== undefined) {
      if (options.access.organizationId !== tenant.organizationId || options.access.workspaceId !== tenant.workspaceId) throw new TypeError("ingestion access tenant mismatch");
      if (options.access.platformDataAccess !== true) {
        parameters.push(options.access.principalId, Object.keys(options.access.spaceRoles));
        conditions.push(`(event #>> '{capture,scope,creator}' IS NULL OR event #>> '{capture,scope,creator}' = $${parameters.length - 1})
          AND (event #>> '{capture,scope,space}' IS NULL OR event #>> '{capture,scope,space}' = ANY($${parameters.length}::text[]))`);
      }
    }
    if (options.kinds !== undefined && options.kinds.length > 0) {
      parameters.push([...options.kinds]); conditions.push(`kind = ANY($${parameters.length}::text[])`);
    }
    const result = await this.tenantQuery<{ sequence: string }>(tenant, `
      SELECT COALESCE(MAX(sequence), 0)::text AS sequence FROM ${this.table("fold_events")}
      WHERE ${conditions.join(" AND ")}
    `, parameters);
    return { kind: "ingestion", sequence: result.rows[0]!.sequence };
  }

  /**
   * Consumer progress lives in the v2 delivery offset. A legacy event-time row without a
   * sequence requires an explicit replay-from-origin migration before it reports progress.
   */
  async ingestionConsumerStatus(input: PostgresTenantInput, consumerId: string, options: { readonly access?: FoldSdkAccessContext; readonly kinds?: readonly string[]; readonly includeDrafts?: boolean } = {}): Promise<{
    readonly cursor: FoldIngestionCursor | null; readonly legacyCursor: FoldSdkCursor | null; readonly migrationRequired: boolean; readonly headCursor: FoldIngestionCursor;
  }> {
    await this.open();
    const tenant = tenantScope(input);
    const result = await this.tenantQuery<CursorRow & { readonly cursor_sequence: string | null }>(tenant, `
      SELECT cursor_t, cursor_event_id, cursor_sequence::text AS cursor_sequence FROM ${this.table("fold_consumer_offsets")}
      WHERE organization_id = $1 AND workspace_id = $2 AND consumer_id = $3
    `, [tenant.organizationId, tenant.workspaceId, consumerId]);
    const row = result.rows[0];
    const legacy = row !== undefined && row.cursor_sequence === null;
    // v2-only rows carry a placeholder event-time position; a real legacy offset is retained for audit.
    const legacyCursor = row !== undefined && row.cursor_event_id !== "" ? { t: Number(row.cursor_t), eventId: row.cursor_event_id } : null;
    return {
      cursor: row === undefined || legacy ? null : { kind: "ingestion", sequence: String(row.cursor_sequence) },
      legacyCursor,
      migrationRequired: legacy,
      headCursor: await this.latestIngestionCursor(tenant, options),
    };
  }

  async migrateConsumerCursor(input: PostgresTenantInput, consumerId: string): Promise<void> {
    if (consumerId.trim().length === 0) throw new TypeError("consumerId must not be empty");
    await this.open();
    const tenant = tenantScope(input);
    // Replay starts at zero; timestamp-to-sequence conversion would lose late historical data.
    // A repeated migration cannot rewind a consumer that has already made ingestion progress.
    await this.tenantQuery(tenant, `
      INSERT INTO ${this.table("fold_consumer_offsets")}
        (organization_id, workspace_id, consumer_id, cursor_t, cursor_event_id, cursor_sequence)
      VALUES ($1, $2, $3, 0, '', 0)
      ON CONFLICT (organization_id, workspace_id, consumer_id) DO UPDATE SET cursor_sequence = 0, updated_at = clock_timestamp()
      WHERE ${this.table("fold_consumer_offsets")}.cursor_sequence IS NULL
    `, [tenant.organizationId, tenant.workspaceId, consumerId]);
  }

  async resetConsumerCursor(input: PostgresTenantInput, consumerId: string, actorId: string, expectedCursor: FoldIngestionCursor, reason: string): Promise<void> {
    if (!consumerId.trim() || !actorId.trim()) throw new TypeError("consumer and actor IDs must not be empty");
    const expected = ingestionSequence(expectedCursor);
    const justification = reason.trim();
    if (justification.length < 10 || justification.length > 2000) throw new TypeError("cursor reset reason must contain 10 to 2000 characters");
    await this.open();
    const tenant = tenantScope(input);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock_shared(hashtext('fold-schema-v1'))");
      await this.setTenant(client, tenant);
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`fold:${tenantCacheKey(tenant)}`]);
      const current = await client.query<{ sequence: string | null }>(`
        SELECT cursor_sequence::text AS sequence FROM ${this.table("fold_consumer_offsets")}
        WHERE organization_id=$1 AND workspace_id=$2 AND consumer_id=$3 FOR UPDATE
      `, [tenant.organizationId, tenant.workspaceId, consumerId]);
      if (current.rows[0]?.sequence !== expected) throw new PostgresFoldConflictError("consumer cursor changed; preview again before resetting");
      await client.query(`INSERT INTO ${this.table("fold_ingestion_cursor_resets")}
        (organization_id,workspace_id,consumer_id,actor_id,previous_sequence,next_sequence,reason)
        VALUES ($1,$2,$3,$4,$5::bigint,0,$6)
      `, [tenant.organizationId, tenant.workspaceId, consumerId, actorId, expected, justification]);
      await client.query(`UPDATE ${this.table("fold_consumer_offsets")} SET cursor_sequence=0,updated_at=clock_timestamp()
        WHERE organization_id=$1 AND workspace_id=$2 AND consumer_id=$3
      `, [tenant.organizationId, tenant.workspaceId, consumerId]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
    finally { client.release(); }
  }

  async commitIngestionCursor(input: PostgresTenantInput, consumerId: string, cursor: FoldIngestionCursor): Promise<void> {
    if (consumerId.trim().length === 0) throw new TypeError("consumerId must not be empty");
    const sequence = ingestionSequence(cursor);
    const status = await this.ingestionConsumerStatus(input, consumerId);
    if (status.migrationRequired) throw new PostgresFoldConflictError("ingestion cursor migration required: explicitly replay-all before committing");
    await this.commitConsumerCursor(input, consumerId, { version: 2, sequence });
  }

  async eventById(input: PostgresTenantInput, eventId: string): Promise<FoldLogEntry | undefined> {
    await this.open();
    const tenant = tenantScope(input);
    const result = await this.tenantQuery<EventRow>(tenant, `
      SELECT event, status FROM ${this.table("fold_events")}
      WHERE organization_id = $1 AND workspace_id = $2 AND event_id = $3 AND status = 'canon'
    `, [tenant.organizationId, tenant.workspaceId, eventId]);
    const row = result.rows[0];
    return row === undefined ? undefined : { event: row.event as FoldLogEntry["event"], status: row.status };
  }

  async readVisibleEventPage(
    input: PostgresTenantInput,
    access: FoldSdkAccessContext,
    options: PostgresVisibleEventPageOptions,
  ): Promise<PostgresVisibleEventPage> {
    await this.open();
    const tenant = tenantScope(input);
    if (access.workspaceId !== tenant.workspaceId) throw new TypeError("event page access workspace mismatch");
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 1_000) {
      throw new TypeError("visible event page limit must be an integer within [1, 1000]");
    }
    const parameters: unknown[] = [tenant.organizationId, tenant.workspaceId];
    const conditions = ["organization_id = $1", "workspace_id = $2"];
    if (!options.includeDrafts) conditions.push("status = 'canon'");
    if (access.platformDataAccess !== true) {
      parameters.push(access.principalId, Object.keys(access.spaceRoles));
      conditions.push(`
        (event #>> '{capture,scope,creator}' IS NULL OR event #>> '{capture,scope,creator}' = $${parameters.length - 1})
        AND (event #>> '{capture,scope,space}' IS NULL OR event #>> '{capture,scope,space}' = ANY($${parameters.length}::text[]))
      `);
    }
    if ((options.kinds?.length ?? 0) > 0) {
      parameters.push([...options.kinds!]);
      conditions.push(`kind = ANY($${parameters.length}::text[])`);
    }
    for (const [key, value] of Object.entries(options.identity ?? {})) {
      parameters.push(value);
      conditions.push(`event #>> '{capture,identity,${key}}' = $${parameters.length}`);
    }
    const baseParameters = [...parameters];
    const where = conditions.join(" AND ");
    const countPromise = this.tenantQuery<{ readonly total: string }>(tenant, `
      SELECT count(*) AS total FROM ${this.table("fold_events")} WHERE ${where}
    `, baseParameters);
    if (options.before !== undefined) {
      parameters.push(options.before.t, options.before.eventId);
      conditions.push(`(t < $${parameters.length - 1} OR (t = $${parameters.length - 1} AND event_id > $${parameters.length}))`);
    }
    parameters.push(options.limit + 1);
    const pagePromise = this.tenantQuery<EventPageRow>(tenant, `
      SELECT event, status, t, event_id
      FROM ${this.table("fold_events")}
      WHERE ${conditions.join(" AND ")}
      ORDER BY t DESC, event_id ASC
      LIMIT $${parameters.length}
    `, parameters);
    const [countResult, pageResult] = await Promise.all([countPromise, pagePromise]);
    const hasMore = pageResult.rows.length > options.limit;
    const rows = pageResult.rows.slice(0, options.limit);
    const last = rows.at(-1);
    return {
      entries: rows.map(({ event, status }) => ({ event: event as FoldLogEntry["event"], status })),
      total: numeric(countResult.rows[0]?.total),
      ...(hasMore && last !== undefined ? { nextCursor: { t: Number(last.t), eventId: last.event_id } } : {}),
    };
  }

  async latestEventCursor(
    input: PostgresTenantInput,
    options: {
      readonly includeDrafts?: boolean;
      readonly kinds?: readonly string[];
      readonly access?: FoldSdkAccessContext;
    } = {},
  ): Promise<FoldSdkCursor | undefined> {
    await this.open();
    const tenant = tenantScope(input);
    const parameters: unknown[] = [tenant.organizationId, tenant.workspaceId];
    const conditions = ["organization_id = $1", "workspace_id = $2"];
    if (!options.includeDrafts) conditions.push("status = 'canon'");
    if ((options.kinds?.length ?? 0) > 0) {
      parameters.push([...options.kinds!]);
      conditions.push(`kind = ANY($${parameters.length}::text[])`);
    }
    if (options.access !== undefined && options.access.platformDataAccess !== true) {
      parameters.push(options.access.principalId, Object.keys(options.access.spaceRoles));
      conditions.push(`
        (event #>> '{capture,scope,creator}' IS NULL OR event #>> '{capture,scope,creator}' = $${parameters.length - 1})
        AND (event #>> '{capture,scope,space}' IS NULL OR event #>> '{capture,scope,space}' = ANY($${parameters.length}::text[]))
      `);
    }
    const result = await this.tenantQuery<{ readonly t: number | string; readonly event_id: string }>(tenant, `
      SELECT t, event_id
      FROM ${this.table("fold_events")}
      WHERE ${conditions.join(" AND ")}
      ORDER BY t DESC, event_id DESC
      LIMIT 1
    `, parameters);
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

  async commitEntries(input: PostgresTenantInput, entries: readonly FoldLogEntry[], options: FoldCommitOptions, selection?: PostgresEventSelection): Promise<FoldCommandReceipt> {
    await this.open();
    const tenant = tenantScope(input);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Runtime transactions share the schema gate before taking table/tenant locks.
      // Initializers hold it exclusively, preventing DDL/bootstrap lock inversions.
      await client.query("SELECT pg_advisory_xact_lock_shared(hashtext('fold-schema-v1'))");
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
      // A selected store's snapshot revision is the head of its selection; CAS compares the same head.
      const revisionParameters: unknown[] = [tenant.organizationId, tenant.workspaceId];
      const revisionFilter = selection === undefined ? "" : this.selectionSql(selection, revisionParameters);
      const revisionQuery = `SELECT COALESCE(MAX(sequence), 0) AS revision FROM ${this.table("fold_events")}
        WHERE organization_id = $1 AND workspace_id = $2${revisionFilter}`;
      const current = await client.query<{ revision: string }>(revisionQuery, revisionParameters);
      if (String(current.rows[0]!.revision) !== options.expectedRevision) {
        throw new PostgresFoldRevisionConflictError("workspace changed during command validation; retry with a fresh snapshot");
      }
      for (const entry of entries) await this.insertEntry(client, tenant, entry);
      const committed = await client.query<{ revision: string }>(revisionQuery, revisionParameters);
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

  private async validateCandidateTransition(client: PoolClient, tenant: PostgresTenantScope, entry: FoldLogEntry): Promise<void> {
    if (entry.status !== "canon" || !["memory.candidate-evidence-added", "memory.candidate-evidence-contributed", "memory.candidate-accepted", "memory.candidate-rejected"].includes(entry.event.kind)) return;
    const change = entry.event.changes[0];
    const candidateId = change?.verb === "create" ? (entry.event.kind === "memory.candidate-evidence-contributed" ? change.after.targetId : change.after.candidateId) : undefined;
    if (typeof candidateId !== "string") throw new PostgresFoldConflictError("candidate transition requires a candidate id");
    // The tenant append lock makes support/decision validation atomic across API processes.
    const rows = await client.query<EventRow>(`
      SELECT event, status FROM ${this.table("fold_events")}
      WHERE organization_id=$1 AND workspace_id=$2 AND status='canon'
        AND ((kind='memory.candidate-proposed' AND event #>> '{changes,0,after,candidate,id}'=$3)
          OR (kind IN ('memory.candidate-evidence-added','memory.candidate-accepted','memory.candidate-rejected')
            AND event #>> '{changes,0,after,candidateId}'=$3)
          OR (kind='memory.candidate-evidence-contributed' AND event #>> '{changes,0,after,targetId}'=$3))
      ORDER BY t,event_id
    `, [tenant.organizationId, tenant.workspaceId, candidateId]);
    const events = rows.rows.map((row) => row.event as FoldLogEntry["event"]);
    const projection = rebuildMemoryCandidates(events);
    const candidate = projection.candidates.get(candidateId);
    if (candidate === undefined || projection.decisions.has(candidateId) ||
      events.some((event) => compareEventKeys(event, entry.event) >= 0)) {
      throw new PostgresFoldConflictError("candidate changed or was decided; refresh before adding support or deciding");
    }
    if (entry.event.kind === "memory.candidate-evidence-added" && change?.verb === "create") {
      const evidence = change.after.evidence as unknown as MemoryCandidateView["candidate"]["evidence"];
      if (!Array.isArray(evidence) || evidence.length < 1 || evidence.length > 1000) throw new PostgresFoldConflictError("candidate support evidence is invalid");
      const sourceRows = await client.query<EventRow>(`
        SELECT event,status FROM ${this.table("fold_events")}
        WHERE organization_id=$1 AND workspace_id=$2 AND status='canon' AND event_id=ANY($3::text[])
      `, [tenant.organizationId, tenant.workspaceId, [...new Set(evidence.map((item) => item.eventId))]]);
      const sources = new Map(sourceRows.rows.map((row) => { const event = row.event as FoldLogEntry["event"]; return [event.id, event] as const; }));
      const identities = candidate.projectIds.length === 0 ? [] : (await client.query<EventRow>(`
        SELECT event,status FROM ${this.table("fold_events")}
        WHERE organization_id=$1 AND workspace_id=$2 AND status='canon' AND kind IN ('identity.revised','transcript.project-recorded')
          AND event #>> '{capture,scope,creator}' IS NULL AND event #>> '{capture,scope,space}' IS NULL
      `, [tenant.organizationId, tenant.workspaceId])).rows.map((row) => row.event as FoldLogEntry["event"]);
      const projectIds = resolveProjectIds(rebuildIdentities(identities), candidate.projectIds);
      const knownProjectIds = [...rebuildTranscriptCatalog(identities.filter((event) => event.kind === "transcript.project-recorded")).projects.keys()];
      for (const reference of evidence) {
        const source = sources.get(reference.eventId);
        if (source === undefined || !candidateSupportSourceMatches(candidate, reference, source, projectIds, knownProjectIds)) {
          throw new PostgresFoldConflictError("candidate support source is unavailable or incompatible with publication scope");
        }
      }
    }
    try { rebuildMemoryCandidates([...events, entry.event]); }
    catch { throw new PostgresFoldConflictError("candidate transition is stale or invalid; refresh before retrying"); }
  }

  private async insertEntry(client: PoolClient, tenant: PostgresTenantScope, entry: FoldLogEntry): Promise<void> {
    const episode = episodeWindowFromEvent(entry.event);
    if (episode !== undefined) {
      if (entry.status !== "canon") throw new PostgresFoldConflictError("Episode windows must be canonical");
      // The shared validator runs inside the tenant append lock, making every
      // episode CAS and its canonical evidence check atomic across API instances.
      const context = await client.query<EventRow>(`SELECT event,status FROM ${this.table("fold_events")}
        WHERE organization_id=$1 AND workspace_id=$2 AND status='canon'
          AND (kind IN ('work.episode-window-recorded','transcript.project-recorded','transcript.run-imported','memory.recorded','memory.revised','memory.forgotten'))
        ORDER BY t,event_id`, [tenant.organizationId, tenant.workspaceId]);
      const entries = context.rows.map(row => ({ event: row.event as FoldLogEntry["event"], status: row.status }));
      const access = { organizationId: tenant.organizationId, workspaceId: tenant.workspaceId, principalId: episode.actorId, workspaceRole: "member" as const,
        spaceRoles: episode.input.spaceId === undefined ? {} : { [episode.input.spaceId]: "writer" as const } };
      const service = new EpisodeService(async () => entries, async id => {
        const result = await client.query<EventRow>(`SELECT event,status FROM ${this.table("fold_events")} WHERE organization_id=$1 AND workspace_id=$2 AND event_id=$3`, [tenant.organizationId, tenant.workspaceId, id]);
        const row = result.rows[0]; return row === undefined ? undefined : { event: row.event as FoldLogEntry["event"], status: row.status };
      }, async () => undefined, access);
      try {
        const validated = await service.publish(entry.event.author, episode.input);
        if (validated.revision !== entry.event.id) throw new Error("Episode digest mismatch");
      } catch (error) { throw new PostgresFoldConflictError(error instanceof Error ? error.message : "Invalid episode transition"); }
    }
    await this.validateCandidateTransition(client, tenant, entry);
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
      // Runtime transactions share the schema gate before taking table/tenant locks.
      // Initializers hold it exclusively, preventing DDL/bootstrap lock inversions.
      await client.query("SELECT pg_advisory_xact_lock_shared(hashtext('fold-schema-v1'))");
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
      // Runtime transactions share the schema gate before taking table/tenant locks.
      // Initializers hold it exclusively, preventing DDL/bootstrap lock inversions.
      await client.query("SELECT pg_advisory_xact_lock_shared(hashtext('fold-schema-v1'))");
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

  async readProjectionCheckpoint(input: PostgresTenantInput, key: FoldSdkProjectionCheckpointKey): Promise<FoldSdkProjectionCheckpoint | undefined> {
    await this.open(); const tenant = tenantScope(input);
    const result = await this.tenantQuery<QueryResultRow & { cursor_t: number; cursor_event_id: string; state: unknown; ingestion_sequence: string }>(tenant, `
      SELECT cursor_t, cursor_event_id, state, ingestion_sequence FROM ${this.table("fold_projection_checkpoints")}
      WHERE organization_id=$1 AND workspace_id=$2 AND projection=$3 AND format_version=2
        AND state_version=$4 AND source_revision=$5 AND access_digest=$6 AND configuration_digest=$7
        AND ingestion_sequence=(SELECT COALESCE(MAX(sequence),0) FROM ${this.table("fold_events")} WHERE organization_id=$1 AND workspace_id=$2)
        AND ingestion_sequence::text=source_revision
    `, [tenant.organizationId, tenant.workspaceId, key.projection, key.stateVersion, key.sourceRevision, key.accessDigest, key.configurationDigest]);
    const row = result.rows[0];
    return row === undefined ? undefined : { ...key, formatVersion: 2, ingestionSequence: String(row.ingestion_sequence), through: { t: Number(row.cursor_t), eventId: row.cursor_event_id }, state: row.state };
  }

  async writeProjectionCheckpoint(input: PostgresTenantInput, checkpoint: FoldSdkProjectionCheckpoint): Promise<boolean> {
    const state = JSON.stringify(checkpoint.state);
    if (checkpoint.formatVersion !== 2 || !/^(0|[1-9][0-9]*)$/.test(checkpoint.ingestionSequence) || checkpoint.sourceRevision !== checkpoint.ingestionSequence || Buffer.byteLength(state) > 8 * 1024 * 1024 || checkpoint.projection.length > 300) return false;
    await this.open(); const tenant = tenantScope(input), client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock_shared(hashtext('fold-schema-v1'))"); await this.setTenant(client, tenant);
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`fold:${tenantCacheKey(tenant)}`]);
      const head = await client.query<{ revision: string }>(`SELECT COALESCE(MAX(sequence),0)::text AS revision FROM ${this.table("fold_events")} WHERE organization_id=$1 AND workspace_id=$2`, [tenant.organizationId, tenant.workspaceId]);
      if (head.rows[0]?.revision !== checkpoint.sourceRevision) { await client.query("ROLLBACK"); return false; }
      await client.query(`INSERT INTO ${this.table("fold_projection_checkpoints")}
        (organization_id,workspace_id,projection,cursor_t,cursor_event_id,state,configuration_digest,format_version,state_version,source_revision,ingestion_sequence,access_digest)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,2,$8,$9,$10::bigint,$11)
        ON CONFLICT (organization_id,workspace_id,projection) DO UPDATE SET cursor_t=EXCLUDED.cursor_t,cursor_event_id=EXCLUDED.cursor_event_id,
          state=EXCLUDED.state,configuration_digest=EXCLUDED.configuration_digest,format_version=2,state_version=EXCLUDED.state_version,
          source_revision=EXCLUDED.source_revision,ingestion_sequence=EXCLUDED.ingestion_sequence,access_digest=EXCLUDED.access_digest,updated_at=clock_timestamp()
      `, [tenant.organizationId,tenant.workspaceId,checkpoint.projection,checkpoint.through.t,checkpoint.through.eventId,state,checkpoint.configurationDigest,checkpoint.stateVersion,checkpoint.sourceRevision,checkpoint.ingestionSequence,checkpoint.accessDigest]);
      await client.query(`DELETE FROM ${this.table("fold_projection_checkpoints")} WHERE organization_id=$1 AND workspace_id=$2 AND format_version=2 AND projection IN
        (SELECT projection FROM ${this.table("fold_projection_checkpoints")} WHERE organization_id=$1 AND workspace_id=$2 AND format_version=2 ORDER BY updated_at DESC,projection LIMIT ALL OFFSET 16)`, [tenant.organizationId,tenant.workspaceId]);
      await client.query("COMMIT"); return true;
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
    finally { client.release(); }
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
  readonly immutableSnapshots = true;
  readProjectionCheckpoint(key: FoldSdkProjectionCheckpointKey): Promise<FoldSdkProjectionCheckpoint | undefined> { return this.database.readProjectionCheckpoint(this.tenant, key); }
  writeProjectionCheckpoint(checkpoint: FoldSdkProjectionCheckpoint): Promise<boolean> { return this.database.writeProjectionCheckpoint(this.tenant, checkpoint); }
  // Raw rows come from JSON decoding and our append-only snapshot cache never mutates them.
  readonly immutableEventReferences = true;
  constructor(
    private readonly database: PostgresFoldDatabase,
    readonly tenant: PostgresTenantScope,
    private readonly selection?: PostgresEventSelection,
  ) {}

  async read(): Promise<{ readonly entries: readonly FoldLogEntry[]; readonly revision: string }> {
    return this.database.readSnapshot(this.tenant, this.selection);
  }

  eventById(eventId: string): Promise<FoldLogEntry | undefined> {
    return this.database.eventById(this.tenant, eventId);
  }

  systemProjection(access: FoldSdkAccessContext, include: "canon" | "canon+draft"): Promise<FoldSdkSystemProjection> {
    if (this.selection !== undefined) throw new TypeError("system projection requires an unfiltered workspace store");
    return this.database.systemProjection(this.tenant, access, include);
  }

  append(entry: FoldLogEntry): Promise<void> {
    return this.database.appendEntries(this.tenant, [entry]);
  }

  appendMany(entries: readonly FoldLogEntry[]): Promise<void> {
    return this.database.appendEntries(this.tenant, entries);
  }

  commit(entries: readonly FoldLogEntry[], options: FoldCommitOptions): Promise<FoldCommandReceipt> {
    return this.database.commitEntries(this.tenant, entries, options, this.selection);
  }

  commandReceipt(commandId: string): Promise<FoldCommandReceipt | undefined> {
    return this.database.commandReceipt(this.tenant, commandId);
  }

  async appendValidated(entry: FoldLogEntry): Promise<"appended" | "unchanged"> {
    return await this.database.importEntries(this.tenant, [entry]) === 0 ? "unchanged" : "appended";
  }

  appendManyValidated(entries: readonly FoldLogEntry[]): Promise<void> {
    return this.database.appendEntries(this.tenant, entries);
  }

  revision(): Promise<string> {
    return this.database.workspaceRevision(this.tenant, this.selection);
  }
}
