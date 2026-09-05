import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve, sep } from "node:path";
import { chmod, mkdir, open, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import { createInterface } from "node:readline";

import {
  decryptVaultLine,
  encryptVaultLine,
  redactJsonValue,
  redactTranscriptRecord,
  RecordAnonymizer,
} from "@_89/super-brain-importer";

import type {
  CapturedStep,
  CaptureSession,
  CaptureState,
  HookSource,
  HookAuthority,
  SpoolJob,
  StoredHookArtifact,
  VaultArtifact,
} from "./types.js";

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

export async function syncPrivateDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

export async function secureDirectory(path: string): Promise<void> {
  const created = await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
  if (created !== undefined) {
    const boundary = dirname(resolve(created));
    let current = resolve(path);
    while (true) {
      await syncPrivateDirectory(current);
      if (current === boundary || current === dirname(current)) break;
      current = dirname(current);
    }
  }
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
    await syncPrivateDirectory(dirname(path));
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
    await syncPrivateDirectory(dirname(path));
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

function rebaseTrajectoryJob(
  job: Extract<SpoolJob, { readonly kind: "trajectory" | "trajectory-tree" }>,
  eventTime: number,
): SpoolJob {
  const suffix = sha256(job.id).slice(0, 12);
  const prefix = `capture-${eventTime.toString().padStart(13, "0")}`;
  const treeStamp = {
    id: `${prefix}-000-trajectory-tree-retry-${suffix}`,
    t: eventTime,
    worldDate: new Date(eventTime).toISOString().slice(0, 10),
  };
  const common = {
    id: `${prefix}-900-retry-${suffix}`,
    createdAt: new Date(eventTime).toISOString(),
    treeStamp,
    captureIdentity: { ...job.captureIdentity, reissuedFrom: job.id },
  };
  if (job.kind === "trajectory-tree") return { ...job, ...common };
  return {
    ...job,
    ...common,
    runStamp: {
      id: `${prefix}-001-trajectory-run-retry-${suffix}`,
      t: eventTime,
      worldDate: new Date(eventTime).toISOString().slice(0, 10),
    },
  };
}

function safeSource(source: HookSource): string {
  return source.replace(/[^a-z0-9-]/g, "-");
}

function spoolOrderStamp(job: SpoolJob): { readonly t: number; readonly id: string } {
  if (job.kind === "event") return { t: job.event.at.t, id: job.event.id };
  if (job.kind === "trajectory" || job.kind === "trajectory-tree") return job.treeStamp;
  const createdAt = Date.parse(job.createdAt);
  return { t: Number.isFinite(createdAt) ? createdAt : Number.MAX_SAFE_INTEGER, id: job.id };
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
    return atomicPrivateJson(this.path, {
      ...state,
      sessions: Object.fromEntries(Object.entries(state.sessions).map(([key, session]) => [key, {
        ...session,
        steps: [],
        stepCount: session.steps.length,
      }])),
    });
  }
}

function capturedStep(value: unknown, path: string, line: number): CapturedStep {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`capture step journal contains a non-object at ${path}:${line}`);
  }
  const step = value as Partial<CapturedStep>;
  if (
    typeof step.id !== "string" ||
    !Number.isInteger(step.stepNumber) ||
    (step.stepNumber ?? 0) < 1 ||
    !(["decision", "action", "observation"] as const).includes(step.nodeKind as never) ||
    !(["model_thought", "tool_call", "tool_call_response", "decision", "model_output"] as const)
      .includes(step.role as never) ||
    typeof step.content !== "string"
  ) {
    throw new Error(`capture step journal contains an invalid step at ${path}:${line}`);
  }
  return step as CapturedStep;
}

function stepEvidenceKey(step: Omit<CapturedStep, "id" | "stepNumber">): string {
  return JSON.stringify([
    step.artifactId ?? "",
    step.eventId ?? "",
    step.turnId ?? "",
    step.role,
    step.nodeKind,
    step.toolName ?? "",
    step.content,
    step.startedAt ?? "",
    step.durationMs ?? "",
  ]);
}

export class SessionStepStore {
  private readonly root: string;
  private readonly cache = new Map<string, CapturedStep[]>();

  constructor(stateRoot: string) {
    this.root = join(stateRoot, "steps");
  }

  private identity(source: HookSource, sessionId: string): string {
    return sha256(`${source}\0${sessionId}`);
  }

  private path(source: HookSource, sessionId: string): string {
    const identity = this.identity(source, sessionId);
    return join(this.root, identity.slice(0, 2), `${identity}.jsonl`);
  }

  async initialize(): Promise<void> {
    await secureDirectory(this.root);
  }

