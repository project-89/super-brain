import { createHash, randomUUID } from "node:crypto";
import { chmod, link, mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { decryptVaultLine, encryptVaultLine, ensureVaultKey, readVaultKey, redactJsonValue } from "@_89/super-brain-importer";
import { secureDirectory, syncPrivateDirectory } from "./storage.js";
import type { CaptureEngine } from "./capture.js";
import type { CaptureConfig, CaptureState, HookAuthority, HookSource, SpoolJob, VaultArtifact } from "./types.js";

export interface HookOccurrence {
  readonly version: 1;
  readonly id: string;
  readonly source: HookSource;
  readonly occurredAt: string;
  readonly payload: Record<string, unknown>;
  readonly endpoint: "/hook" | "/checkpoint" | "/decision";
}
export interface CaptureReceipt {
  readonly version: 1;
  readonly occurrence: HookOccurrence;
  readonly tenant?: { readonly organizationId: string; readonly workspaceId: string };
  readonly fingerprint: string;
  readonly receivedAt: string;
  readonly artifact: VaultArtifact;
  readonly authority?: HookAuthority;
  readonly status: "accepted" | "prepared" | "completed" | "rejected";
  readonly eventDigests?: Readonly<Record<string, string>>;
  readonly prepared?: { readonly state: CaptureState; readonly jobs: readonly SpoolJob[] };
  readonly failure?: { readonly attempts: number; readonly lastAttemptAt: string; readonly message: string };
}

/** Atomic, synced, encrypted files. Exclusive publication handles concurrent relay processes. */
async function writeProtected(path: string, value: unknown, key: Uint8Array, exclusive = false): Promise<boolean> {
  await secureDirectory(dirname(path));
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(`${encryptVaultLine(JSON.stringify(value), key)}\n`, "utf8");
    await file.sync();
    await file.close();
    if (exclusive) {
      try { await link(temporary, path); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw error;
      }
    } else await rename(temporary, path);
    await syncPrivateDirectory(dirname(path));
    return true;
  } finally {
    await file.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

export function capturedEventDigest(value: unknown): string {
  return hash(JSON.stringify(value, (_key, item: unknown) => item !== null && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right))) : item));
}

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const filename = (id: string): string => `${hash(id)}.json.enc`;

export async function receiptEncryptionKey(config: CaptureConfig): Promise<Uint8Array> {
  return config.vaultKeyPath === undefined
    ? (await ensureVaultKey(join(config.stateRoot, "receipts.key"))).key
    : readVaultKey(config.vaultKeyPath);
}

