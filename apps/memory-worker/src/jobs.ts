import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { derivationHash } from "@_89/fold-transcript";

export type JobStatus = "pending" | "waiting" | "retry" | "blocked" | "complete" | "excluded";
export class ProcessingBackpressureError extends Error {}
export interface ProcessingJob<T = unknown> {
  readonly version: 1;
  readonly id: string;
  readonly kind: "transcript" | "live" | "synthesis" | "episode";
  readonly input: T;
  readonly status: JobStatus;
  readonly attempts: number;
  readonly nextAttemptAt: number;
  readonly updatedAt: number;
  readonly reason?: string;
  readonly progress?: unknown;
  readonly configuration?: string;
  readonly triggerWindow?: unknown;
}

export function processingDigest(value: unknown): string {
  return derivationHash(value);
}

function validCounter(value: unknown): boolean { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }

function validateJob(value: unknown, name: string): ProcessingJob {
  if (value === null || typeof value !== "object") throw new Error("Invalid memory processing job");
  const job = value as ProcessingJob;
  if (job.version !== 1 || !/^[a-f0-9]{64}$/.test(job.id) || name !== `${job.id}.json` || !["transcript", "live", "synthesis", "episode"].includes(job.kind) ||
    !["pending", "waiting", "retry", "blocked", "complete", "excluded"].includes(job.status) ||
    !validCounter(job.attempts) || !validCounter(job.nextAttemptAt) || !validCounter(job.updatedAt) ||
    job.input === undefined || (job.reason !== undefined && typeof job.reason !== "string") ||
    (job.configuration !== undefined && !/^[a-f0-9]{64}$/.test(job.configuration))) {
    throw new Error("Invalid memory processing job; checkpoint recovery requires inspection");
  }
  return job;
}

function jobSummary(job: ProcessingJob) {
  const progress = job.progress as { cursor?: { message?: unknown; candidate?: unknown }; messages?: unknown; candidatesProcessed?: unknown; synthesis?: { identity?: unknown } } | undefined;
  return {
    id: job.id, kind: job.kind, status: job.status, attempts: job.attempts, nextAttemptAt: job.nextAttemptAt,
    ...(job.reason === undefined ? {} : { reason: job.reason }),
    ...(!validCounter(progress?.messages) ? {} : { messages: progress!.messages as number }),
    ...(!validCounter(progress?.candidatesProcessed) ? {} : { candidatesProcessed: progress!.candidatesProcessed as number }),
    ...(!validCounter(progress?.cursor?.message) || !validCounter(progress?.cursor?.candidate) ? {} : { cursor: { message: progress!.cursor!.message as number, candidate: progress!.cursor!.candidate as number } }),
    ...(typeof progress?.synthesis?.identity !== "string" || !/^[a-f0-9]{64}$/.test(progress.synthesis.identity) ? {} : { outputIdentity: progress.synthesis.identity }),
  };
}

