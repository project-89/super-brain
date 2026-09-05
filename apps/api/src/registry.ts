import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  chmod,
  open,
  readFile,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { join, dirname } from "node:path";

import type { FoldLogEntry } from "@_89/fold";
import { PostgresFoldDatabase, type PostgresFoldDatabaseOptions } from "@_89/fold-postgres";
import {
  FoldSdk,
  authorizeEventAccess,
  type FoldSdkAccessContext,
  type FoldSdkCursor,
  type FoldConsumerCursor,
  type FoldDeliveryCursor,
  type FoldSdkStore,
} from "@_89/fold-sdk";
import {
  FoldJournal,
  eventRecord,
  type ReadJournalOptions,
} from "@_89/fold-storage";

import { DEFAULT_ORGANIZATION_ID, type FoldSdkRegistry, type TenantKey } from "./types.js";

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
  readonly stableReads = true;
  readonly requireDurableCommands = true;
  private entries: FoldLogEntry[] | undefined;

  constructor(private readonly journal: FoldJournal) {}

  async read(options: ReadJournalOptions = {}) {
    if (this.entries === undefined) {
      const read = await this.journal.read(options);
      this.entries = [...read.entries];
    }
    return { entries: [...this.entries] };
  }

  async append(entry: FoldLogEntry): Promise<void> {
    await this.appendMany([entry]);
  }

  async appendMany(entries: readonly FoldLogEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const current = (await this.read({ missing: "empty" })).entries;
    const combined = [...current, ...entries];
    await this.journal.rewrite(combined.map(eventRecord), { sync: true });
    const directory = await open(dirname(this.journal.path), "r");
    try { await directory.sync(); } finally { await directory.close(); }
    this.entries = combined;
  }
}

function tenantStorageKey(tenant: TenantKey): string {
  if (tenant.organizationId.trim().length === 0) throw new TypeError("organizationId must not be empty");
  if (tenant.workspaceId.trim().length === 0) throw new TypeError("workspaceId must not be empty");
  return JSON.stringify([tenant.organizationId, tenant.workspaceId]);
}

export function workspaceJournalFilename(
  workspaceId: string,
  organizationId = DEFAULT_ORGANIZATION_ID,
): string {
  if (workspaceId.trim().length === 0) throw new TypeError("workspaceId must not be empty");
  if (organizationId.trim().length === 0) throw new TypeError("organizationId must not be empty");
  const key = organizationId === DEFAULT_ORGANIZATION_ID
    ? workspaceId
    : JSON.stringify([organizationId, workspaceId]);
  return `${createHash("sha256").update(key).digest("hex")}.jsonl`;
}