  private async read(source: HookSource, sessionId: string): Promise<CapturedStep[]> {
    const identity = this.identity(source, sessionId);
    const cached = this.cache.get(identity);
    if (cached !== undefined) return cached;
    const path = this.path(source, sessionId);
    let serialized: string;
    try {
      serialized = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        const empty: CapturedStep[] = [];
        this.cache.set(identity, empty);
        return empty;
      }
      throw error;
    }
    const rawLines = serialized.split("\n");
    if (rawLines.at(-1) === "") rawLines.pop();
    const steps: CapturedStep[] = [];
    let validBytes = 0;
    for (const [index, line] of rawLines.entries()) {
      try {
        const step = capturedStep(JSON.parse(line) as unknown, path, index + 1);
        if (step.stepNumber !== steps.length + 1 || step.id !== `step-${step.stepNumber}`) {
          throw new Error(`capture step journal is out of sequence at ${path}:${index + 1}`);
        }
        steps.push(step);
        validBytes += Buffer.byteLength(`${line}\n`);
      } catch (error) {
        if (index !== rawLines.length - 1) throw error;
        const file = await open(path, "r+");
        try {
          await file.truncate(validBytes);
          await file.sync();
        } finally {
          await file.close();
        }
      }
    }
    this.cache.set(identity, steps);
    return steps;
  }

  async synchronize(session: CaptureSession): Promise<CaptureSession> {
    await this.initialize();
    const existing = await this.read(session.source, session.sessionId);
    const evidence = new Map(existing.map((step) => [stepEvidenceKey(step), step]));
    const additions: CapturedStep[] = [];
    for (const candidate of session.steps) {
      if (evidence.has(stepEvidenceKey(candidate))) continue;
      const stepNumber = existing.length + additions.length + 1;
      const step: CapturedStep = { ...candidate, id: `step-${stepNumber}`, stepNumber };
      additions.push(step);
      evidence.set(stepEvidenceKey(step), step);
    }
    if (additions.length > 0) {
      const path = this.path(session.source, session.sessionId);
      await secureDirectory(dirname(path));
      const file = await open(path, "a", 0o600);
      try {
        await file.writeFile(additions.map((step) => `${JSON.stringify(step)}\n`).join(""), "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      await chmod(path, 0o600);
      await syncPrivateDirectory(dirname(path));
      existing.push(...additions);
    }
    return { ...session, steps: [...existing], stepCount: existing.length };
  }

  async replace(session: CaptureSession, stepsInput: readonly CapturedStep[]): Promise<CaptureSession> {
    await this.initialize();
    const steps = stepsInput.map((step, index) => ({
      ...step,
      id: `step-${index + 1}`,
      stepNumber: index + 1,
    }));
    const path = this.path(session.source, session.sessionId);
    await atomicPrivateText(path, steps.map((step) => `${JSON.stringify(step)}\n`).join(""));
    this.cache.set(this.identity(session.source, session.sessionId), steps);
    return { ...session, steps, stepCount: steps.length };
  }
}

export class TranscriptSnapshotStore {
  private readonly root: string;

  constructor(
    stateRoot: string,
    private readonly options: {
      readonly reasoningPolicy?: "exclude" | "include";
      readonly retainEncryptedReasoning?: boolean;
    } = {},
  ) {
    this.root = resolve(stateRoot, "transcript-snapshots");
  }

  async store(source: HookSource, sourcePath: string): Promise<string> {
    const before = await stat(sourcePath);
    if (!before.isFile()) throw new Error(`transcript source is not a regular file: ${sourcePath}`);
    const directory = join(this.root, safeSource(source));
    await secureDirectory(directory);
    const temporary = join(directory, `.${process.pid}.${Date.now()}.${sha256(sourcePath).slice(0, 12)}.tmp`);
    const output = await open(temporary, "wx", 0o600);
    const digest = createHash("sha256");
    try {
      const lines = createInterface({ input: createReadStream(sourcePath), crlfDelay: Infinity });
      for await (const line of lines) {
        if (line.trim().length === 0) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line) as unknown;
        } catch {
          parsed = line;
        }
        const protectedRecord = redactTranscriptRecord(parsed, this.options);
        const serialized = `${JSON.stringify(protectedRecord.value)}\n`;
        digest.update(serialized);
        await output.writeFile(serialized, "utf8");
      }
      const after = await stat(sourcePath);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
        throw new Error("transcript source changed while its durable snapshot was being created");
      }
      await output.sync();
      await output.close();
      const name = basename(sourcePath).replace(/[^a-zA-Z0-9._-]/g, "_") || "transcript.jsonl";
      const target = join(directory, `${digest.digest("hex")}-${name}`);
      try {
        await stat(target);
        await unlink(temporary);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await rename(temporary, target);
        await chmod(target, 0o600);
        await syncPrivateDirectory(dirname(target));
      }
      return target;
    } catch (error) {
      await output.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  async complete(pathInput: string): Promise<void> {
    const path = resolve(pathInput);
    if (path !== this.root && !path.startsWith(`${this.root}${sep}`)) {
      throw new Error("refusing to remove a transcript outside the snapshot store");
    }
    await unlink(path);
  }
}

