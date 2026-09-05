import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { decryptVaultLine, encryptVaultLine, ensureVaultKey } from "@_89/super-brain-importer";
import { SuperBrainApiError, type AuthorizedReadSubject, type TelemetryBatch, type TelemetryOutbox, type TelemetryOutboxStatus } from "@_89/super-brain-client";

const id = z.string().min(1).max(500);
const stamp = z.object({ id, t: z.number().int().nonnegative(), worldDate: z.string().regex(/^\d{4,6}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2})?$/) });
const subject = z.object({ organizationId: id, workspaceId: id, principalId: id });
const ranking = z.object({ id, kind: z.enum(["lexical", "semantic", "explicit"]), configRevision: id.optional() });
// Deliberately omit free text, queries, credentials and any unknown caller fields.
const batchSchema = z.object({ version: z.literal(1), subject, stamp, items: z.array(z.object({ stamp, memoryId: id, input: z.object({
  version: z.literal(2), memoryRevision: z.number().int().nonnegative(), recallId: id,
  signal: z.enum(["offered", "injected", "used", "judged", "outcome"]), judgment: z.enum(["helpful", "unhelpful", "superseded"]).optional(),
  rank: z.number().int().min(1).optional(), ranking: ranking.optional(), provider: z.object({ id, configRevision: id.optional() }).optional(),
  taskId: id.optional(), attemptId: id.optional(), sessionId: id.optional(), outcomeEventId: id.optional(),
}) })).min(1).max(100) });
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const namespace = (value: AuthorizedReadSubject) => hash([value.organizationId, value.workspaceId, value.principalId]);
type Row = { id: string; namespace: string; payload: string; attempts: number; state: string; lease: string | null };

export interface NodeTelemetryOutboxOptions {
  readonly directory: string;
  readonly identity: (signal: AbortSignal) => Promise<AuthorizedReadSubject>;
  /** Dispatch must include batch.subject as the API's expectedSubject guard. */
  readonly send: (batch: TelemetryBatch, signal: AbortSignal) => Promise<unknown>;
  readonly maxBatches?: number;
  readonly maxAttempts?: number;
  readonly retryBaseMs?: number;
  readonly requestTimeoutMs?: number;
  readonly now?: () => number;
}