export class JournalSdkRegistry implements FoldSdkRegistry {
  private readonly ready: Promise<void>;
  private readonly sdks = new Map<string, FoldSdk>();
  private readonly pending = new Map<string, Promise<FoldSdk>>();
  private readonly stores = new Map<string, DurableJournalStore>();
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
    await mkdir(this.dataDirectory, { recursive: true, mode: 0o700 });
    await chmod(this.dataDirectory, 0o700);
    this.lockHandle = await acquireWriterLease(this.lockPath, this.lease);
  }

  async open(): Promise<void> {
    await this.ready;
    if (this.closed) throw new Error("journal SDK registry is closed");
  }

  async sdkFor(tenant: TenantKey): Promise<FoldSdk> {
    await this.open();
    const key = tenantStorageKey(tenant);
    const existing = this.sdks.get(key);
    if (existing !== undefined) return existing;
    let pending = this.pending.get(key);
    if (pending === undefined) {
      pending = (async () => {
        const path = join(this.dataDirectory, workspaceJournalFilename(tenant.workspaceId, tenant.organizationId));
        await chmod(path, 0o600).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        });
        const store = new DurableJournalStore(new FoldJournal(path));
        const sdk = new FoldSdk(store);
        this.stores.set(key, store);
        this.sdks.set(key, sdk);
        return sdk;
      })();
      this.pending.set(key, pending);
    }
    try { return await pending; }
    finally { this.pending.delete(key); }
  }

  async streamEntries(tenant: TenantKey, access: FoldSdkAccessContext, options: {
    readonly after?: FoldConsumerCursor; readonly includeDrafts?: boolean;
    readonly kinds?: readonly string[]; readonly limit: number;
  }) {
    await this.sdkFor(tenant);
    const entries = (await this.stores.get(tenantStorageKey(tenant))!.read({ missing: "empty" })).entries;
    const after = options.after !== undefined && "version" in options.after ? BigInt(options.after.sequence) : 0n;
    const page = entries.map((entry, index) => ({ entry, cursor: { version: 2 as const, sequence: String(index + 1) } }))
      .filter(({ cursor }) => BigInt(cursor.sequence) > after)
      .slice(0, options.limit);
    const allowed = page.filter(({ entry }) =>
      (options.includeDrafts || entry.status === "canon") &&
      (options.kinds === undefined || options.kinds.includes(entry.event.kind)) &&
      authorizeEventAccess(entry.event, access).allowed);
    const last = page.at(-1);
    return { entries: allowed.map(({ entry }) => entry), cursors: allowed.map(({ cursor }) => cursor),
      ...(last === undefined ? {} : { scannedThrough: last.cursor }) };
  }

  async latestEventCursor(tenant: TenantKey, _access: FoldSdkAccessContext,
    _options: { readonly includeDrafts?: boolean; readonly kinds?: readonly string[] }): Promise<FoldDeliveryCursor> {
    await this.sdkFor(tenant);
    return { version: 2, sequence: String((await this.stores.get(tenantStorageKey(tenant))!.read({ missing: "empty" })).entries.length) };
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

export class PostgresSdkRegistry implements FoldSdkRegistry {
  private readonly database: PostgresFoldDatabase;
  private readonly sdks = new Map<string, FoldSdk>();

  constructor(options: PostgresFoldDatabaseOptions) {
    this.database = new PostgresFoldDatabase(options);
  }

  open(): Promise<void> {
    return this.database.open();
  }

  async sdkFor(tenant: TenantKey): Promise<FoldSdk> {
    await this.open();
    const key = tenantStorageKey(tenant);
    let sdk = this.sdks.get(key);
    if (sdk === undefined) {
      sdk = new FoldSdk(this.database.store(tenant));
      this.sdks.set(key, sdk);
    }
    return sdk;
  }

  async streamEntries(
    tenant: TenantKey,
    access: FoldSdkAccessContext,
    options: {
      readonly after?: FoldConsumerCursor;
      readonly includeDrafts?: boolean;
      readonly kinds?: readonly string[];
      readonly limit: number;
    },
  ) {
    const page = await this.database.readEventPage(tenant, options);
    const allowed = page.entries.map((entry, index) => ({ entry, cursor: page.cursors[index]! }))
      .filter(({ entry }) => authorizeEventAccess(entry.event, access).allowed);
    return {
      entries: allowed.map(({ entry }) => entry), cursors: allowed.map(({ cursor }) => cursor),
      ...(page.scannedThrough === undefined ? {} : { scannedThrough: page.scannedThrough }),
    };
  }

  async latestEventCursor(tenant: TenantKey, _access: FoldSdkAccessContext,
    _options: { readonly includeDrafts?: boolean; readonly kinds?: readonly string[] }) {
    return this.database.latestDeliveryCursor(tenant);
  }

  close(): Promise<void> {
    return this.database.close();
  }

  consumerCursor(tenant: TenantKey, consumerId: string) {
    return this.database.consumerCursor(tenant, consumerId);
  }

  commitConsumerCursor(
    tenant: TenantKey,
    consumerId: string,
    cursor: FoldConsumerCursor,
  ) {
    return this.database.commitConsumerCursor(tenant, consumerId, cursor);
  }
}
