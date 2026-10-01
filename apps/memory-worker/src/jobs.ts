import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import { derivationHash } from "@_89/fold-transcript";
import { decryptVaultLine, encryptVaultLine, ensureVaultKey, withPrivateRootWrite } from "@_89/super-brain-importer";
import { RULE_EXTRACTOR } from "./extractor.js";

/** `blocked` jobs stay active and preserved but are never drained until an operator explicitly retries them. */
export type WorkerJobState = "pending" | "waiting" | "retry" | "blocked" | "completed" | "excluded" | "exhausted";
/** Raised before a new job is admitted when the active ledger is full; transport progress must not advance. */
export class ProcessingBackpressureError extends Error {}
export interface WorkerJob {
  readonly version: 1;
  readonly id: string;
  readonly kind: "extract-run" | "extract-turn" | "propose" | "verify-trajectory" | "cognition-plan" | "synthesis" | "episode";
  readonly state: WorkerJobState;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly attempts: number;
  readonly nextAttemptAt: number;
  readonly payload: unknown;
  readonly reason?: string;
}
export interface ProcessingCoverage {
  readonly pending: number;
  readonly waiting: number;
  readonly retry: number;
  readonly blocked: number;
  readonly completed: number;
  readonly excluded: number;
  readonly exhausted: number;
  readonly oldestPendingAt?: number;
  readonly byKind: Readonly<Record<WorkerJob["kind"], number>>;
}

/** Canonical digest of source evidence, independent of object key order (scheduler windows, sources). */
export function processingDigest(value: unknown): string {
  return derivationHash(value);
}

export function jobDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item)).digest("hex");
}

