import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { parseEvent, type FoldEvent } from "@_89/fold";
import { postgresIdentifier, PostgresSchemaError } from "./schema.js";

export interface RecoveryBarrierReceipt {
  readonly version: 1;
  readonly barrierId: string;
  readonly observedAt: string;
  readonly schema: string;
  readonly snapshotId: string;
  readonly maxIngestionPosition: string;
}

export interface RecoveryEventPagesOptions {
  readonly connectionString: string;
  readonly schema: string;
  readonly snapshotId: string;
  readonly signal?: AbortSignal;
}

/** Only call while withRecoveryBarrier retains the exported snapshot. This
 * reader intentionally takes no writer gate: its keeper already owns it. */
export async function readRecoveryEventPages(options: RecoveryEventPagesOptions,
  onPage: (events: readonly FoldEvent[]) => Promise<void>): Promise<{ readonly events: number }> {
  options.signal?.throwIfAborted();
  if (!/^[0-9a-f]+-[0-9a-f]+-[0-9]+$/i.test(options.snapshotId)) throw new TypeError("Invalid exported snapshot identifier");
  const schema = postgresIdentifier(options.schema);
  const client = new Client({ connectionString: options.connectionString, connectionTimeoutMillis: 5_000, statement_timeout: 5_000, query_timeout: 6_000 });
  const abort = () => { void client.end().catch(() => undefined); };
  client.on("error", () => undefined);
  options.signal?.addEventListener("abort", abort, { once: true });
  let events = 0;
  try {
    await client.connect();
    options.signal?.throwIfAborted();
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query(`SET TRANSACTION SNAPSHOT '${options.snapshotId}'`);
    const role = await client.query<{ allowed: boolean }>("SELECT rolbypassrls AND NOT rolsuper AND NOT rolcreaterole AND NOT rolcreatedb AS allowed FROM pg_roles WHERE rolname=current_user");
    if (role.rows[0]?.allowed !== true) throw new PostgresSchemaError("Recovery event reads require the dedicated read role");
    let after = "0";
    for (;;) {
      options.signal?.throwIfAborted();
      const descriptors = await client.query<{ sequence: string; bytes: number }>(`SELECT sequence::text, octet_length(event::text) AS bytes FROM ${schema}.fold_events WHERE sequence>$1::bigint ORDER BY sequence LIMIT 100`, [after]);
      if (descriptors.rows.length === 0) break;
      let bytes = 0; let through = after;
      for (const row of descriptors.rows) {
        if (row.bytes > 2 * 1_048_576) throw new Error("Recovery canonical event exceeds the supported size bound");
        if (bytes + row.bytes > 8 * 1_048_576) break;
        bytes += row.bytes; through = row.sequence;
      }
      const page = await client.query<{ event: unknown }>(`SELECT event FROM ${schema}.fold_events WHERE sequence>$1::bigint AND sequence<=$2::bigint ORDER BY sequence LIMIT 100`, [after, through]);
      await onPage(page.rows.map((row) => parseEvent(row.event)));
      options.signal?.throwIfAborted();
      events += page.rows.length; after = through;
    }
    await client.query("ROLLBACK");
    return { events };
  } finally { options.signal?.removeEventListener("abort", abort); await client.end().catch(() => undefined); }
}

export interface RecoveryBarrierOptions {
  readonly connectionString: string;
  readonly schema?: string;
  readonly signal?: AbortSignal;
  readonly acquireTimeoutMs?: number;
  readonly workTimeoutMs?: number;
}

function timeout(value: number | undefined, fallback: number, maximum: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw new TypeError("Recovery timeout is outside its supported range");
  return result;
}

/** Seal private writers before entering. pg_dump must import receipt.snapshotId.
 * The callback must honor its signal and finish child-process/file cleanup before
 * settling; an elapsed deadline never releases the writer gate underneath it. */
export async function withRecoveryBarrier<T>(
  options: RecoveryBarrierOptions,
  work: (receipt: RecoveryBarrierReceipt, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  options.signal?.throwIfAborted();
  const schema = options.schema ?? "public";
  const quoted = postgresIdentifier(schema);
  const acquireTimeoutMs = timeout(options.acquireTimeoutMs, 10_000, 60_000);
  const workTimeoutMs = timeout(options.workTimeoutMs, 120_000, 3_600_000);
  const client = new Client({ connectionString: options.connectionString,
    connectionTimeoutMillis: Math.min(acquireTimeoutMs, 5_000),
    statement_timeout: acquireTimeoutMs, query_timeout: acquireTimeoutMs + 1_000 });
  const controller = new AbortController();
  let locked = false;
  let inTransaction = false;
  let workStarted = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abort = () => {
    controller.abort(options.signal?.reason ?? new Error("Recovery was cancelled"));
    // Before callback dispatch it is safe to tear down a waiting connection.
    // During work the snapshot must stay alive until the callback has cleaned up.
    if (!workStarted) void client.end().catch(() => undefined);
  };
  const connectionLost = () => controller.abort(new Error("Recovery database connection was lost"));
  client.on("error", connectionLost);
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    await client.connect();
    controller.signal.throwIfAborted();
    const role = await client.query<{ allowed: boolean }>(`SELECT rolbypassrls AND NOT rolsuper AND NOT rolcreaterole AND NOT rolcreatedb AS allowed FROM pg_roles WHERE rolname = current_user`);
    if (role.rows[0]?.allowed !== true) throw new PostgresSchemaError("Recovery requires a dedicated nonadministrative BYPASSRLS read role");
    const relations = await client.query<{ allowed: boolean; count: string }>(`SELECT count(*)::text AS count, bool_and(
      has_table_privilege(current_user, c.oid, 'SELECT')
      AND NOT has_table_privilege(current_user, c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES, SELECT WITH GRANT OPTION')
      AND NOT pg_has_role(current_user, c.relowner, 'MEMBER')) AS allowed
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind = 'r'`, [schema]);
    if (relations.rows[0]?.allowed !== true || Number(relations.rows[0]?.count) < 1) throw new PostgresSchemaError("Recovery requires SELECT-only access to every table in the selected schema");
    // Session lock first: RR fixes its snapshot at its first query, before any
    // advisory-lock wait. Taking an xact lock inside RR could miss the writer
    // that just committed while we waited for the lock.
    await client.query("SELECT pg_advisory_lock(hashtext('fold-schema-v1'))");
    locked = true;
    controller.signal.throwIfAborted();
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    inTransaction = true;
    const snapshot = await client.query<{ snapshot_id: string; observed_at: string; maximum: string }>(`SELECT pg_export_snapshot() AS snapshot_id,
      clock_timestamp()::text AS observed_at, COALESCE((SELECT max(sequence) FROM ${quoted}.fold_events), 0)::text AS maximum`);
    const row = snapshot.rows[0]!;
    const receipt: RecoveryBarrierReceipt = { version: 1, barrierId: randomUUID(), schema,
      observedAt: new Date(row.observed_at).toISOString(), snapshotId: row.snapshot_id, maxIngestionPosition: row.maximum };
    workStarted = true;
    timer = setTimeout(() => controller.abort(new Error("Recovery work deadline exceeded")), workTimeoutMs);
    const result = await work(receipt, controller.signal);
    controller.signal.throwIfAborted();
    return result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    if (inTransaction) await client.query("ROLLBACK").catch(() => undefined);
    if (locked) await client.query("SELECT pg_advisory_unlock(hashtext('fold-schema-v1'))").catch(() => undefined);
    // A dedicated connection is always destroyed, including ambiguous unlocks.
    await client.end().catch(() => undefined);
  }
}
