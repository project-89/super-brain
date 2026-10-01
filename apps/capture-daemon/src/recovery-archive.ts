import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rm, type FileHandle } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { assertRecoveryPath, recoveryFile, recoveryFileChunks, type RecoveryFile } from "./recovery-files.js";
import { syncPrivateDirectory } from "./storage.js";
import type { PrivateWriterKind } from "@_89/super-brain-importer";

export interface RecoveryRoot {
  readonly id: string;
  readonly machineId: string;
  readonly kind: "capture-state" | "vault" | "worker-jobs" | "node-outbox" | "configuration" | "ingress";
  readonly sourceRoot: string;
  readonly writers: readonly PrivateWriterKind[];
}
export interface RecoveryKey { readonly id: string; readonly rootId: string; readonly path: string; readonly sha256: string }
export interface RecoveryReference {
  readonly id: string; readonly rootId: string; readonly path: string;
  readonly kind: "encrypted-json" | "encrypted-jsonl" | "bytes";
  readonly keyId?: string; readonly sha256?: string;
}
export interface RecoveryManifest {
  readonly version: 1;
  readonly id: string;
  readonly createdAt: string;
  readonly cutoffAt: string;
  readonly database: { readonly schema: string; readonly maxIngestionPosition: string; readonly snapshotId: string; readonly protocolVersion: 1 };
  readonly roots: readonly RecoveryRoot[];
  readonly keys: readonly RecoveryKey[];
  readonly references: readonly RecoveryReference[];
  readonly coverage: "complete-declared-topology" | "incomplete";
  readonly exclusions: readonly string[];
  readonly files: readonly Omit<RecoveryFile,"source">[];
}
export interface RecoveryVerificationReceipt {
  readonly version: 1;
  readonly kind: "super-brain-recovery-verification";
  readonly verifiedAt: string;
  readonly archiveSha256: string;
  readonly manifestSha256: string;
  readonly integrity: "verified";
  readonly coverage: RecoveryManifest["coverage"];
  readonly cutoffAt: string;
  readonly files: number;
  readonly bytes: number;
  readonly destination: "local" | "transferred";
}
const MAX_ARCHIVE=8*1024*1024*1024, MAX_FILE=256*1024*1024, MAX_FILES=100_000;
const canonical=(value:unknown):string=>JSON.stringify(value,(_key,item:unknown)=>item!==null&&typeof item==="object"&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a<b?-1:a>b?1:0)):item);
export const recoveryManifestDigest=(manifest:RecoveryManifest):string=>createHash("sha256").update(canonical(manifest)).digest("hex");
function assertManifest(value:unknown):asserts value is RecoveryManifest {
  const m=value as RecoveryManifest;
  if(!m||m.version!==1||typeof m.id!=="string"||!Number.isFinite(Date.parse(m.cutoffAt))||!Array.isArray(m.files)||m.files.length>MAX_FILES||!Array.isArray(m.roots)||m.roots.length>64||!Array.isArray(m.keys)||!Array.isArray(m.references)||m.references.length>MAX_FILES||!Array.isArray(m.exclusions)||!["complete-declared-topology","incomplete"].includes(m.coverage)||m.database?.protocolVersion!==1||!/^\w+$/.test(m.database.schema))throw new Error("Unsupported recovery manifest");
  const roots=new Set<string>(),paths=new Set<string>(); let bytes=0;
  for(const root of m.roots){if(!/^[a-z][a-z0-9-]{0,79}$/.test(root.id)||roots.has(root.id)||typeof root.machineId!=="string"||!Array.isArray(root.writers))throw new Error("Invalid recovery topology");roots.add(root.id);}
  for(const file of m.files){assertRecoveryPath(file.path);if(paths.has(file.path)||!Number.isSafeInteger(file.bytes)||file.bytes<0||file.bytes>MAX_FILE||!/^([a-f0-9]{64})$/.test(file.sha256)||!Number.isInteger(file.mode)||(file.mode&~0o777)!==0)throw new Error("Invalid recovery file manifest");paths.add(file.path);bytes+=file.bytes;}
  if(bytes>4*1024*1024*1024||!paths.has("database.dump"))throw new Error("Recovery manifest is incomplete or too large");
  const keys=new Set<string>();
  for(const key of m.keys){assertRecoveryPath(key.path);if(keys.has(key.id)||!roots.has(key.rootId)||!paths.has(`roots/${key.rootId}/${key.path}`)||!/^[a-f0-9]{64}$/.test(key.sha256))throw new Error("Invalid recovery key inventory");keys.add(key.id);}
  for(const ref of m.references){assertRecoveryPath(ref.path);if(!roots.has(ref.rootId)||!paths.has(`roots/${ref.rootId}/${ref.path}`)||!["encrypted-json","encrypted-jsonl","bytes"].includes(ref.kind)||(ref.kind!=="bytes"&&!keys.has(ref.keyId??"")))throw new Error("Unresolved private recovery dependency");}
  if(m.coverage==="complete-declared-topology"&&m.exclusions.some(item=>item.startsWith("unresolved:")))throw new Error("Incomplete topology cannot claim complete coverage");
}
async function writeAll(file:FileHandle,bytes:Buffer){let offset=0;while(offset<bytes.length){const result=await file.write(bytes,offset,bytes.length-offset);if(result.bytesWritten===0)throw new Error("Recovery output stalled");offset+=result.bytesWritten;}}
/** Caller must have sealed writers and pinned the canonical snapshot before constructing this inventory. */
export async function writeRecoveryArchive(path:string,manifest:RecoveryManifest,files:readonly RecoveryFile[],key:Uint8Array,signal?:AbortSignal):Promise<RecoveryFile>{
  assertManifest(manifest);if(key.length!==32)throw new Error("Recovery encryption requires a 32-byte key");
  if(canonical(files.map(({source:_source,...file})=>file))!==canonical(manifest.files))throw new Error("Recovery inventory differs from manifest");
  const output=await open(path,"wx",0o600),iv=randomBytes(12);
  const header=Buffer.from(`${JSON.stringify({format:"super-brain-private-recovery",version:1,algorithm:"aes-256-gcm",iv:iv.toString("base64")})}\n`);
  const cipher=createCipheriv("aes-256-gcm",key,iv);cipher.setAAD(header);let completed=false;
  const frame=async(value:unknown)=>{if(signal?.aborted)throw new Error("Recovery canceled");await writeAll(output,cipher.update(Buffer.from(`${canonical(value)}\n`)));};
  try {
    await writeAll(output,header);await frame({kind:"manifest",manifest});
    for(const file of files){await frame({kind:"file",path:file.path});for await(const bytes of recoveryFileChunks(file.source,{expected:file,...(signal===undefined?{}:{signal})}))await frame({kind:"data",data:bytes.toString("base64")});await frame({kind:"end",path:file.path});}
    await frame({kind:"complete",manifestSha256:recoveryManifestDigest(manifest)});await writeAll(output,cipher.final());await writeAll(output,cipher.getAuthTag());await output.sync();completed=true;
  } finally {await output.close();if(!completed)await rm(path,{force:true});}
  await syncPrivateDirectory(dirname(path));
  return recoveryFile(path,"recovery.sbr");
}
async function* plaintextLines(file:FileHandle,start:number,end:number,decipher:ReturnType<typeof createDecipheriv>,signal?:AbortSignal):AsyncGenerator<string>{
  let offset=start,pending=Buffer.alloc(0);
  const append=function*(chunk:Buffer):Generator<string>{pending=Buffer.concat([pending,chunk]);let newline:number;while((newline=pending.indexOf(10))>=0){if(newline>16*1024*1024)throw new Error("Recovery frame exceeds bounds");yield pending.subarray(0,newline).toString("utf8");pending=pending.subarray(newline+1);}if(pending.length>16*1024*1024)throw new Error("Recovery frame exceeds bounds");};
  while(offset<end){if(signal?.aborted)throw new Error("Recovery canceled");const bytes=Buffer.alloc(Math.min(64*1024,end-offset));const read=await file.read(bytes,0,bytes.length,offset);if(read.bytesRead!==bytes.length)throw new Error("Recovery archive truncated");offset+=read.bytesRead;yield*append(decipher.update(bytes));}
  yield*append(decipher.final());if(pending.length!==0)throw new Error("Recovery archive has an incomplete frame");
}
export interface VerifiedRecovery {readonly manifest:RecoveryManifest;readonly staging:string;readonly receipt:RecoveryVerificationReceipt;cleanup():Promise<void>}
/** Untrusted decrypted bytes remain in private staging until every frame and the final AEAD tag validate. */
export async function verifyRecoveryArchive(pathInput:string,key:Uint8Array,stagingInput:string,options:{signal?:AbortSignal;destination?:"local"|"transferred"}={}):Promise<VerifiedRecovery>{
  if(key.length!==32)throw new Error("Recovery encryption requires a 32-byte key");
  const staging=join(await realpath(dirname(resolve(stagingInput))),resolve(stagingInput).split("/").at(-1)!);
  await mkdir(staging,{mode:0o700});let succeeded=false;let current:FileHandle|undefined;
  const file=await open(pathInput,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK).catch(async error=>{await rm(staging,{recursive:true,force:true});throw error;});
  try {
    const before=await file.stat();if(!before.isFile()||before.size>MAX_ARCHIVE||before.size<100)throw new Error("Recovery archive is not a bounded regular file");
    const prefix=Buffer.alloc(Math.min(4096,before.size));await file.read(prefix,0,prefix.length,0);const newline=prefix.indexOf(10);if(newline<0)throw new Error("Recovery header is invalid");
    const header=prefix.subarray(0,newline+1),parsed=JSON.parse(header.toString("utf8")) as Record<string,unknown>;
    if(parsed.format!=="super-brain-private-recovery"||parsed.version!==1||parsed.algorithm!=="aes-256-gcm"||typeof parsed.iv!=="string")throw new Error("Unsupported recovery archive");
    const iv=Buffer.from(parsed.iv,"base64");if(iv.length!==12)throw new Error("Recovery nonce is invalid");
    const tag=Buffer.alloc(16);await file.read(tag,0,16,before.size-16);
    const decipher=createDecipheriv("aes-256-gcm",key,iv);decipher.setAAD(header);decipher.setAuthTag(tag);
    let manifest:RecoveryManifest|undefined,complete=false,index=0,currentBytes=0,currentHash=createHash("sha256");
    for await(const line of plaintextLines(file,header.length,before.size-16,decipher,options.signal)){
      const frame=JSON.parse(line) as {kind?:unknown;manifest?:unknown;path?:unknown;data?:unknown;manifestSha256?:unknown};
      if(complete)throw new Error("Recovery archive contains trailing frames");
      if(manifest===undefined){if(frame.kind!=="manifest")throw new Error("Recovery manifest must be first");assertManifest(frame.manifest);manifest=frame.manifest;continue;}
      if(frame.kind==="file"){
        if(current!==undefined||frame.path!==manifest.files[index]?.path)throw new Error("Recovery file order or identity is invalid");
        const path=join(staging,frame.path as string);await mkdir(dirname(path),{recursive:true,mode:0o700});current=await open(path,"wx",0o600);currentBytes=0;currentHash=createHash("sha256");
      }else if(frame.kind==="data"){
        if(current===undefined||typeof frame.data!=="string"||frame.data.length>90_000||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.data))throw new Error("Recovery data frame is invalid");
        const bytes=Buffer.from(frame.data,"base64");currentBytes+=bytes.length;if(currentBytes>manifest.files[index]!.bytes)throw new Error("Recovery data exceeds declared size");currentHash.update(bytes);await writeAll(current,bytes);
      }else if(frame.kind==="end"){
        const expected=manifest.files[index];if(current===undefined||expected===undefined||frame.path!==expected.path||currentBytes!==expected.bytes||currentHash.digest("hex")!==expected.sha256)throw new Error("Recovery file integrity failed");await current.sync();await current.close();current=undefined;index+=1;
      }else if(frame.kind==="complete"){
        if(current!==undefined||index!==manifest.files.length||frame.manifestSha256!==recoveryManifestDigest(manifest))throw new Error("Recovery archive is incomplete");complete=true;
      }else throw new Error("Unknown recovery frame");
    }
    const after=await file.stat(),currentPath=await lstat(pathInput);
    if(!complete||manifest===undefined||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||before.dev!==currentPath.dev||before.ino!==currentPath.ino)throw new Error("Recovery archive changed or is incomplete");
    const digest=createHash("sha256");for await(const bytes of recoveryFileChunks(pathInput,{maxBytes:MAX_ARCHIVE,...(options.signal===undefined?{}:{signal:options.signal})}))digest.update(bytes);
    const receipt:RecoveryVerificationReceipt={version:1,kind:"super-brain-recovery-verification",verifiedAt:new Date().toISOString(),archiveSha256:digest.digest("hex"),manifestSha256:recoveryManifestDigest(manifest),integrity:"verified",coverage:manifest.coverage,cutoffAt:manifest.cutoffAt,files:manifest.files.length,bytes:manifest.files.reduce((sum,item)=>sum+item.bytes,0),destination:options.destination??"local"};
    succeeded=true;return{manifest,staging,receipt,cleanup:()=>rm(staging,{recursive:true,force:true})};
  } finally {await current?.close();await file.close();if(!succeeded)await rm(staging,{recursive:true,force:true});}
}