/** One worker ledger (and lease) per principal, extractor and publication scope. */
export function workerJobNamespace(identity: { readonly organizationId?: string; readonly workspaceId: string; readonly principalId: string },
  scope: { readonly audience?: "personal" | "workspace"; readonly spaceId?: string } = {}): string {
  return JSON.stringify([identity.organizationId ?? "local", identity.workspaceId, identity.principalId,
    RULE_EXTRACTOR, scope.audience ?? "workspace", scope.spaceId ?? ""]);
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function privateDirectory(path: string): Promise<void> {
  const created = await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
  if (created !== undefined) {
    let current = path;
    while (true) {
      await syncDirectory(current);
      if (current === dirname(created)) break;
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
}

/** A single local worker owns each credential/tenant namespace. Sensitive jobs are encrypted. */
export class DurableWorkerJobs {
  private key: Uint8Array | undefined;
  private readonly token = randomUUID();
  readonly directory: string;
  private opened = false;
  private opening: Promise<void> | undefined;
  private queue: Promise<void> = Promise.resolve();

  constructor(readonly root: string, readonly namespace: string, private readonly maxActiveJobs = 10_000) {
    if (!Number.isSafeInteger(maxActiveJobs) || maxActiveJobs < 1 || maxActiveJobs > 10_000) throw new TypeError("Active job capacity must be within [1, 10000]");
    this.directory = join(root, jobDigest(namespace));
  }

  open(): Promise<void> {
    if (this.opening === undefined) this.opening = withPrivateRootWrite(this.root,"worker-jobs",()=>this.initialize()).catch((error) => { this.opening = undefined; throw error; });
    return this.opening;
  }

  private async initialize(): Promise<void> {
    await privateDirectory(this.directory);
    const leasePath = join(this.directory, "lease.json");
    for (let attempt = 0; ; attempt += 1) {
      try {
        const handle = await open(leasePath, "wx", 0o600);
        try { await handle.writeFile(JSON.stringify({ pid: process.pid, token: this.token, privateWriterProtocol: 1 })); await handle.sync(); }
        finally { await handle.close(); }
        await syncDirectory(this.directory);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt > 1) throw error;
        const existing = JSON.parse(await readFile(leasePath, "utf8")) as { pid?: number; token?: string };
        if (!Number.isInteger(existing.pid) || existing.pid! < 1 || !existing.token) throw new Error("Worker lease is invalid; inspect the state directory");
        try { process.kill(existing.pid!, 0); throw new Error("Another worker owns this processing namespace"); }
        catch (probe) {
          if ((probe as NodeJS.ErrnoException).code !== "ESRCH") throw probe;
        }
        // Serialize stale takeover. A second reclaimer must never unlink a new
        // owner's lease between inspecting the old token and creating its own.
        const recoveryPath = `${leasePath}.recovery`;
        const recovery = await open(recoveryPath, "wx", 0o600);
        try {
          await recovery.writeFile(JSON.stringify({ pid: process.pid, token: this.token, privateWriterProtocol: 1 }));
          await recovery.sync();
          const current = JSON.parse(await readFile(leasePath, "utf8")) as { pid?: number; token?: string };
          if (current.token !== existing.token) throw new Error("Another worker acquired the processing namespace");
          try { process.kill(current.pid!, 0); throw new Error("Another worker owns this processing namespace"); }
          catch (probe) { if ((probe as NodeJS.ErrnoException).code !== "ESRCH") throw probe; }
          await unlink(leasePath);
        } finally { await recovery.close(); await unlink(recoveryPath); }
      }
    }
    this.opened = true;
    try {
      this.key = (await ensureVaultKey(join(this.directory, "jobs.key"))).key;
      await privateDirectory(join(this.directory, "active"));
      await privateDirectory(join(this.directory, "completed"));
      await privateDirectory(join(this.directory, "excluded"));
      await privateDirectory(join(this.directory, "exhausted"));
      await privateDirectory(join(this.directory, "scheduler"));
    } catch (error) { await this.close(); throw error; }
  }

  private path(id: string, state: WorkerJobState): string {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new TypeError("Invalid worker job identity");
    return join(this.directory, state === "completed" || state === "excluded" || state === "exhausted" ? state : "active", `${id}.enc`);
  }

  async get(id: string): Promise<WorkerJob | undefined> {
    if (!this.opened || this.key === undefined) throw new Error("Worker job store is not open");
    // Terminal publication precedes active deletion; prefer terminal state after a crash.
    for (const state of ["completed", "excluded", "exhausted", "pending"] as const) {
      try {
        const job = JSON.parse(decryptVaultLine(await readFile(this.path(id, state), "utf8"), this.key)) as WorkerJob;
        if (job.version !== 1 || job.id !== id) throw new Error("Invalid worker job record");
        return job;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    return undefined;
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = () => withPrivateRootWrite(this.root,"worker-jobs",operation);
    const result = this.queue.then(run, run);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  put(job: WorkerJob): Promise<void> { return this.serialize(() => this.putInternal(job)); }

  private async putInternal(job: WorkerJob): Promise<void> {
    if (!this.opened || this.key === undefined) throw new Error("Worker job store is not open");
    const path = this.path(job.id, job.state);
    const current = await this.get(job.id);
    if (current?.state === "completed" || current?.state === "excluded" || current?.state === "exhausted") return;
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(encryptVaultLine(JSON.stringify(job), this.key)); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temporary, path);
      await syncDirectory(dirname(path));
      if (job.state === "completed" || job.state === "excluded" || job.state === "exhausted") {
        await unlink(this.path(job.id, "pending")).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
        await syncDirectory(join(this.directory, "active"));
      }
    } finally { await unlink(temporary).catch(() => undefined); }
  }

  /** The stable job id for a source identity; enqueue of the same identity is idempotent. */
  identify(kind: WorkerJob["kind"], identity: unknown): string { return jobDigest([this.namespace, kind, identity]); }

  async enqueue(kind: WorkerJob["kind"], identity: unknown, payload: unknown, now = Date.now()): Promise<WorkerJob> {
    return this.serialize(async () => {
    const id = this.identify(kind, identity);
    const existing = await this.get(id);
    if (existing !== undefined) return existing;
    const active = (await readdir(join(this.directory, "active"))).filter((name) => /^[a-f0-9]{64}\.enc$/.test(name)).length;
    if (active >= this.maxActiveJobs) throw new ProcessingBackpressureError(`Memory processing backlog reached ${this.maxActiveJobs} jobs; transport progress has not advanced`);
    const job: WorkerJob = { version: 1, id, kind, state: "pending", createdAt: now, updatedAt: now, attempts: 0, nextAttemptAt: now, payload };
    await this.putInternal(job);
    return job;
    });
  }

  async active(): Promise<WorkerJob[]> {
    const files = await readdir(join(this.directory, "active"));
    const jobs: WorkerJob[] = [];
    for (const file of files.sort()) {
      if (!/^[a-f0-9]{64}\.enc$/.test(file)) continue;
      const job = await this.get(file.slice(0, -4));
      if (job !== undefined && job.state !== "completed" && job.state !== "excluded" && job.state !== "exhausted") jobs.push(job);
    }
    return jobs.sort((a, b) => a.nextAttemptAt - b.nextAttemptAt || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  async coverage(): Promise<ProcessingCoverage> {
    const jobs = await this.active();
    const byKind = { "extract-run": 0, "extract-turn": 0, propose: 0, "verify-trajectory": 0, "cognition-plan": 0, synthesis: 0, episode: 0 };
    for (const job of jobs) byKind[job.kind] += 1;
    const count = async (state: "completed" | "excluded" | "exhausted") => (await readdir(join(this.directory, state))).filter((name) => /^[a-f0-9]{64}\.enc$/.test(name)).length;
    return {
      pending: jobs.filter(({ state }) => state === "pending").length,
      waiting: jobs.filter(({ state }) => state === "waiting").length,
      retry: jobs.filter(({ state }) => state === "retry").length,
      blocked: jobs.filter(({ state }) => state === "blocked").length,
      completed: await count("completed"), excluded: await count("excluded"), exhausted: await count("exhausted"), byKind,
      ...(jobs.length === 0 ? {} : { oldestPendingAt: Math.min(...jobs.map(({ createdAt }) => createdAt)) }),
    };
  }

  /** Explicit operator recovery: blocked, waiting and retrying work becomes immediately runnable again. */
  retryBlocked(now = Date.now()): Promise<number> {
    return this.serialize(async () => {
      let count = 0;
      for (const job of await this.active()) {
        if (job.state !== "blocked" && job.state !== "waiting" && job.state !== "retry") continue;
        const { reason: _reason, ...rest } = job;
        await this.putInternal({ ...rest, state: "pending", attempts: 0, nextAttemptAt: now, updatedAt: now });
        count++;
      }
      return count;
    });
  }

  private schedulerPath(id: string): string {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new TypeError("Invalid scheduler identity");
    return join(this.directory, "scheduler", `${id}.enc`);
  }

  /** Durable window-scheduler checkpoints share the ledger's lease and encryption key. */
  async readSchedulerState(id: string): Promise<unknown | undefined> {
    if (!this.opened || this.key === undefined) throw new Error("Open the worker job store before reading scheduler state");
    try { return JSON.parse(decryptVaultLine(await readFile(this.schedulerPath(id), "utf8"), this.key)) as unknown; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }

  writeSchedulerState(id: string, state: unknown): Promise<void> {
    return this.serialize(async () => {
      if (!this.opened || this.key === undefined) throw new Error("Open the worker job store before saving scheduler state");
      const path = this.schedulerPath(id);
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        const handle = await open(temporary, "wx", 0o600);
        try { await handle.writeFile(encryptVaultLine(JSON.stringify(state), this.key)); await handle.sync(); }
        finally { await handle.close(); }
        await rename(temporary, path);
        await syncDirectory(dirname(path));
      } finally { await unlink(temporary).catch(() => undefined); }
    });
  }

  async schedulerStateIds(): Promise<string[]> {
    return (await readdir(join(this.directory, "scheduler"))).flatMap((name) => /^([a-f0-9]{64})\.enc$/.exec(name)?.[1] ?? []).sort();
  }

  async close(): Promise<void> {
    await this.queue;
    if (!this.opened) return;
    const path = join(this.directory, "lease.json");
    const owner = await readFile(path, "utf8").then((text) => JSON.parse(text) as { token?: string }).catch(() => undefined);
    await withPrivateRootWrite(this.root,"worker-jobs",async()=>{
      if (owner?.token === this.token) { await unlink(path); await syncDirectory(this.directory); }
      this.opened = false; this.opening = undefined;
    });
  }
}