/** Encrypted durable batches; SQLite claims allow multiple MCP processes to share one outbox. */
export class NodeTelemetryOutbox implements TelemetryOutbox {
  private database: DatabaseSync | undefined;
  private opening: Promise<DatabaseSync> | undefined;
  private key: Uint8Array | undefined;
  private unavailable: string | undefined;
  private closing = false;
  private flushing: Promise<void> | undefined;
  private readonly operations = new Set<Promise<unknown>>();
  private readonly requests = new Set<AbortController>();
  private readonly now: () => number;
  constructor(private readonly options: NodeTelemetryOutboxOptions) {
    this.now = options.now ?? Date.now;
    if (!Number.isInteger(options.maxBatches ?? 1000) || (options.maxBatches ?? 1000) < 1 || (options.maxBatches ?? 1000) > 1_000) throw new TypeError("outbox batch bound must be 1..1000");
    if (!Number.isInteger(options.maxAttempts ?? 5) || (options.maxAttempts ?? 5) < 1 || (options.maxAttempts ?? 5) > 10) throw new TypeError("outbox attempt bound must be 1..10");
    if (!Number.isInteger(options.requestTimeoutMs ?? 5_000) || (options.requestTimeoutMs ?? 5_000) < 1 || (options.requestTimeoutMs ?? 5_000) > 10_000) throw new TypeError("outbox request deadline must be 1..10000ms");
  }
  private open(): Promise<DatabaseSync> {
    if (this.closing) return Promise.reject(new Error("outbox-closed"));
    if (this.opening === undefined) this.opening = (async () => {
      await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
      if (!(await lstat(this.options.directory)).isDirectory()) throw new Error("outbox-directory-invalid");
      await chmod(this.options.directory, 0o700);
      this.key = (await ensureVaultKey(join(this.options.directory, "outbox.key"))).key;
      if (this.closing) throw new Error("outbox-closed");
      const path = join(this.options.directory, "outbox.sqlite");
      const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
      if (existing !== undefined && !existing.isFile()) throw new Error("outbox-database-invalid");
      const db = new DatabaseSync(path);
      try {
        db.exec("PRAGMA busy_timeout=50; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS batches (id TEXT PRIMARY KEY, namespace TEXT NOT NULL, digest TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, lease TEXT, lease_until INTEGER NOT NULL DEFAULT 0); CREATE INDEX IF NOT EXISTS batches_due ON batches(namespace,state,next_at);");
        await chmod(path, 0o600);
        if (this.closing) throw new Error("outbox-closed");
        this.database = db;
        return db;
      } catch (error) { db.close(); throw error; }
    })().catch((error) => { this.opening = undefined; this.unavailable = "storage-unavailable"; throw error; });
    return this.opening;
  }
  private track<T>(work: Promise<T>): Promise<T> {
    this.operations.add(work);
    void work.finally(() => this.operations.delete(work)).catch(() => undefined);
    return work;
  }
  enqueue(input: TelemetryBatch): Promise<void> {
    if (this.closing) return Promise.reject(new Error("outbox-closed"));
    return this.track(this.persist(input));
  }
  private async persist(input: TelemetryBatch): Promise<void> {
    // Even a warm SQLite connection runs after the successful read's delivery turn.
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      // Schema allowlists the payload; JSON removes Zod's explicit optional undefined values.
      const batch = JSON.parse(JSON.stringify(batchSchema.parse(input))) as TelemetryBatch;
      const serialized = JSON.stringify(batch);
      if (Buffer.byteLength(serialized) > 128 * 1024) throw new Error("outbox-batch-too-large");
      const db = await this.open();
      const key = hash([namespace(batch.subject), batch.stamp.id]); const digest = hash(batch);
      db.exec("BEGIN IMMEDIATE");
      try {
        const previous = db.prepare("SELECT digest FROM batches WHERE id=?").get(key);
        if (previous !== undefined) { if (previous.digest !== digest) throw new Error("outbox-command-conflict"); }
        else {
          const stored = db.prepare("SELECT count(*) AS count,coalesce(sum(length(payload)),0) AS bytes FROM batches").get()!;
          const encrypted = encryptVaultLine(serialized, this.key!);
          if (Number(stored.count) >= (this.options.maxBatches ?? 1000) || Number(stored.bytes) + Buffer.byteLength(encrypted) > 8 * 1024 * 1024) throw new Error("outbox-full");
          db.prepare("INSERT INTO batches(id,namespace,digest,payload,state,next_at) VALUES (?,?,?,?,?,?)").run(key, namespace(batch.subject), digest, encrypted, "pending", this.now());
        }
        db.exec("COMMIT"); this.unavailable = undefined;
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    } catch (error) { this.unavailable = error instanceof Error && error.message === "outbox-full" ? "queue-full" : "storage-unavailable"; throw error; }
  }
  status(): Promise<TelemetryOutboxStatus> { return this.track(this.readStatus()); }
  private async readStatus(): Promise<TelemetryOutboxStatus> {
    const counts = { pending: 0, retry: 0, denied: 0, exhausted: 0 };
    try {
      const db = await this.open();
      // Report only the current subject, never another account's activity counts.
      const current = namespace(subject.parse(await this.request((signal) => this.options.identity(signal))));
      for (const row of db.prepare("SELECT state,count(*) AS count FROM batches WHERE namespace=? GROUP BY state").all(current)) {
        if (row.state === "pending" || row.state === "retry" || row.state === "denied" || row.state === "exhausted") counts[row.state] = Number(row.count);
      }
    } catch { this.unavailable ??= "status-unavailable"; }
    return { ...counts, observedAt: new Date(this.now()).toISOString(), ...(this.unavailable === undefined ? {} : { unavailable: this.unavailable }) };
  }
  flush(options: { readonly signal?: AbortSignal; readonly maxBatches?: number } = {}): Promise<void> {
    if (!Number.isInteger(options.maxBatches ?? 10) || (options.maxBatches ?? 10) < 0 || (options.maxBatches ?? 10) > 100) return Promise.reject(new TypeError("flush batch bound must be 0..100"));
    if (this.flushing === undefined) this.flushing = this.drain(options).finally(() => { this.flushing = undefined; });
    return this.flushing;
  }
  private async request<T>(operation: (signal: AbortSignal) => Promise<T>, outer?: AbortSignal): Promise<T> {
    const controller = new AbortController(); this.requests.add(controller);
    const abort = () => controller.abort(outer?.reason ?? new Error("outbox-aborted"));
    outer?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("outbox-deadline")), this.options.requestTimeoutMs ?? 5_000);
    let rejectAbort: (() => void) | undefined;
    try {
      if (this.closing || outer?.aborted) abort();
      const cancellation = new Promise<never>((_resolve, reject) => {
        rejectAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener("abort", rejectAbort, { once: true });
        if (controller.signal.aborted) rejectAbort();
      });
      return await Promise.race([operation(controller.signal), cancellation]);
    } finally {
      clearTimeout(timer); outer?.removeEventListener("abort", abort);
      if (rejectAbort !== undefined) controller.signal.removeEventListener("abort", rejectAbort);
      this.requests.delete(controller);
    }
  }
  private async drain(options: { readonly signal?: AbortSignal; readonly maxBatches?: number }): Promise<void> {
    const limit = Math.min(100, Math.max(0, options.maxBatches ?? 10));
    for (let index = 0; index < limit && !this.closing && !options.signal?.aborted; index++) {
      const db = await this.open();
      let current: AuthorizedReadSubject;
      try { current = subject.parse(await this.request((signal) => this.options.identity(signal), options.signal)); }
      catch { this.unavailable = "identity-unavailable"; return; }
      if (this.closing || options.signal?.aborted) return;
      const lease = randomUUID();
      // Eligibility and the returned attempt/state snapshot are one atomic statement.
      // A competing failed/terminal transition cannot be reclaimed from a stale SELECT.
      const row = db.prepare("UPDATE batches SET lease=?,lease_until=? WHERE id=(SELECT id FROM batches WHERE namespace=? AND state IN ('pending','retry') AND next_at<=? AND lease_until<=? ORDER BY next_at,id LIMIT 1) RETURNING *").get(lease, this.now() + 30_000, namespace(current), this.now(), this.now()) as Row | undefined;
      if (row === undefined) return;
      try {
        const encrypted = JSON.parse(row.payload) as { $superBrainEncrypted?: unknown };
        if (encrypted.$superBrainEncrypted !== 1) throw new Error("outbox-integrity");
        const batch = JSON.parse(JSON.stringify(batchSchema.parse(JSON.parse(decryptVaultLine(row.payload, this.key!))))) as TelemetryBatch;
        if (namespace(batch.subject) !== namespace(current) || hash([namespace(batch.subject), batch.stamp.id]) !== row.id) throw new Error("outbox-integrity");
        await this.request((signal) => this.options.send(batch, signal), options.signal);
        db.prepare("DELETE FROM batches WHERE id=? AND lease=?").run(row.id, lease);
      } catch (error) {
        const changedSubject = error instanceof SuperBrainApiError && error.code === "feedback_subject_changed";
        const tokenUnavailable = error instanceof SuperBrainApiError && error.code === "token_unavailable";
        const aborted = this.closing || options.signal?.aborted === true || (error instanceof SuperBrainApiError && error.code === "aborted");
        const denied = error instanceof SuperBrainApiError && [401,403,404].includes(error.status);
        const permanent = error instanceof SuperBrainApiError && !error.retryable && !changedSubject && !tokenUnavailable && !aborted && !denied;
        const attempts = row.attempts + (aborted || tokenUnavailable || changedSubject ? 0 : 1);
        const state = aborted ? row.state : denied ? "denied" : permanent || attempts >= (this.options.maxAttempts ?? 5) || (error instanceof Error && error.message === "outbox-integrity") ? "exhausted" : "retry";
        const retryAfter = error instanceof SuperBrainApiError ? error.retryAfterMs ?? 0 : 0;
        const delay = Math.min(300_000, Math.max(retryAfter, (this.options.retryBaseMs ?? 1_000) * 2 ** Math.min(attempts, 8)));
        db.prepare("UPDATE batches SET state=?,attempts=?,next_at=?,lease=NULL,lease_until=0 WHERE id=? AND lease=?").run(state, attempts, this.now() + delay, row.id, lease);
      }
    }
  }
  retryTerminal(): Promise<number> { return this.track(this.retryFailed()); }
  private async retryFailed(): Promise<number> {
    const db = await this.open(); const current = subject.parse(await this.request((signal) => this.options.identity(signal)));
    return Number(db.prepare("UPDATE batches SET state='pending',attempts=0,next_at=?,lease=NULL,lease_until=0 WHERE namespace=? AND state IN ('denied','exhausted')").run(this.now(), namespace(current)).changes);
  }
  discardTerminal(): Promise<number> { return this.track(this.discardFailed()); }
  private async discardFailed(): Promise<number> {
    const db = await this.open(); const current = subject.parse(await this.request((signal) => this.options.identity(signal)));
    const removed = Number(db.prepare("DELETE FROM batches WHERE namespace=? AND state IN ('denied','exhausted')").run(namespace(current)).changes);
    if (removed > 0) this.unavailable = undefined;
    return removed;
  }
  async close(): Promise<void> {
    this.closing = true;
    for (const request of this.requests) request.abort(new Error("outbox-closed"));
    await Promise.allSettled([...this.operations, this.flushing, this.opening]);
    this.database?.close(); this.database = undefined;
  }
}
