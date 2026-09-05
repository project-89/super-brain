import type { AuthorizedReadSubject, TelemetryBatch, TelemetryOutbox, TelemetryOutboxStatus } from "@_89/super-brain-client";

interface QueuedBatch {
  readonly id: string;
  readonly subjectKey: string;
  readonly batch: TelemetryBatch;
  readonly serialized: string;
  readonly state: "pending" | "retry" | "denied" | "exhausted";
  readonly attempts: number;
  readonly nextAt: number;
  readonly owner?: string;
  readonly leaseUntil?: number;
}

export interface BrowserOutboxOptions {
  readonly databaseName?: string;
  readonly indexedDB?: IDBFactory;
  readonly subject: () => Promise<AuthorizedReadSubject | undefined>;
  readonly deliver: (batch: TelemetryBatch, signal?: AbortSignal) => Promise<unknown>;
  readonly maxBatches?: number;
  readonly maxAttempts?: number;
  readonly now?: () => number;
}

function subjectKey(subject: AuthorizedReadSubject): string {
  return JSON.stringify([subject.organizationId, subject.workspaceId, subject.principalId]);
}
function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error ?? new Error("Browser storage request failed")); });
}
function complete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () => reject(transaction.error ?? new Error("Browser storage transaction failed"));
  });
}

/** A committed IndexedDB transaction is the durability acknowledgement. No tokens or query text are stored. */
export class BrowserTelemetryOutbox implements TelemetryOutbox {
  private database?: Promise<IDBDatabase>;
  private closed = false;
  private unavailable?: string;
  private enqueueFailure?: string;
  private readonly operations = new Set<Promise<unknown>>();
  private readonly closing = new AbortController();
  private flushing?: Promise<void>;
  private readonly owner = crypto.randomUUID();
  private readonly now: () => number;
  constructor(private readonly options: BrowserOutboxOptions) { this.now = options.now ?? Date.now; }

  private async open(): Promise<IDBDatabase> {
    if (this.closed) throw new Error("Feedback delivery is closed");
    this.database ??= new Promise((resolve, reject) => {
      const factory = this.options.indexedDB ?? globalThis.indexedDB;
      if (factory === undefined) { reject(new Error("Browser storage is unavailable")); return; }
      const opening = factory.open(this.options.databaseName ?? "super-brain.feedback.v1", 1);
      opening.onupgradeneeded = () => opening.result.createObjectStore("batches", { keyPath: "id" });
      opening.onerror = () => reject(opening.error ?? new Error("Browser storage is unavailable"));
      opening.onblocked = () => reject(new Error("Browser storage upgrade is blocked by another tab"));
      opening.onsuccess = () => { opening.result.onversionchange = () => opening.result.close(); resolve(opening.result); };
    });
    try { return await this.database; } catch (error) { this.database = undefined; throw error; }
  }