export class HookVault {
  constructor(
    private readonly root: string,
    private readonly encryptionKey?: Uint8Array,
    private readonly options: {
      readonly anonymizer?: RecordAnonymizer;
      readonly retainEncryptedReasoning?: boolean;
    } = {},
  ) {}

  async store(source: HookSource, payload: unknown, eventTime: number, metadata: { readonly receiptId?: string; readonly authority?: HookAuthority } = {}): Promise<VaultArtifact> {
    const anonymized = this.options.anonymizer?.value(payload) ?? payload;
    const redacted = redactJsonValue(anonymized, {
      ...(this.options.retainEncryptedReasoning === undefined
        ? {}
        : { retainEncryptedContent: this.options.retainEncryptedReasoning }),
    }).value;
    const canonical = JSON.stringify({ source, payload: redacted, ...metadata });
    const id = sha256(canonical);
    const directory = join(this.root, "hooks", safeSource(source), id.slice(0, 2));
    const path = join(directory, `${id}.json${this.encryptionKey === undefined ? "" : ".enc"}`);
    try {
      await stat(path);
      return { id, receivedAt: new Date(eventTime).toISOString(), eventTime, path, ...metadata };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const receivedAt = new Date(eventTime).toISOString();
    const serialized = `${JSON.stringify({ version: 1, id, source, receivedAt, eventTime, payload: redacted, ...metadata })}\n`;
    await atomicPrivateText(
      path,
      this.encryptionKey === undefined ? serialized : `${encryptVaultLine(serialized.trimEnd(), this.encryptionKey)}\n`,
    );
    return { id, receivedAt, eventTime, path, ...metadata };
  }

  async sessionArtifacts(source: HookSource, sessionId: string): Promise<readonly StoredHookArtifact[]> {
    const sourceRoot = join(this.root, "hooks", safeSource(source));
    let prefixes: string[];
    try {
      prefixes = await readdir(sourceRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const expected = new Set([
      sessionId,
      this.options.anonymizer?.alias("session_id", sessionId),
      this.options.anonymizer?.alias("sessionId", sessionId),
      this.options.anonymizer?.alias("conversation_id", sessionId),
    ].filter((value): value is string => value !== undefined));
    const artifacts: StoredHookArtifact[] = [];
    for (const prefix of prefixes.sort()) {
      const directory = join(sourceRoot, prefix);
      let names: string[];
      try {
        names = await readdir(directory);
      } catch {
        continue;
      }
      for (const name of names.sort()) {
        const serialized = (await readFile(join(directory, name), "utf8")).trim();
        if (serialized.length === 0) continue;
        const parsed = JSON.parse(decryptVaultLine(serialized, this.encryptionKey)) as Partial<StoredHookArtifact>;
        const payload = parsed.payload;
        if (typeof payload !== "object" || payload === null || Array.isArray(payload)) continue;
        const record = payload as Record<string, unknown>;
        const observedSession = [record.session_id, record.sessionId, record.conversation_id]
          .find((value): value is string => typeof value === "string");
        if (observedSession === undefined || !expected.has(observedSession)) continue;
        if (
          typeof parsed.id !== "string" ||
          typeof parsed.receivedAt !== "string" ||
          typeof parsed.eventTime !== "number"
        ) continue;
        artifacts.push({
          id: parsed.id,
          source,
          receivedAt: parsed.receivedAt,
          eventTime: parsed.eventTime,
          payload: record,
          ...(parsed.authority === undefined ? {} : { authority: parsed.authority }),
          ...(parsed.receiptId === undefined ? {} : { receiptId: parsed.receiptId }),
        });
      }
    }
    return artifacts.sort((left, right) =>
      left.eventTime - right.eventTime || left.id.localeCompare(right.id)
    );
  }
}

export async function readHookVaultArtifact(options: {
  readonly vaultRoot: string;
  readonly source: HookSource;
  readonly artifactId: string;
  readonly encryptionKey?: Uint8Array;
}): Promise<StoredHookArtifact | undefined> {
  if (!/^[a-f0-9]{64}$/i.test(options.artifactId)) throw new TypeError("hook artifact id is invalid");
  const id = options.artifactId.toLowerCase();
  const directory = join(options.vaultRoot, "hooks", safeSource(options.source), id.slice(0, 2));
  let serialized: string | undefined;
  for (const name of [`${id}.json.enc`, `${id}.json`]) {
    try {
      serialized = (await readFile(join(directory, name), "utf8")).trim();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (serialized === undefined || serialized.length === 0) return undefined;
  const parsed = JSON.parse(decryptVaultLine(serialized, options.encryptionKey)) as Partial<StoredHookArtifact>;
  if (
    parsed.id !== id ||
    parsed.source !== options.source ||
    typeof parsed.receivedAt !== "string" ||
    typeof parsed.eventTime !== "number" ||
    typeof parsed.payload !== "object" ||
    parsed.payload === null ||
    Array.isArray(parsed.payload)
  ) {
    throw new Error("hook artifact has an invalid shape");
  }
  return parsed as StoredHookArtifact;
}

export class DurableSpool {
  private readonly pending: string;
  private readonly failed: string;
  private readonly resolved: string;

  constructor(stateRoot: string) {
    this.pending = join(stateRoot, "spool", "pending");
    this.failed = join(stateRoot, "spool", "failed");
    this.resolved = join(stateRoot, "spool", "resolved");
  }

  async initialize(): Promise<void> {
    await secureDirectory(this.pending);
    await secureDirectory(this.failed);
    await secureDirectory(this.resolved);
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
    return jobs.sort((left, right) => {
      const leftStamp = spoolOrderStamp(left.job);
      const rightStamp = spoolOrderStamp(right.job);
      return leftStamp.t - rightStamp.t || leftStamp.id.localeCompare(rightStamp.id);
    });
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
    const failedJobs = failedFiles.filter((name) => name.endsWith(".json") && !name.endsWith(".error.json")).sort();
    const failures = failedFiles.filter((name) => name.endsWith(".error.json")).sort();
    const latest = failures.at(-1);
    if (failedJobs.length === 0) {
      return {
        pendingJobs: pending.filter((name) => name.endsWith(".json")).length,
        failedJobs: 0,
      };
    }
    const detail = latest === undefined ? {} : JSON.parse(await readFile(join(this.failed, latest), "utf8")) as {
      readonly failedAt?: unknown;
      readonly reason?: unknown;
    };
    return {
      pendingJobs: pending.filter((name) => name.endsWith(".json")).length,
      failedJobs: failedJobs.length,
      ...(typeof detail.failedAt === "string" ? { lastFailureAt: detail.failedAt } : {}),
      ...(typeof detail.reason === "string" ? { lastFailure: detail.reason.slice(0, 500) } : {}),
    };
  }

  async resolveFailed(
    reason: string,
    confirm = false,
  ): Promise<{ readonly matched: number; readonly resolved: number }> {
    await this.initialize();
    const normalizedReason = reason.trim();
    if (normalizedReason.length === 0) throw new TypeError("failed-job resolution requires a reason");
    const names = (await readdir(this.failed))
      .filter((name) => name.endsWith(".json") && !name.endsWith(".error.json"))
      .sort();
    if (!confirm) return { matched: names.length, resolved: 0 };
    let resolved = 0;
    for (const name of names) {
      const source = join(this.failed, name);
      const errorPath = join(this.failed, `${name}.error.json`);
      const job = JSON.parse(await readFile(source, "utf8")) as SpoolJob;
      let failure: unknown;
      try {
        failure = JSON.parse(await readFile(errorPath, "utf8")) as unknown;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const target = join(this.resolved, name);
      try {
        await stat(target);
        throw new Error(`cannot resolve failed job because an archived job has the same name: ${name}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await atomicPrivateJson(`${target}.resolution.json`, {
        resolvedAt: new Date().toISOString(),
        reason: normalizedReason.slice(0, 2_000),
        job: { id: job.id, kind: job.kind, createdAt: job.createdAt },
        ...(failure === undefined ? {} : { failure }),
      });
      await rename(source, target);
      try {
        await rename(errorPath, `${target}.error.json`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      resolved += 1;
    }
    return { matched: names.length, resolved };
  }

  async retryFailed(
    confirm = false,
    options: { readonly rebaseEvents?: boolean; readonly rebaseTrajectories?: boolean } = {},
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
        : options.rebaseTrajectories === true && (job.kind === "trajectory" || job.kind === "trajectory-tree")
          ? rebaseTrajectoryJob(job, rebaseStart + index)
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