export async function readProcessingCoverage(root: string) {
  const active = [];
  for (const name of await readdir(join(root, "active"))) {
    if (!name.endsWith(".json")) continue;
    try { active.push(jobSummary(validateJob(JSON.parse(await readFile(join(root, "active", name), "utf8")), name))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return { coverage: "local spool; non-atomic processing snapshot", active, completedReceipts: (await readdir(join(root, "completed"))).filter((name) => name.endsWith(".json")).length, excludedReceipts: (await readdir(join(root, "excluded"))).filter((name) => name.endsWith(".json")).length };
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function atomicJson(path: string, value: unknown, directory: string): Promise<void> {
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
  try { await rename(temporary, path); await syncDirectory(directory); }
  finally { await unlink(temporary).catch(() => undefined); }
}

/** Single-host spool: active jobs are indexed once; completed receipts are never scanned by ingestion. */
export class ProcessingJobStore {
  private readonly active = new Map<string, ProcessingJob>();
  private claim: string | undefined;
  constructor(readonly root: string, private readonly credentialFingerprint?: string, private readonly maxActiveJobs = 10_000) {
    if (!Number.isSafeInteger(maxActiveJobs) || maxActiveJobs < 1 || maxActiveJobs > 10_000) throw new TypeError("Active job capacity must be within [1, 10000]");
  }

  async open(): Promise<void> {
    if (this.claim !== undefined) throw new Error("Memory processing spool is already open");
    this.active.clear();
    for (const path of [this.root, join(this.root, "active"), join(this.root, "completed"), join(this.root, "excluded"), join(this.root, "claims")]) {
      await mkdir(path, { recursive: true, mode: 0o700 });
    }
    await syncDirectory(this.root);
    const claims = join(this.root, "claims");
    this.claim = join(claims, `${process.pid}-${randomUUID()}.json`);
    const handle = await open(this.claim, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify({ pid: process.pid })); await handle.sync(); } finally { await handle.close(); }
    try {
      // Unique claim names make dead-owner cleanup independent of another process's new claim.
      for (const name of await readdir(claims)) {
        const path = join(claims, name);
        if (path === this.claim) continue;
        const pid = Number(name.split("-", 1)[0]);
        if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Invalid memory processing lock; inspect the spool");
        let alive = true;
        try { process.kill(pid, 0); } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false;
        }
        if (alive) throw new Error("Memory processing spool is already in use");
        await unlink(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
      }
      const identityPath = join(this.root, "identity.json");
      if (this.credentialFingerprint !== undefined) {
        let identity: { credentialFingerprint: string } | undefined;
        try { identity = JSON.parse(await readFile(identityPath, "utf8")); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        if (identity !== undefined && identity.credentialFingerprint !== this.credentialFingerprint) {
          throw new Error("Memory processing credential changed; pending work is preserved. Verify the same principal and migrate identity.json before resuming");
        }
        if (identity === undefined) await atomicJson(identityPath, { credentialFingerprint: this.credentialFingerprint }, this.root);
      }
      const activeFiles = (await readdir(join(this.root, "active"))).filter((name) => name.endsWith(".json"));
      if (activeFiles.length > 10_000) throw new Error("Memory processing backlog exceeds the supported 10000 active jobs");
      for (const name of activeFiles) {
        if (!name.endsWith(".json")) continue;
        const job = validateJob(JSON.parse(await readFile(join(this.root, "active", name), "utf8")), name);
        this.active.set(job.id, job);
      }
    } catch (error) { await this.close(); throw error; }
  }

  async close(): Promise<void> {
    if (this.claim !== undefined) { await unlink(this.claim).catch(() => undefined); this.claim = undefined; }
  }

  async readSchedulerState(id: string): Promise<unknown | undefined> {
    if (this.claim === undefined || !/^[a-f0-9]{64}$/.test(id)) throw new Error("Open the processing spool before reading scheduler state");
    try { return JSON.parse(await readFile(join(this.root, `scheduler-${id}.json`), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }

  async writeSchedulerState(id: string, state: unknown): Promise<void> {
    if (this.claim === undefined || !/^[a-f0-9]{64}$/.test(id)) throw new Error("Open the processing spool before saving scheduler state");
    await atomicJson(join(this.root, `scheduler-${id}.json`), state, this.root);
  }

  async enqueue(kind: ProcessingJob["kind"], identity: unknown, input: unknown, configuration?: string, triggerWindow?: unknown): Promise<boolean> {
    if (this.claim === undefined) throw new Error("Open the processing spool before scheduling work");
    const id = processingDigest([kind, identity]);
    if (this.active.has(id)) return false;
    for (const terminal of ["completed", "excluded"]) {
      try {
        const receipt = validateJob(JSON.parse(await readFile(join(this.root, terminal, `${id}.json`), "utf8")), `${id}.json`);
        if (receipt.status !== (terminal === "completed" ? "complete" : "excluded")) throw new Error("Invalid terminal processing receipt");
        return false;
      }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    if (this.active.size >= this.maxActiveJobs) throw new ProcessingBackpressureError(`Memory processing backlog reached ${this.maxActiveJobs} jobs; transport progress has not advanced`);
    await this.save({ version: 1, id, kind, input, status: "pending", attempts: 0, nextAttemptAt: 0, updatedAt: Date.now(), ...(configuration === undefined ? {} : { configuration }), ...(triggerWindow === undefined ? {} : { triggerWindow }) });
    return true;
  }

  async save(job: ProcessingJob): Promise<void> {
    if (this.claim === undefined) throw new Error("Open the processing spool before saving work");
    validateJob(job, `${job.id}.json`);
    const directory = join(this.root, "active");
    await atomicJson(join(directory, `${job.id}.json`), job, directory);
    this.active.set(job.id, job);
    if (job.status === "complete" || job.status === "excluded") {
      const terminal = join(this.root, job.status === "excluded" ? "excluded" : "completed");
      await rename(join(directory, `${job.id}.json`), join(terminal, `${job.id}.json`));
      await syncDirectory(terminal);
      await syncDirectory(directory);
      this.active.delete(job.id);
    }
  }

  due(now = Date.now(), limit = 25, lane: "all" | "extraction" | "synthesis" = "all"): readonly ProcessingJob[] {
    return [...this.active.values()].filter((job) => job.status !== "blocked" && job.nextAttemptAt <= now &&
      (lane === "all" || (lane === "synthesis" ? ["synthesis", "episode"].includes(job.kind) : !["synthesis", "episode"].includes(job.kind))))
      .sort((a, b) => a.updatedAt - b.updatedAt || a.id.localeCompare(b.id)).slice(0, limit);
  }

  async retryBlocked(): Promise<number> {
    let count = 0;
    for (const job of this.active.values()) {
      if (!["blocked", "waiting", "retry"].includes(job.status)) continue;
      await this.save({ ...job, status: "pending", attempts: 0, nextAttemptAt: 0, updatedAt: Date.now() });
      count++;
    }
    return count;
  }

  async coverage() {
    return {
      active: [...this.active.values()].map(jobSummary),
      completedReceipts: (await readdir(join(this.root, "completed"))).filter((name) => name.endsWith(".json")).length,
      excludedReceipts: (await readdir(join(this.root, "excluded"))).filter((name) => name.endsWith(".json")).length,
    };
  }
}
