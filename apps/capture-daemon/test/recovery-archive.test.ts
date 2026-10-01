import { createCipheriv, randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { recoveryFile } from "../src/recovery-files.js";
import { verifyRecoveryArchive, writeRecoveryArchive, type RecoveryManifest } from "../src/recovery-archive.js";
async function fixture(){
  const root=await mkdtemp(join(tmpdir(),"recovery-archive-")),key=randomBytes(32),data=join(root,"input");await mkdir(data);
  await writeFile(join(data,"dump"),"synthetic database archive");await writeFile(join(data,"private"),Buffer.from([0,255,1,128]));
  const files=[await recoveryFile(join(data,"dump"),"database.dump"),await recoveryFile(join(data,"private"),"roots/vault/binary.bin")];
  const manifest:RecoveryManifest={version:1,id:"test-backup",createdAt:"2026-09-05T00:00:00.000Z",cutoffAt:"2026-09-05T00:00:00.000Z",database:{schema:"public",maxIngestionPosition:"42",snapshotId:"00000004-0000002B-1",protocolVersion:1},roots:[{id:"vault",machineId:"synthetic-host",kind:"vault",sourceRoot:data,writers:["capture"]}],keys:[],references:[{id:"safe-binary",rootId:"vault",path:"binary.bin",kind:"bytes",sha256:files[1]!.sha256}],coverage:"complete-declared-topology",exclusions:["browser-local optional telemetry excluded"],files:files.map(({source:_source,...file})=>file)};
  return {root,key,files,manifest};
}
it("authenticates and verifies every private file before exposing a recoverable staging result",async()=>{
  const f=await fixture(),archive=join(f.root,"backup.sbr");
  try{await writeRecoveryArchive(archive,f.manifest,f.files,f.key);const serialized=await readFile(archive);expect(serialized.includes(Buffer.from("synthetic database"))).toBe(false);expect(serialized.includes(Buffer.from("synthetic-host"))).toBe(false);
    const verified=await verifyRecoveryArchive(archive,f.key,join(f.root,"verified"));expect(verified.receipt).toMatchObject({integrity:"verified",files:2,coverage:"complete-declared-topology"});expect(await readFile(join(verified.staging,"roots/vault/binary.bin"))).toEqual(Buffer.from([0,255,1,128]));expect((await stat(verified.staging)).mode&0o777).toBe(0o700);await verified.cleanup();
  }finally{await rm(f.root,{recursive:true,force:true});}
});
it("rejects wrong keys, corruption and truncation and removes all unauthenticated staging",async()=>{
  const f=await fixture(),archive=join(f.root,"backup.sbr");
  try{await writeRecoveryArchive(archive,f.manifest,f.files,f.key);const bytes=await readFile(archive);
    for(const [id,content,key] of [["wrong",bytes,randomBytes(32)],["corrupt",Buffer.from(bytes),f.key],["truncated",bytes.subarray(0,bytes.length-10),f.key]] as const){if(id==="corrupt")content[content.length-1]=content[content.length-1]!^1;const input=join(f.root,`${id}.sbr`),stage=join(f.root,`${id}-staging`);await writeFile(input,content);await expect(verifyRecoveryArchive(input,key,stage)).rejects.toThrow();await expect(stat(stage)).rejects.toMatchObject({code:"ENOENT"});}
  }finally{await rm(f.root,{recursive:true,force:true});}
});
it("rejects a correctly authenticated archive with unsafe paths before creating an escaped file",async()=>{
  const f=await fixture();try{
    const iv=randomBytes(12),header=Buffer.from(`${JSON.stringify({format:"super-brain-private-recovery",version:1,algorithm:"aes-256-gcm",iv:iv.toString("base64")})}\n`),cipher=createCipheriv("aes-256-gcm",f.key,iv);cipher.setAAD(header);
    const manifest={...f.manifest,files:[{...f.manifest.files[0],path:"../escaped"}]};
    const encrypted=Buffer.concat([cipher.update(`${JSON.stringify({kind:"manifest",manifest})}\n${JSON.stringify({kind:"file",path:"../escaped"})}\n`),cipher.final()]);
    const archive=join(f.root,"unsafe.sbr");await writeFile(archive,Buffer.concat([header,encrypted,cipher.getAuthTag()]));await expect(verifyRecoveryArchive(archive,f.key,join(f.root,"stage"))).rejects.toThrow(/unsafe/);await expect(stat(join(f.root,"escaped"))).rejects.toMatchObject({code:"ENOENT"});
  }finally{await rm(f.root,{recursive:true,force:true});}
});
