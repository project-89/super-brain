import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface RecoveryFile { readonly path: string; readonly source: string; readonly bytes: number; readonly sha256: string; readonly mode: number }
export function assertRecoveryPath(path: string): void {
  if (typeof path !== "string" || path.length > 1024 || path.startsWith("/") || /[\\\x00-\x1f:]/.test(path) || path.split("/").some(part => part === "" || part === "." || part === "..")) throw new Error("Recovery manifest contains an unsafe path");
}
interface Ancestor { readonly path: string; readonly stat: Stats }
async function stableAncestors(ancestors: readonly Ancestor[]) {
  for (const ancestor of ancestors) {
    const current = await lstat(ancestor.path);
    if (!current.isDirectory() || current.dev !== ancestor.stat.dev || current.ino !== ancestor.stat.ino || current.ctimeMs !== ancestor.stat.ctimeMs || await realpath(ancestor.path) !== ancestor.path) throw new Error("Recovery source directory changed");
  }
}
export async function* recoveryFileChunks(path: string, options: { expected?: Pick<RecoveryFile,"bytes"|"sha256">; maxBytes?: number; signal?: AbortSignal; validate?:()=>Promise<void> } = {}): AsyncGenerator<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat(), maxBytes = options.maxBytes ?? 256*1024*1024;
    if (!before.isFile() || before.size > maxBytes || (options.expected !== undefined && before.size !== options.expected.bytes)) throw new Error("Recovery artifact exceeds bounds or changed size");
    await options.validate?.();
    const hash = createHash("sha256"); let offset = 0;
    while (offset < before.size) {
      if (options.signal?.aborted) throw new Error("Recovery canceled");
      const bytes = Buffer.alloc(Math.min(64*1024,before.size-offset)); const read = await file.read(bytes,0,bytes.length,offset);
      if (read.bytesRead === 0) throw new Error("Recovery artifact was truncated");
      offset += read.bytesRead; const chunk = bytes.subarray(0,read.bytesRead); hash.update(chunk); yield chunk;
    }
    const after = await file.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("Recovery artifact changed while reading");
    await options.validate?.();
    if (options.expected !== undefined && hash.digest("hex") !== options.expected.sha256) throw new Error("Recovery artifact checksum changed");
  } finally { await file.close(); }
}
export async function recoveryFile(path: string, logical: string): Promise<RecoveryFile> {
  assertRecoveryPath(logical); const hash=createHash("sha256"); let bytes=0;
  for await (const chunk of recoveryFileChunks(path)) { bytes+=chunk.length; hash.update(chunk); }
  const metadata=await lstat(path); if (!metadata.isFile()) throw new Error("Recovery artifact changed type");
  return {path:logical,source:path,bytes,sha256:hash.digest("hex"),mode:metadata.mode&0o777};
}
export async function recoveryInventory(rootInput: string, prefix: string, options: { skip?:(relative:string)=>Promise<boolean>; signal?:AbortSignal } = {}): Promise<RecoveryFile[]> {
  const root = await realpath(resolve(rootInput)); if (!(await lstat(rootInput)).isDirectory()) throw new Error("Recovery root must be a regular directory");
  const files:RecoveryFile[]=[]; let entries=0,total=0;
  const walk=async(relative:string, parents:readonly Ancestor[])=>{
    if (relative.split("/").length>32) throw new Error("Recovery source nesting exceeds bounds");
    const absolute=join(root,relative), metadata=await lstat(absolute); if(!metadata.isDirectory())throw new Error("Recovery source contains symlinks");
    const ancestors=[...parents,{path:absolute,stat:metadata}]; await stableAncestors(ancestors);
    const directory=await opendir(absolute);
    for await(const entry of directory){
      if(options.signal?.aborted)throw new Error("Recovery canceled");
      if(++entries>100_000)throw new Error("Recovery source entry limit exceeded");
      const path=relative?`${relative}/${entry.name}`:entry.name; assertRecoveryPath(path); await stableAncestors(ancestors);
      if(entry.isDirectory())await walk(path,ancestors);
      else if(entry.isFile()){
        if(await options.skip?.(path))continue;
        const source=join(root,path), expected=await lstat(source); const hash=createHash("sha256");let bytes=0;
        for await(const chunk of recoveryFileChunks(source,{...(options.signal===undefined?{}:{signal:options.signal}),validate:async()=>{
          await stableAncestors(ancestors);const current=await lstat(source);if(current.dev!==expected.dev||current.ino!==expected.ino)throw new Error("Recovery artifact was replaced");
        }})){bytes+=chunk.length;hash.update(chunk);}
        total+=bytes;if(total>4*1024*1024*1024)throw new Error("Recovery source byte limit exceeded");
        files.push({path:`${prefix}/${path}`,source,bytes,sha256:hash.digest("hex"),mode:expected.mode&0o777});
      }else throw new Error("Recovery source contains unsupported symlinks or special files");
    }
    await stableAncestors(ancestors);
  };
  await walk("",[]);return files.sort((a,b)=>a.path.localeCompare(b.path));
}
