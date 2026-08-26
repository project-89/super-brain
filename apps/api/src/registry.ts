import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { join } from "node:path";

import type { FoldLogEntry } from "@_89/fold";
import { FoldSdk, type FoldSdkStore } from "@_89/fold-sdk";
import {
  FoldJournal,
  type ReadJournalOptions,
} from "@_89/fold-storage";

import type { FoldSdkRegistry } from "./types.js";

const WRITER_LOCK_FILENAME = ".fold-writer.lock";

interface WriterLease {
  readonly pid: number;
  readonly token: string;
  readonly acquiredAt: string;
}

export class DataDirectoryLockedError extends Error {
  override readonly name = "DataDirectoryLockedError";

  constructor(readonly lockPath: string) {
    super(`Fold data directory already has an active writer: ${lockPath}`);
  }
}

function processExists(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 1) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function existingLeaseIsStale(path: string): Promise<boolean> {
  try {
    const lease = JSON.parse(await readFile(path, "utf8")) as Partial<WriterLease>;
    return typeof lease.pid === "number" && !processExists(lease.pid);
  } catch {
    return false;
  }
}

async function createLeaseFile(path: string, lease: WriterLease): Promise<FileHandle> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(lease)}\n`, "utf8");
    await handle.sync();
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(path).catch(() => undefined);
    throw error;
  }
}

async function removeLeaseIfOwned(path: string, lease: WriterLease): Promise<void> {
  try {
    const current = JSON.parse(await readFile(path, "utf8")) as Partial<WriterLease>;
    if (current.token === lease.token) await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function acquireWriterLease(path: string, lease: WriterLease): Promise<FileHandle> {
  try {
    return await createLeaseFile(path, lease);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  if (!await existingLeaseIsStale(path)) throw new DataDirectoryLockedError(path);

  const recoveryPath = `${path}.recovery`;
  let recoveryHandle: FileHandle;
  try {
    recoveryHandle = await createLeaseFile(recoveryPath, lease);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new DataDirectoryLockedError(path);
    }
    throw error;
  }
  try {
    if (!await existingLeaseIsStale(path)) throw new DataDirectoryLockedError(path);
    await unlink(path).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  } finally {
    await recoveryHandle.close();
    await removeLeaseIfOwned(recoveryPath, lease);
  }

  try {
    return await createLeaseFile(path, lease);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new DataDirectoryLockedError(path);
    }
    throw error;
  }
}

class DurableJournalStore implements FoldSdkStore {
  constructor(private readonly journal: FoldJournal) {}

  read(options: ReadJournalOptions = {}) {
    return this.journal.read(options);
  }

  append(entry: FoldLogEntry): Promise<void> {
    return this.journal.append(entry, { sync: true });
  }
}

export function workspaceJournalFilename(workspaceId: string): string {
  if (workspaceId.trim().length === 0) throw new TypeError("workspaceId must not be empty");
  return `${createHash("sha256").update(workspaceId).digest("hex")}.jsonl`;
}

export class JournalSdkRegistry implements FoldSdkRegistry {
  private readonly ready: Promise<void>;
  private readonly sdks = new Map<string, FoldSdk>();
  private readonly lockPath: string;
  private readonly lease: WriterLease;
  private lockHandle: FileHandle | undefined;
  private closed = false;

  constructor(readonly dataDirectory: string) {
    if (dataDirectory.trim().length === 0) throw new TypeError("dataDirectory must not be empty");
    this.lockPath = join(dataDirectory, WRITER_LOCK_FILENAME);
    this.lease = { pid: process.pid, token: randomUUID(), acquiredAt: new Date().toISOString() };
    this.ready = this.initialize();
  }

  private async initialize(): Promise<void> {
    await mkdir(this.dataDirectory, { recursive: true });
    this.lockHandle = await acquireWriterLease(this.lockPath, this.lease);
  }

  async open(): Promise<void> {
    await this.ready;
    if (this.closed) throw new Error("journal SDK registry is closed");
  }

  async sdkFor(workspaceId: string): Promise<FoldSdk> {
    await this.open();
    let sdk = this.sdks.get(workspaceId);
    if (sdk === undefined) {
      const path = join(this.dataDirectory, workspaceJournalFilename(workspaceId));
      sdk = new FoldSdk(new DurableJournalStore(new FoldJournal(path)));
      this.sdks.set(workspaceId, sdk);
    }
    return sdk;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.ready.catch(() => undefined);
    const handle = this.lockHandle;
    this.lockHandle = undefined;
    if (handle === undefined) return;
    await handle.close();
    await removeLeaseIfOwned(this.lockPath, this.lease);
  }
}
