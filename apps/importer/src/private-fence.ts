/** Node-only cooperative exclusion for every enrolled private-state writer. */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, stat, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export type PrivateWriterKind = "capture" | "hook-relay" | "importer" | "worker-jobs" | "worker-status" | "node-outbox" | "configuration";
export interface PrivateRootDeclaration { readonly root: string; readonly writers: readonly PrivateWriterKind[] }
interface Owner { readonly version: 1; readonly pid: number; readonly token: string }
interface WriteScope { accepting: boolean; references: number; drained?: () => void }
const held = new AsyncLocalStorage<ReadonlyMap<string, WriteScope>>();
function releaseReference(scope: WriteScope) { scope.references -= 1; if (scope.references === 0) scope.drained?.(); }
async function reentrant<T>(scope: WriteScope, work: () => Promise<T>): Promise<T> {
  scope.references += 1; try { return await work(); } finally { releaseReference(scope); }
}
const WRITERS: readonly string[] = ["capture","hook-relay","importer","worker-jobs","worker-status","node-outbox","configuration"];
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
export class PrivateRootSealedError extends Error { constructor() { super("Private storage is sealed for recovery"); this.name = "PrivateRootSealedError"; } }
export async function canonicalPrivateRoot(root: string): Promise<string> {
  await mkdir(root, { recursive: true, mode: 0o700 }); return realpath(root);
}
function controls(root: string): string { return join(dirname(root), ".super-brain-private-fences", createHash("sha256").update(root).digest("hex")); }
async function sync(directory: string) { const file = await open(directory, constants.O_RDONLY); try { await file.sync(); } finally { await file.close(); } }
async function writeExclusive(path: string, value: unknown) {
  const file = await open(path, "wx", 0o600); try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
  await sync(dirname(path));
}
async function readMetadata(path: string): Promise<unknown | undefined> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(error => { if (isMissing(error)) return undefined; throw error; });
  if (file === undefined) return undefined;
  try {
    const before = await file.stat(); if (!before.isFile() || before.size > 16_384) throw new Error("Private writer metadata is invalid");
    const bytes = Buffer.alloc(before.size); let offset = 0;
    while (offset < bytes.length) { const read = await file.read(bytes,offset,bytes.length-offset,offset); if (read.bytesRead === 0) break; offset += read.bytesRead; }
    const after = await file.stat(); if (offset !== bytes.length || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error("Private writer metadata changed");
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } finally { await file.close(); }
}
async function readOwner(path: string): Promise<Owner | undefined> {
  const owner = await readMetadata(path) as Owner | undefined; if (owner === undefined) return undefined;
  if (owner.version !== 1 || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || typeof owner.token !== "string" || owner.token.length > 100) throw new Error("Private writer lease is invalid");
  return owner;
}
function alive(owner: Owner) {
  try { process.kill(owner.pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
}
async function removeOwned(path: string, owner: Owner) {
  const actual = await readOwner(path); if (actual === undefined) return;
  if (actual.pid !== owner.pid || actual.token !== owner.token) throw new Error("Private writer ownership changed");
  await unlink(path); await sync(dirname(path));
}
/** The lock excludes registration and seal publication, eliminating check-then-write races. */
export async function withPrivateFilesystemMutex<T>(directoryInput: string, work: () => Promise<T>, timeoutMs = 5_000): Promise<T> {
  await mkdir(directoryInput, { recursive: true, mode: 0o700 }); const directory = await realpath(directoryInput);
  const metadata = await lstat(directoryInput);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || directory !== resolve(directoryInput) || (metadata.mode & 0o077) !== 0 || (process.getuid !== undefined && metadata.uid !== process.getuid())) throw new Error("Private writer control directory must be a private physical directory");
  const lock = join(directory, "mutex.json"), owner: Owner = { version: 1, pid: process.pid, token: randomUUID() };
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { await writeExclusive(lock, owner); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // A separate exclusive reaper prevents two stale observers from removing a new owner's lock.
      const previous = await readOwner(lock).catch(() => undefined);
      if (previous !== undefined && !alive(previous)) {
        const reaper = join(directory, "reaper.json");
        try { await writeExclusive(reaper, owner); }
        catch (reaperError) { if ((reaperError as NodeJS.ErrnoException).code !== "EEXIST") throw reaperError; if (Date.now() >= deadline) throw new Error("Private writer stale recovery needs attention"); await pause(10); continue; }
        try { const current = await readOwner(lock); if (current?.token === previous.token && !alive(current)) await removeOwned(lock, previous); }
        finally { await removeOwned(reaper, owner); }
        continue;
      }
      if (Date.now() >= deadline) throw new Error("Private writer exclusion timed out; inspect live or incomplete lease");
      await pause(10);
    }
  }
  try { return await work(); } finally { await removeOwned(lock, owner); }
}

