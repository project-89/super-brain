import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { chmod, mkdir, open, readFile, readdir, rename, stat, unlink } from "node:fs/promises";

import { encryptVaultLine, redactJsonValue } from "@_89/super-brain-importer";

import type { CaptureState, HookSource, SpoolJob, VaultArtifact } from "./types.js";

const EMPTY_STATE: CaptureState = {
  version: 1,
  lastEventTime: -1,
  seenArtifacts: [],
  sessions: {},
};

export interface RelayFailureSummary {
  readonly count: number;
  readonly lastFailureAt?: string;
  readonly lastFailure?: string;
}

export interface SpoolSnapshot {
  readonly pendingJobs: number;
  readonly failedJobs: number;
  readonly lastFailureAt?: string;
  readonly lastFailure?: string;
}

async function secureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

async function atomicPrivateJson(path: string, value: unknown): Promise<void> {
  await secureDirectory(dirname(path));
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await file.sync();
    await file.close();
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await file.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function atomicPrivateText(path: string, value: string): Promise<void> {
  await secureDirectory(dirname(path));
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(value, "utf8");
    await file.sync();
    await file.close();
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await file.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function rebaseEventJob(job: Extract<SpoolJob, { readonly kind: "event" }>, eventTime: number): SpoolJob {
  const originalEventId = job.event.id;
  const id = `capture-${eventTime.toString().padStart(13, "0")}-900-retry-${sha256(originalEventId).slice(0, 12)}`;
  return {
    ...job,
    id,
    createdAt: new Date(eventTime).toISOString(),
    event: {
      ...job.event,
      id,
      at: { ...job.event.at, t: eventTime, worldDate: new Date(eventTime).toISOString().slice(0, 10) },
      capture: {
        ...job.event.capture,
        identity: { ...job.event.capture.identity, reissuedFrom: originalEventId },
      },
      changes: job.event.changes.map((change) =>
        change.subject.endsWith(`:${originalEventId}`)
          ? { ...change, subject: `${change.subject.slice(0, -originalEventId.length)}${id}` }
          : change
      ),
    },
  };
}

function safeSource(source: HookSource): string {
  return source.replace(/[^a-z0-9-]/g, "-");
}

export class StateStore {
  private readonly path: string;

  constructor(stateRoot: string) {
    this.path = join(stateRoot, "state.json");
  }

  async load(): Promise<CaptureState> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as CaptureState;
      if (parsed.version !== 1 || !Array.isArray(parsed.seenArtifacts) || typeof parsed.sessions !== "object") {
        throw new Error("capture state has an unsupported shape");
      }
      return {
        ...parsed,
        sessions: Object.fromEntries(
          Object.entries(parsed.sessions).map(([id, session]) => [id, { ...session, active: false }]),
        ),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_STATE;
      throw error;
    }
  }

  save(state: CaptureState): Promise<void> {
    return atomicPrivateJson(this.path, state);
  }
}

export class HookVault {
  constructor(private readonly root: string, private readonly encryptionKey?: Uint8Array) {}

  async store(source: HookSource, payload: unknown, eventTime: number): Promise<VaultArtifact> {
    const redacted = redactJsonValue(payload).value;
    const canonical = JSON.stringify({ source, payload: redacted });
    const id = sha256(canonical);
    const directory = join(this.root, "hooks", safeSource(source), id.slice(0, 2));
    const path = join(directory, `${id}.json${this.encryptionKey === undefined ? "" : ".enc"}`);
    try {
      await stat(path);
      return { id, receivedAt: new Date(eventTime).toISOString(), eventTime, path };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const receivedAt = new Date(eventTime).toISOString();
    const serialized = `${JSON.stringify({ version: 1, id, source, receivedAt, eventTime, payload: redacted })}\n`;
    await atomicPrivateText(
      path,
      this.encryptionKey === undefined ? serialized : `${encryptVaultLine(serialized.trimEnd(), this.encryptionKey)}\n`,
    );
    return { id, receivedAt, eventTime, path };
  }
}

export class DurableSpool {
  private readonly pending: string;
  private readonly failed: string;

  constructor(stateRoot: string) {
    this.pending = join(stateRoot, "spool", "pending");
    this.failed = join(stateRoot, "spool", "failed");
  }

  async initialize(): Promise<void> {
    await secureDirectory(this.pending);
    await secureDirectory(this.failed);
  }

  async enqueue(job: SpoolJob): Promise<void> {
    await this.initialize();
    const filename = `${job.id.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`;
    const path = join(this.pending, filename);
    try {
      await stat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await atomicPrivateJson(path, job);
    }
  }

  async list(): Promise<readonly { readonly path: string; readonly job: SpoolJob }[]> {
    await this.initialize();
    const files = (await readdir(this.pending)).filter((name) => name.endsWith(".json")).sort();
    const jobs = await Promise.all(files.map(async (name) => {
      const path = join(this.pending, name);
      return { path, job: JSON.parse(await readFile(path, "utf8")) as SpoolJob };
    }));
    return jobs;
  }

  complete(path: string): Promise<void> {
    return unlink(path);
  }

  async reject(path: string, reason: string): Promise<void> {
    const name = path.split("/").at(-1) ?? `${Date.now()}.json`;
    const target = join(this.failed, name);
    await rename(path, target);
    await atomicPrivateJson(`${target}.error.json`, { failedAt: new Date().toISOString(), reason });
  }

  async snapshot(): Promise<SpoolSnapshot> {
    await this.initialize();
    const [pending, failedFiles] = await Promise.all([readdir(this.pending), readdir(this.failed)]);
    const failures = failedFiles.filter((name) => name.endsWith(".error.json")).sort();
    const latest = failures.at(-1);
    if (latest === undefined) {
      return {
        pendingJobs: pending.filter((name) => name.endsWith(".json")).length,
        failedJobs: 0,
      };
    }
    const detail = JSON.parse(await readFile(join(this.failed, latest), "utf8")) as {
      readonly failedAt?: unknown;
      readonly reason?: unknown;
    };
    return {
      pendingJobs: pending.filter((name) => name.endsWith(".json")).length,
      failedJobs: failures.length,
      ...(typeof detail.failedAt === "string" ? { lastFailureAt: detail.failedAt } : {}),
      ...(typeof detail.reason === "string" ? { lastFailure: detail.reason.slice(0, 500) } : {}),
    };
  }

  async retryFailed(
    confirm = false,
    options: { readonly rebaseEvents?: boolean } = {},
  ): Promise<{ readonly matched: number; readonly retried: number; readonly rebased: number }> {
    await this.initialize();
    const names = (await readdir(this.failed))
      .filter((name) => name.endsWith(".json") && !name.endsWith(".error.json"))
      .sort();
    if (!confirm) return { matched: names.length, retried: 0, rebased: 0 };
    let retried = 0;
    let rebased = 0;
    const rebaseStart = Date.now();
    for (const [index, name] of names.entries()) {
      const source = join(this.failed, name);
      const job = JSON.parse(await readFile(source, "utf8")) as SpoolJob;
      const retryJob = options.rebaseEvents === true && job.kind === "event"
        ? rebaseEventJob(job, rebaseStart + index)
        : job;
      const targetName = `${retryJob.id.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`;
      const target = join(this.pending, targetName);
      try {
        await stat(target);
        throw new Error(`cannot retry failed job because a pending job has the same name: ${targetName}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (retryJob === job) await rename(source, target);
      else {
        await atomicPrivateJson(target, retryJob);
        await unlink(source);
        rebased += 1;
      }
      await unlink(join(this.failed, `${name}.error.json`)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      retried += 1;
    }
    return { matched: names.length, retried, rebased };
  }
}

function relayFailurePath(stateRoot: string): string {
  return join(stateRoot, "relay-errors.jsonl");
}

export async function recordRelayFailure(
  stateRoot: string,
  source: HookSource,
  endpoint: string,
  error: unknown,
): Promise<void> {
  await secureDirectory(stateRoot);
  const path = relayFailurePath(stateRoot);
  const file = await open(path, "a", 0o600);
  try {
    const message = error instanceof Error ? error.message : String(error);
    await file.writeFile(`${JSON.stringify({ at: new Date().toISOString(), source, endpoint, error: message.slice(0, 500) })}\n`);
  } finally {
    await file.close();
    await chmod(path, 0o600).catch(() => undefined);
  }
}

export async function readRelayFailureSummary(stateRoot: string): Promise<RelayFailureSummary> {
  try {
    const lines = (await readFile(relayFailurePath(stateRoot), "utf8"))
      .split("\n")
      .filter((line) => line.trim().length > 0);
    const last = lines.at(-1);
    if (last === undefined) return { count: 0 };
    const parsed = JSON.parse(last) as { readonly at?: unknown; readonly error?: unknown };
    return {
      count: lines.length,
      ...(typeof parsed.at === "string" ? { lastFailureAt: parsed.at } : {}),
      ...(typeof parsed.error === "string" ? { lastFailure: parsed.error } : {}),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { count: 0 };
    throw error;
  }
}
