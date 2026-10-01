import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import { decryptVaultLine, encryptVaultLine, redactJsonValue } from "@_89/super-brain-importer";

import type { HookSource } from "./types.js";

export interface HookInboxItem {
  readonly version: 1;
  readonly id: string;
  readonly receivedAt: string;
  readonly source: HookSource;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface HookInboxSnapshot {
  readonly pendingHooks: number;
  readonly failedHooks: number;
  readonly lastFailureAt?: string;
  readonly lastFailure?: string;
}

async function secureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

async function atomicPrivateText(path: string, value: string): Promise<void> {
  await secureDirectory(dirname(path));
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
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

function validateItem(value: unknown): HookInboxItem {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("hook inbox item must be an object");
  }
  const item = value as Partial<HookInboxItem>;
  if (
    item.version !== 1 ||
    typeof item.id !== "string" ||
    typeof item.receivedAt !== "string" ||
    !["claude-code", "codex", "hermes", "unknown"].includes(item.source ?? "") ||
    typeof item.payload !== "object" ||
    item.payload === null ||
    Array.isArray(item.payload)
  ) {
    throw new Error("hook inbox item has an invalid shape");
  }
  return item as HookInboxItem;
}

export class HookInbox {
  private readonly pending: string;
  private readonly failed: string;

  constructor(stateRoot: string, private readonly encryptionKey?: Uint8Array) {
    this.pending = join(stateRoot, "inbox", "pending");
    this.failed = join(stateRoot, "inbox", "failed");
  }

  async initialize(): Promise<void> {
    await Promise.all([secureDirectory(this.pending), secureDirectory(this.failed)]);
  }

  async enqueue(source: HookSource, payload: Readonly<Record<string, unknown>>): Promise<{ readonly id: string }> {
    await this.initialize();
    const receivedAt = new Date().toISOString();
    const monotonic = process.hrtime.bigint().toString().padStart(20, "0");
    const id = `${Date.now().toString().padStart(13, "0")}-${monotonic}-${randomUUID()}`;
    const protectedPayload = this.encryptionKey === undefined
      ? redactJsonValue(payload).value as Readonly<Record<string, unknown>>
      : payload;
    const item: HookInboxItem = { version: 1, id, receivedAt, source, payload: protectedPayload };
    const serialized = JSON.stringify(item);
    const protectedValue = this.encryptionKey === undefined ? serialized : encryptVaultLine(serialized, this.encryptionKey);
    await atomicPrivateText(join(this.pending, `${id}.json`), `${protectedValue}\n`);
    return { id };
  }

  async list(limit = 50): Promise<readonly { readonly path: string; readonly item: HookInboxItem }[]> {
    if (!Number.isInteger(limit) || limit < 1) throw new TypeError("hook inbox limit must be a positive integer");
    await this.initialize();
    const names = (await readdir(this.pending)).filter((name) => name.endsWith(".json")).sort().slice(0, limit);
    return Promise.all(names.map(async (name) => {
      const path = join(this.pending, name);
      const serialized = (await readFile(path, "utf8")).trim();
      return { path, item: validateItem(JSON.parse(decryptVaultLine(serialized, this.encryptionKey)) as unknown) };
    }));
  }

  complete(path: string): Promise<void> {
    return unlink(path);
  }

  async reject(path: string, error: unknown): Promise<void> {
    await this.initialize();
    const name = path.split("/").at(-1) ?? `${Date.now()}.json`;
    const target = join(this.failed, name);
    await rename(path, target);
    const message = error instanceof Error ? error.message : String(error);
    await atomicPrivateText(`${target}.error.json`, `${JSON.stringify({
      failedAt: new Date().toISOString(),
      reason: message.slice(0, 500),
    })}\n`);
  }

  async snapshot(): Promise<HookInboxSnapshot> {
    await this.initialize();
    const [pending, failed] = await Promise.all([readdir(this.pending), readdir(this.failed)]);
    const failedHooks = failed.filter((name) => name.endsWith(".json") && !name.endsWith(".error.json"));
    const errors = failed.filter((name) => name.endsWith(".error.json")).sort();
    const latest = errors.at(-1);
    if (latest === undefined) {
      return { pendingHooks: pending.filter((name) => name.endsWith(".json")).length, failedHooks: failedHooks.length };
    }
    const detail = JSON.parse(await readFile(join(this.failed, latest), "utf8")) as {
      readonly failedAt?: unknown;
      readonly reason?: unknown;
    };
    return {
      pendingHooks: pending.filter((name) => name.endsWith(".json")).length,
      failedHooks: failedHooks.length,
      ...(typeof detail.failedAt === "string" ? { lastFailureAt: detail.failedAt } : {}),
      ...(typeof detail.reason === "string" ? { lastFailure: detail.reason } : {}),
    };
  }
}

export interface HookIngestor {
  ingest(source: HookSource, payload: unknown): Promise<{ readonly artifactId: string }>;
}

export class HookInboxProcessor {
  private timer: NodeJS.Timeout | undefined;
  private processing: Promise<void> | undefined;
  private nextFlushAt = 0;

  constructor(
    private readonly inbox: HookInbox,
    private readonly ingestor: HookIngestor,
    private readonly batchSize = 25,
    private readonly retryDelayMs = 1_000,
  ) {
    if (!Number.isInteger(batchSize) || batchSize < 1) throw new TypeError("hook inbox batch size must be positive");
    if (!Number.isFinite(retryDelayMs) || retryDelayMs < 0) throw new TypeError("hook inbox retry delay cannot be negative");
  }

  start(intervalMs = 100): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => void this.flush().catch(() => undefined), intervalMs);
    this.timer.unref();
    void this.flush().catch(() => undefined);
  }

  async stop(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    await this.processing;
  }

  flush(): Promise<void> {
    if (this.processing !== undefined) return this.processing;
    this.processing = this.processPending().finally(() => { this.processing = undefined; });
    return this.processing;
  }

  private async processPending(): Promise<void> {
    if (this.nextFlushAt > Date.now()) return;
    let pending: Awaited<ReturnType<HookInbox["list"]>>;
    try {
      pending = await this.inbox.list(this.batchSize);
    } catch {
      this.nextFlushAt = Date.now() + this.retryDelayMs;
      return;
    }
    for (const { path, item } of pending) {
      try {
        await this.ingestor.ingest(item.source, item.payload);
        await this.inbox.complete(path);
      } catch (error) {
        if (error instanceof TypeError) {
          await this.inbox.reject(path, error);
          continue;
        }
        this.nextFlushAt = Date.now() + this.retryDelayMs;
        break;
      }
    }
  }
}