export async function withPrivateRootWrite<T>(rootInput: string, kind: PrivateWriterKind, work: () => Promise<T>): Promise<T> {
  if (!WRITERS.includes(kind)) throw new Error("Unsupported private writer protocol");
  const physicalRoot = await canonicalPrivateRoot(rootInput);
  // Key/status helpers may target a child directory. Reuse an enrolled ancestor's
  // fence so a nested writer cannot bypass a seal on the declared storage root.
  let root = physicalRoot;
  for (let ancestor = dirname(physicalRoot); ancestor !== dirname(ancestor); ancestor = dirname(ancestor)) {
    if (held.getStore()?.get(ancestor)?.accepting || await readMetadata(join(controls(ancestor),"root-protocol.json")) !== undefined) root = ancestor;
  }
  const inherited = held.getStore()?.get(root);
  if (inherited?.accepting) return reentrant(inherited, work);
  const directory = controls(root), owner: Owner = { version: 1, pid: process.pid, token: randomUUID() };
  const claim = join(directory, `writer-${owner.token}.json`);
  await withPrivateFilesystemMutex(directory, async () => {
    const seal = await readOwner(join(directory, "seal.json"));
    if (seal !== undefined) { if (alive(seal)) throw new PrivateRootSealedError(); await removeOwned(join(directory, "seal.json"), seal); }
    const provenance = join(directory, "root-protocol.json");
    if (await readMetadata(provenance) === undefined) {
      const metadata = await stat(root), empty = (await readdir(root)).length === 0;
      // First upgraded writer cannot certify old data/writers merely by creating a marker.
      await writeExclusive(provenance, { version: 1, provenance: empty ? "fresh-root" : "legacy-uncoordinated", dev: metadata.dev, ino: metadata.ino });
    }
    const registration = join(directory, `${kind}.registered.json`);
    await writeExclusive(registration, { version: 1, kind }).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
    await writeExclusive(claim, owner);
  });
  const scope: WriteScope = { accepting: true, references: 1 };
  try { return await held.run(new Map([...(held.getStore() ?? []), [root, scope]]), work); }
  finally {
    scope.accepting = false; releaseReference(scope);
    if (scope.references > 0) await new Promise<void>(resolve => { scope.drained = resolve; });
    await removeOwned(claim, owner);
  }
}
export async function withPrivateRootWrites<T>(roots: readonly string[], kind: PrivateWriterKind, work: () => Promise<T>): Promise<T> {
  const canonical = [...new Set(await Promise.all(roots.map(canonicalPrivateRoot)))].sort();
  const enter = (index: number): Promise<T> => index === canonical.length ? work() : withPrivateRootWrite(canonical[index]!, kind, () => enter(index + 1));
  return enter(0);
}
export interface PrivateRootSeal {
  readonly version: 1; readonly id: string; readonly observedAt: string;
  readonly roots: readonly { readonly root: string; readonly writers: readonly PrivateWriterKind[] }[];
  release(): Promise<void>;
}
/** Seal all declared roots, then wait for their already-registered writes to settle before database backup. */
export async function sealPrivateRoots(declarations: readonly PrivateRootDeclaration[], options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<PrivateRootSeal> {
  if (declarations.some(item => item.writers.some(kind => !WRITERS.includes(kind)))) throw new Error("Unsupported recovery writer protocol");
  const roots = await Promise.all(declarations.map(async item => ({ ...item, root: await canonicalPrivateRoot(item.root) })));
  roots.sort((a,b) => a.root.localeCompare(b.root));
  if (roots.length === 0 || roots.length > 32 || roots.some((item,index) => roots.some((other,otherIndex) => index !== otherIndex && (item.root === other.root || item.root.startsWith(`${other.root}/`))))) throw new Error("Recovery roots must be distinct and non-nested, including path aliases");
  const owner: Owner = { version: 1, pid: process.pid, token: randomUUID() }, sealed: string[] = [];
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  const release = async () => { for (const root of [...sealed].reverse()) await withPrivateFilesystemMutex(controls(root), () => removeOwned(join(controls(root), "seal.json"), owner)); sealed.length = 0; };
  try {
    for (const item of roots) await withPrivateFilesystemMutex(controls(item.root), async () => {
      const directory = controls(item.root);
      const provenance = await readMetadata(join(directory,"root-protocol.json")) as {version?: unknown;provenance?: unknown;dev?: unknown;ino?: unknown} | undefined;
      const metadata = await stat(item.root);
      if (provenance?.version !== 1 || provenance.provenance !== "fresh-root" || provenance.dev !== metadata.dev || provenance.ino !== metadata.ino) throw new Error("Recovery requires a freshly enrolled or verified restored root; legacy writers are unsupported");
      const registrations = (await readdir(directory)).filter(name => name.endsWith(".registered.json")).map(name => name.slice(0,-".registered.json".length));
      if (registrations.some(kind => !(item.writers as readonly string[]).includes(kind))) throw new Error("Recovery declaration omits an enrolled writer");
      for (const writer of item.writers) {
        const registration = await readMetadata(join(directory, `${writer}.registered.json`)) as {version?: unknown;kind?: unknown} | undefined;
        if (registration?.version !== 1 || registration.kind !== writer) throw new Error("Recovery writer registration is unsupported");
      }
      if (item.writers.length === 0) throw new Error("Recovery requires declared enrolled writer coverage");
      const sealPath = join(directory,"seal.json"), previous = await readOwner(sealPath);
      if (previous !== undefined) { if (alive(previous)) throw new PrivateRootSealedError(); await removeOwned(sealPath,previous); }
      await writeExclusive(sealPath,owner); sealed.push(item.root);
    });
    for (;;) {
      if (options.signal?.aborted) throw new Error("Recovery writer seal canceled");
      let pending = 0;
      for (const root of sealed) {
        const directory = controls(root);
        for (const name of await readdir(directory)) if (/^writer-[a-z0-9-]+\.json$/.test(name)) {
          const path = join(directory,name), claim = await readOwner(path); if (claim === undefined) continue;
          if (alive(claim)) pending += 1; else await removeOwned(path,claim);
        }
      }
      if (pending === 0) break;
      if (Date.now() >= deadline) throw new Error("Recovery writer drain timed out");
      await pause(10);
    }
    return { version: 1,id: owner.token,observedAt:new Date().toISOString(),roots,release };
  } catch (error) { await release(); throw error; }
}