  private withStore<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => Promise<T>): Promise<T> {
    const operation = this.performStore(mode, action); this.operations.add(operation);
    void operation.then(() => this.operations.delete(operation), () => this.operations.delete(operation));
    return operation;
  }
  private async performStore<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => Promise<T>): Promise<T> {
    try {
      const database = await this.open();
      const transaction = database.transaction("batches", mode, { durability: "strict" });
      const done = complete(transaction);
      try {
        const result = await action(transaction.objectStore("batches"));
        await done;
        this.unavailable = undefined;
        return result;
      } catch (error) {
        try { transaction.abort(); } catch { /* A completed transaction cannot be aborted. */ }
        await done.catch(() => undefined);
        throw error;
      }
    } catch (error) {
      this.unavailable = error instanceof Error ? error.message : "Browser storage is unavailable";
      throw error;
    }
  }

  async enqueue(input: TelemetryBatch): Promise<void> {
    if (this.closing.signal.aborted) throw new Error("Feedback delivery is closed");
    // Only the bounded telemetry contract is persisted. Optional detail is deliberately omitted.
    const batch: TelemetryBatch = {
      version: 1, subject: { organizationId: input.subject.organizationId, workspaceId: input.subject.workspaceId, principalId: input.subject.principalId },
      stamp: { id: input.stamp.id, t: input.stamp.t, worldDate: input.stamp.worldDate },
      items: input.items.map(({ memoryId, stamp, input: value }) => ({
        memoryId, stamp: { id: stamp.id, t: stamp.t, worldDate: stamp.worldDate },
        input: {
          version: 2, memoryRevision: value.memoryRevision, recallId: value.recallId, signal: value.signal,
          ...(value.judgment === undefined ? {} : { judgment: value.judgment }),
          ...(value.rank === undefined ? {} : { rank: value.rank }),
          ...(value.ranking === undefined ? {} : { ranking: { id: value.ranking.id, kind: value.ranking.kind, ...(value.ranking.configRevision === undefined ? {} : { configRevision: value.ranking.configRevision }) } }),
          ...(value.provider === undefined ? {} : { provider: { id: value.provider.id, ...(value.provider.configRevision === undefined ? {} : { configRevision: value.provider.configRevision }) } }),
          ...(value.taskId === undefined ? {} : { taskId: value.taskId }),
          ...(value.attemptId === undefined ? {} : { attemptId: value.attemptId }),
          ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId }),
          ...(value.outcomeEventId === undefined ? {} : { outcomeEventId: value.outcomeEventId }),
        },
      })),
    };
    if (batch.items.length < 1 || batch.items.length > 100) throw new Error("Feedback batches must contain 1–100 signals");
    const serialized = JSON.stringify(batch);
    if (new TextEncoder().encode(serialized).byteLength > 128 * 1024) throw new Error("Feedback batch exceeds the browser storage limit");
    const partition = subjectKey(batch.subject);
    const id = `${partition}:${batch.stamp.id}`;
    try { await this.withStore("readwrite", async (store) => {
      const existing = await request(store.get(id)) as QueuedBatch | undefined;
      if (existing !== undefined) {
        if (existing.serialized !== serialized) throw new Error("A feedback batch ID was reused with different signals");
        return;
      }
      const queued = await request(store.getAll()) as QueuedBatch[];
      if (queued.length >= (this.options.maxBatches ?? 1_000) || queued.reduce((bytes, row) => bytes + new TextEncoder().encode(row.serialized).byteLength, 0) + new TextEncoder().encode(serialized).byteLength > 8 * 1024 * 1024) throw new Error("Feedback queue is full; pending signals need attention");
      await request(store.add({ id, subjectKey: partition, batch, serialized, state: "pending", attempts: 0, nextAt: 0 } satisfies QueuedBatch));
    }); } catch (error) { this.enqueueFailure = error instanceof Error ? error.message : "Feedback could not be stored"; throw error; }
  }

  async status(): Promise<TelemetryOutboxStatus> {
    const empty = { pending: 0, retry: 0, denied: 0, exhausted: 0, observedAt: new Date(this.now()).toISOString() };
    try {
      const subject = await this.options.subject();
      if (subject === undefined) return { ...empty, unavailable: "Sign in to see feedback delivery" };
      const rows = await this.withStore("readonly", async (store) => await request(store.getAll()) as QueuedBatch[]);
      const result = { ...empty };
      for (const row of rows) if (row.subjectKey === subjectKey(subject)) result[row.state] += 1;
      return this.enqueueFailure === undefined ? result : { ...result, unavailable: `Some feedback was not stored: ${this.enqueueFailure}` };
    } catch (error) { return { ...empty, unavailable: this.unavailable ?? (error instanceof Error ? error.message : "Feedback delivery is unavailable") }; }
  }

  flush(options: { readonly signal?: AbortSignal; readonly maxBatches?: number } = {}): Promise<void> {
    if (this.flushing !== undefined) return this.flushing;
    const signal = options.signal === undefined ? this.closing.signal : AbortSignal.any([options.signal, this.closing.signal]);
    this.flushing = this.drain({ ...options, signal }).finally(() => { this.flushing = undefined; });
    return this.flushing;
  }

  private async drain(options: { readonly signal?: AbortSignal; readonly maxBatches?: number }): Promise<void> {
    const maximum = Math.min(100, Math.max(1, options.maxBatches ?? 20));
    for (let index = 0; index < maximum && !this.closed && !options.signal?.aborted; index += 1) {
      const subject = await this.options.subject();
      if (subject === undefined) return;
      const partition = subjectKey(subject);
      const row = await this.withStore("readwrite", async (store) => {
        const rows = await request(store.getAll()) as QueuedBatch[];
        const next = rows.filter((item) => item.subjectKey === partition && (item.state === "pending" || item.state === "retry") && item.nextAt <= this.now() && (item.leaseUntil ?? 0) <= this.now()).sort((a, b) => a.batch.stamp.t - b.batch.stamp.t || a.id.localeCompare(b.id))[0];
        if (next === undefined) return undefined;
        const claimed = { ...next, owner: this.owner, leaseUntil: this.now() + 60_000 };
        await request(store.put(claimed));
        return claimed;
      });
      if (row === undefined) return;
      let failure: unknown; let delivered = false;
      try {
        // Delivery sends the persisted expectedSubject; the API rechecks the actual token subject atomically.
        await this.options.deliver(row.batch, options.signal); delivered = true;
      } catch (error) { failure = error; }
      await this.withStore("readwrite", async (store) => {
        const current = await request(store.get(row.id)) as QueuedBatch | undefined;
        if (current?.owner !== this.owner || current.leaseUntil !== row.leaseUntil) return;
        if (delivered) { await request(store.delete(row.id)); return; }
        const error = (failure ?? {}) as { status?: number; code?: string; retryAfterMs?: number; retryable?: boolean; terminal?: boolean };
        if (["feedback_subject_changed", "token_unavailable", "aborted"].includes(error.code ?? "") || options.signal?.aborted) {
          const { owner: _owner, leaseUntil: _lease, ...retained } = current;
          await request(store.put({ ...retained, nextAt: this.now() + 5_000 }));
          return;
        }
        const attempts = current.attempts + 1;
        const denied = [401, 403, 404].includes(error.status ?? 0);
        const terminal = error.terminal === true || error.retryable === false || (error.status !== undefined && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status));
        const delay = Math.min(300_000, Math.max(1_000 * 2 ** Math.min(attempts, 8), error.retryAfterMs ?? 0));
        const { owner: _owner, leaseUntil: _lease, ...retained } = current;
        await request(store.put({ ...retained, attempts, state: denied ? "denied" : terminal || attempts >= (this.options.maxAttempts ?? 8) ? "exhausted" : "retry", nextAt: this.now() + delay } satisfies QueuedBatch));
      });
      if (!delivered) return;
    }
  }

  /** Explicit operator actions repair the current partition without relabeling another account's batches. */
  async repair(action: "retry" | "clear"): Promise<number> {
    if (this.closing.signal.aborted) throw new Error("Feedback delivery is closed");
    let changed = 0;
    const subject = await this.options.subject(); if (subject === undefined) throw new Error("Sign in before changing feedback delivery");
    await this.withStore("readwrite", async (store) => {
      for (const row of await request(store.getAll()) as QueuedBatch[]) {
        if (row.subjectKey !== subjectKey(subject) || !["denied", "exhausted"].includes(row.state) || (row.leaseUntil ?? 0) > this.now()) continue;
        changed += 1;
        if (action === "clear") await request(store.delete(row.id));
        else await request(store.put({ ...row, state: "pending", attempts: 0, nextAt: 0 }));
      }
    });
    this.enqueueFailure = undefined;
    return changed;
  }
  retryTerminal(): Promise<number> { return this.repair("retry"); }
  discardTerminal(): Promise<number> { return this.repair("clear"); }

  async close(): Promise<void> {
    this.closing.abort();
    await this.flushing?.catch(() => undefined);
    this.closed = true;
    await Promise.allSettled([...this.operations]);
    const database = await this.database?.catch(() => undefined);
    database?.close();
  }
}