export class HookOutbox {
  private readonly root: string;
  constructor(stateRoot: string, private readonly key: Uint8Array, private readonly retainEncryptedReasoning = false) { this.root = join(stateRoot, "receipts", "sender"); }
  async persist(source: HookSource, payload: Record<string, unknown>, endpoint: HookOccurrence["endpoint"] = "/hook", id: string = randomUUID()): Promise<HookOccurrence> {
    const occurrence: HookOccurrence = { version: 1, id, source, endpoint, occurredAt: new Date().toISOString(),
      payload: redactJsonValue(payload, { retainEncryptedContent: this.retainEncryptedReasoning }).value as Record<string, unknown> };
    const path = join(this.root, filename(id));
    if (await writeProtected(path, occurrence, this.key, true)) return occurrence;
    const existing = await this.read(path);
    if (JSON.stringify([existing.source, existing.endpoint, existing.payload]) !== JSON.stringify([source, endpoint, occurrence.payload])) throw new Error("receipt ID was reused for a different occurrence");
    return existing;
  }
  private async read(path: string): Promise<HookOccurrence> { return JSON.parse(decryptVaultLine((await readFile(path, "utf8")).trim(), this.key)) as HookOccurrence; }
  async pending(): Promise<readonly HookOccurrence[]> {
    let names: string[];
    try { names = await readdir(this.root); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const values = await Promise.all(names.filter((name) => name.endsWith(".json.enc")).map(async (name) => {
      try { return await this.read(join(this.root, name)); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    }));
    return values.filter((value): value is HookOccurrence => value !== undefined).sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id));
  }
  async acknowledge(id: string): Promise<void> {
    try { await unlink(join(this.root, filename(id))); await syncPrivateDirectory(this.root); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

export async function deliverOccurrence(config: CaptureConfig, outbox: HookOutbox, occurrence: HookOccurrence, fetchImpl = fetch): Promise<void> {
  const response = await fetchImpl(`http://${config.bindHost}:${config.port}${occurrence.endpoint}`, {
    method: "POST", headers: { "content-type": "application/json", "x-agent-source": occurrence.source,
      "x-super-brain-receipt-id": occurrence.id, "x-super-brain-occurred-at": occurrence.occurredAt,
      ...(occurrence.endpoint === "/decision" ? { "x-super-brain-operator-token": config.operatorToken } : { "x-super-brain-hook-token": config.hookToken }) },
    body: JSON.stringify(occurrence.payload), signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) throw new Error(`capture daemon rejected receipt with HTTP ${response.status}`);
  const result = await response.json() as { accepted?: unknown; receiptId?: unknown };
  if (result.accepted !== true || result.receiptId !== occurrence.id) throw new Error("capture acknowledgement does not match durable receipt");
  await outbox.acknowledge(occurrence.id);
}

/** Receiver write-ahead records stay until explicit retention maintenance; retries never depend on a time window. */
export class CaptureReceiptQueue {
  private readonly root: string;
  private acceptanceChain: Promise<unknown> = Promise.resolve();
  private processing: Promise<void> | undefined;
  private lastError: string | undefined;
  private lastEventTime = -1;
  private initialization: Promise<void> | undefined;
  constructor(private readonly engine: CaptureEngine, private readonly key: Uint8Array) { this.root = join(engine.config.stateRoot, "receipts", "receiver"); }
  private path(id: string): string { return join(this.root, filename(id)); }
  private async read(id: string): Promise<CaptureReceipt | undefined> {
    for (const path of [this.path(id), join(this.root, "completed", filename(id)), join(this.root, "rejected", filename(id))]) {
      try { return JSON.parse(decryptVaultLine((await readFile(path, "utf8")).trim(), this.key)) as CaptureReceipt; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    return undefined;
  }
  async list(): Promise<readonly CaptureReceipt[]> {
    let names: string[];
    try { names = await readdir(this.root); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const receipts = await Promise.all(names.filter((name) => name.endsWith(".json.enc")).map(async (name) =>
      JSON.parse(decryptVaultLine((await readFile(join(this.root, name), "utf8")).trim(), this.key)) as CaptureReceipt));
    const pending: CaptureReceipt[] = [];
    for (const receipt of receipts) {
      try {
        await readFile(join(this.root, "completed", filename(receipt.occurrence.id)), "utf8");
        await unlink(this.path(receipt.occurrence.id)).catch(() => undefined);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        pending.push(receipt);
      }
    }
    return pending.sort((a, b) => a.artifact.eventTime - b.artifact.eventTime || a.occurrence.id.localeCompare(b.occurrence.id));
  }
  initialize(): Promise<void> {
    return this.initialization ??= this.list().then((receipts) => {
      this.lastEventTime = Math.max(this.engine.eventWatermark(), ...receipts.map((receipt) => receipt.artifact.eventTime));
    });
  }
  accept(occurrence: HookOccurrence, authority?: HookAuthority): Promise<{ readonly accepted: true; readonly receiptId: string; readonly artifactId: string }> {
    const operation = this.acceptanceChain.then(async () => {
      await this.initialize();
      if (occurrence.id.length === 0 || occurrence.id.length > 200) throw new TypeError("receipt ID must contain 1 to 200 characters");
      const protectedPayload = redactJsonValue(occurrence.payload, { retainEncryptedContent: this.engine.config.reasoningPolicy === "include" && this.engine.config.retainEncryptedReasoning }).value as Record<string, unknown>;
      const fingerprint = hash(JSON.stringify([occurrence.source, occurrence.endpoint, protectedPayload, authority?.kind, authority?.principalId]));
      const existing = await this.read(occurrence.id);
      if (existing !== undefined) {
        if (existing.fingerprint !== fingerprint) throw new TypeError("receipt ID was reused for different evidence or authority");
        return { accepted: true as const, receiptId: occurrence.id, artifactId: existing.artifact.id };
      }
      const receivedAt = new Date().toISOString();
      this.lastEventTime = Math.max(Date.now(), this.lastEventTime + 1, this.engine.eventWatermark() + 1);
      const artifact = await this.engine.vault.store(occurrence.source, protectedPayload, this.lastEventTime, { receiptId: occurrence.id, ...(authority === undefined ? {} : { authority }) });
      const receipt: CaptureReceipt = { version: 1, tenant: { organizationId: this.engine.config.organizationId, workspaceId: this.engine.config.workspaceId }, occurrence: { ...occurrence, payload: protectedPayload }, fingerprint,
        receivedAt, artifact, status: "accepted", ...(authority === undefined ? {} : { authority }) };
      await writeProtected(this.path(occurrence.id), receipt, this.key, true);
      return { accepted: true as const, receiptId: occurrence.id, artifactId: artifact.id };
    });
    this.acceptanceChain = operation.catch(() => undefined);
    return operation;
  }
  start(): void {
    if (this.processing === undefined) this.processing = this.drain().catch((error: unknown) => {
      this.lastError = error instanceof Error ? error.message : "receipt queue unavailable";
    }).finally(() => { this.processing = undefined; });
  }
  async snapshot(): Promise<{ accepted: number; completed: number; rejected: number; failed: number; lastError?: string }> {
    const receipts = await this.list();
    const completed = await readdir(join(this.root, "completed")).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
    const rejected = await readdir(join(this.root, "rejected")).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
    return { accepted: receipts.length, completed: completed.filter((name) => name.endsWith(".json.enc")).length,
      rejected: rejected.filter((name) => name.endsWith(".json.enc")).length, failed: receipts.filter((r) => r.failure !== undefined).length, ...(this.lastError === undefined ? {} : { lastError: this.lastError }) };
  }
  async restorePrepared(): Promise<void> {
    for (const receipt of await this.list()) {
      this.lastEventTime = Math.max(this.lastEventTime, receipt.artifact.eventTime);
      if (receipt.status !== "prepared") continue;
      await this.engine.processReceipt(receipt, async () => { throw new Error("prepared receipt has no commit record"); });
      await this.complete(receipt);
    }
  }
  private async complete(receipt: CaptureReceipt): Promise<void> {
    const latest = receipt.prepared === undefined ? await this.read(receipt.occurrence.id) ?? receipt : receipt;
    const { prepared, failure: _failure, ...completed } = latest;
    const eventDigests = Object.fromEntries((prepared?.jobs ?? []).flatMap((job) => job.kind === "event" ? [[job.event.id, capturedEventDigest(job.event)]] : []));
    await writeProtected(join(this.root, "completed", filename(receipt.occurrence.id)), {
      ...completed, eventDigests, occurrence: { ...completed.occurrence, payload: {} }, status: "completed",
    }, this.key);
    await unlink(this.path(receipt.occurrence.id));
    await syncPrivateDirectory(this.root);
  }
  async idle(): Promise<void> { await this.processing; }
  async drain(): Promise<void> {
    const receipts = await this.list();
    for (const receipt of receipts) {
      this.lastEventTime = Math.max(this.lastEventTime, receipt.artifact.eventTime);
      if (receipt.status === "completed") continue;
      try {
        await this.engine.processReceipt(receipt, async (prepared) => {
          await writeProtected(this.path(receipt.occurrence.id), { ...receipt, status: "prepared", prepared }, this.key);
        });
        await this.complete(receipt);
      } catch (error) {
        const latest = await this.read(receipt.occurrence.id) ?? receipt;
        await writeProtected(this.path(receipt.occurrence.id), { ...latest, failure: { attempts: (latest.failure?.attempts ?? 0) + 1,
          lastAttemptAt: new Date().toISOString(), message: error instanceof Error ? error.message.slice(0, 300) : "capture processing failed" } }, this.key);
        if (error instanceof TypeError && latest.status === "accepted") {
          const rejected = await this.read(receipt.occurrence.id);
          await writeProtected(join(this.root, "rejected", filename(receipt.occurrence.id)), { ...rejected, status: "rejected" }, this.key);
          await unlink(this.path(receipt.occurrence.id));
          await syncPrivateDirectory(this.root);
          continue;
        }
        // Preserve capture order across retryable pre-commit failures as well as prepared commits.
        break;
      }
    }
  }
}

/** Read only authenticated completion witnesses. Plain JSON at an .enc path is not evidence. */
export async function readCompletedCaptureReceipt(options: {
  readonly stateRoot: string;
  readonly receiptId: string;
  readonly encryptionKey: Uint8Array;
}): Promise<CaptureReceipt | undefined> {
  let encrypted: string;
  try { encrypted = (await readFile(join(options.stateRoot, "receipts", "receiver", "completed", filename(options.receiptId)), "utf8")).trim(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  const envelope = JSON.parse(encrypted) as { $superBrainEncrypted?: unknown };
  if (envelope.$superBrainEncrypted !== 1) throw new TypeError("capture witness is not authenticated encrypted evidence");
  const receipt = JSON.parse(decryptVaultLine(encrypted, options.encryptionKey)) as CaptureReceipt;
  if (receipt.version !== 1 || receipt.status !== "completed" || receipt.occurrence?.id !== options.receiptId) throw new TypeError("capture witness receipt identity is invalid");
  return receipt;
}
