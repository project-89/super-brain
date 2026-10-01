import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { canonicalPrivateRoot, decryptVaultLine, encryptVaultLine, withPrivateFilesystemMutex } from "@_89/super-brain-importer";
import { readBoundedPrivateText, syncPrivateDirectory } from "./storage.js";
import type { HookOccurrence } from "./receipts.js";
import type { HookAuthority } from "./types.js";

export interface DeferredIngress {
  readonly version: 1;
  readonly kind: "sender" | "receiver";
  readonly occurrence: HookOccurrence;
  readonly authority?: HookAuthority;
  readonly receivedAt?: string;
  readonly tenant?: { readonly organizationId: string; readonly workspaceId: string; readonly sensorId: string };
}
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const recordName = (record: DeferredIngress) => `${record.kind}-${digest(record.occurrence.id)}.json.enc`;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
function recordIdentity(record: DeferredIngress) {
  return JSON.stringify([record.version, record.kind, record.occurrence.id, record.occurrence.source,
    record.occurrence.endpoint, record.occurrence.payload, record.authority, record.tenant]);
}

/** The ingress root is deliberately outside sealed state. Rotation, acknowledgement, and append share one mutex. */
export class CaptureIngressJournal {
  constructor(private readonly stateRoot: string, private readonly key: Uint8Array) {}
  async root(): Promise<string> {
    const root = `${await canonicalPrivateRoot(this.stateRoot)}.ingress`;
    await mkdir(root, { recursive: true, mode: 0o700 });
    const metadata = await lstat(root);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0 || await realpath(root) !== root) throw new Error("Ingress root must be a private physical directory");
    return root;
  }
  private async directories(root: string): Promise<string[]> {
    const generations = await readdir(join(root, "sealed")).catch(error => { if (missing(error)) return []; throw error; });
    if (generations.length > 1_000 || generations.some(name => !/^[a-f0-9-]{36}$/.test(name))) throw new Error("Ingress generation inventory is invalid or requires retention");
    return [join(root,"pending"), ...generations.sort().map(name => join(root,"sealed",name))];
  }
  private async read(path: string): Promise<DeferredIngress> {
    const encrypted = (await readBoundedPrivateText(path, 8 * 1024 * 1024, {requireOwnerOnly:true})).trim();
    if ((JSON.parse(encrypted) as {$superBrainEncrypted?:unknown}).$superBrainEncrypted !== 1) throw new Error("Ingress requires authenticated encryption");
    const record = JSON.parse(decryptVaultLine(encrypted,this.key)) as DeferredIngress;
    if (record.version !== 1 || !["sender","receiver"].includes(record.kind) || typeof record.occurrence?.id !== "string" || record.occurrence.id.length > 200) throw new Error("Ingress record is invalid");
    return record;
  }
  async append(record: DeferredIngress): Promise<DeferredIngress> {
    const root = await this.root();
    return withPrivateFilesystemMutex(root, async () => {
      for (const directory of await this.directories(root)) {
        const existing = await this.read(join(directory,recordName(record))).catch(error => { if(missing(error)) return undefined; throw error; });
        if (existing !== undefined) {
          if (recordIdentity(existing) !== recordIdentity(record)) throw new TypeError("receipt ID was reused for different deferred evidence or authority");
          return existing;
        }
      }
      const directory = join(root,"pending"); await mkdir(directory,{recursive:true,mode:0o700});
      const temporary = join(directory,`.${randomUUID()}.tmp`), target = join(directory,recordName(record));
      const output = await open(temporary,"wx",0o600);
      try {
        const encrypted = `${encryptVaultLine(JSON.stringify(record),this.key)}\n`;
        if (Buffer.byteLength(encrypted) > 8 * 1024 * 1024) throw new Error("Ingress record exceeds capture limits");
        await output.writeFile(encrypted); await output.sync(); await output.close();
        await link(temporary,target); await syncPrivateDirectory(directory); await syncPrivateDirectory(root);
      } finally { await output.close().catch(()=>undefined); await unlink(temporary).catch(()=>undefined); }
      return record;
    });
  }
  /** One short rotation defines which acknowledged ingress belongs to this backup. New arrivals use fresh pending/. */
  async rotate(barrierId: string): Promise<{root:string;generations:readonly string[];cutoffAt:string}> {
    if (!/^[a-f0-9-]{36}$/.test(barrierId)) throw new Error("Invalid recovery boundary ID");
    const root = await this.root();
    return withPrivateFilesystemMutex(root,async()=>{
      await mkdir(join(root,"sealed"),{recursive:true,mode:0o700});
      await mkdir(join(root,"pending"),{recursive:true,mode:0o700});
      await rename(join(root,"pending"),join(root,"sealed",barrierId));
      await mkdir(join(root,"pending"),{mode:0o700});
      await syncPrivateDirectory(join(root,"sealed")); await syncPrivateDirectory(root);
      return {root,generations:(await this.directories(root)).slice(1),cutoffAt:new Date().toISOString()};
    });
  }
  async pending(kind: DeferredIngress["kind"]): Promise<readonly DeferredIngress[]> {
    const root = await this.root();
    return withPrivateFilesystemMutex(root,async()=>{
      const output: DeferredIngress[] = [];
      for (const directory of await this.directories(root)) {
        const names=await readdir(directory).catch(error=>{if(missing(error))return [];throw error;});
        if(names.length>100_000)throw new Error("Ingress backlog exceeds bounded inventory");
        for(const name of names) if(name.startsWith(`${kind}-`) && /^[a-z]+-[a-f0-9]{64}\.json\.enc$/.test(name)) output.push(await this.read(join(directory,name)));
      }
      return output.sort((a,b)=>a.occurrence.occurredAt.localeCompare(b.occurrence.occurredAt)||a.occurrence.id.localeCompare(b.occurrence.id));
    });
  }
  async acknowledge(record: DeferredIngress): Promise<void> {
    const root=await this.root();
    await withPrivateFilesystemMutex(root,async()=>{
      for(const directory of await this.directories(root)) {
        const path=join(directory,recordName(record));
        const current=await this.read(path).catch(error=>{if(missing(error))return undefined;throw error;});
        if(current===undefined)continue;
        if(recordIdentity(current)!==recordIdentity(record))throw new Error("Ingress identity changed before acknowledgement");
        await unlink(path); await syncPrivateDirectory(directory);
      }
    });
  }
}
