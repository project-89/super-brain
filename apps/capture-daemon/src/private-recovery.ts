import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { withRecoveryBarrier, readRecoveryEventPages } from "@_89/fold-postgres";
import { decryptVaultLine, parseVaultKey, readVaultKey, sealPrivateRoots, withPrivateRootWrite } from "@_89/super-brain-importer";
import { CaptureIngressJournal } from "./ingress.js";
import { receiptEncryptionKey } from "./receipts.js";
import { assertRecoveryPath, recoveryFile, recoveryFileChunks, recoveryInventory, type RecoveryFile } from "./recovery-files.js";
import { verifyRecoveryArchive, writeRecoveryArchive, type RecoveryKey, type RecoveryManifest, type RecoveryReference, type RecoveryRoot, type RecoveryVerificationReceipt } from "./recovery-archive.js";
import { runRecoveryPostgres } from "./recovery-process.js";
import { backupTelemetrySqlite } from "./recovery-sqlite.js";
import { readBoundedPrivateText, syncPrivateDirectory } from "./storage.js";
import type { CaptureConfig } from "./types.js";

export interface RecoveryBackupOptions {
  readonly database: {readonly connectionString:string;readonly schema:string;readonly pgDump?:string};
  readonly roots: readonly RecoveryRoot[];
  readonly captures: readonly CaptureConfig[];
  readonly encryptionKey: Uint8Array;
  readonly destination: string;
  readonly requireComplete?: boolean;
  readonly signal?:AbortSignal;
}
async function newDestination(pathInput:string,roots:readonly string[]):Promise<string>{
  const parent=await realpath(dirname(resolve(pathInput))),path=join(parent,basename(resolve(pathInput)));
  for(const input of roots){const root=await realpath(input);if(path===root||path.startsWith(`${root}/`)||root.startsWith(`${path}/`))throw new Error("Recovery destination overlaps a source root");}
  const existing=await lstat(path).catch((error:NodeJS.ErrnoException)=>{if(error.code==="ENOENT")return undefined;throw error;});if(existing!==undefined)throw new Error("Recovery destination must be new");return path;
}
async function copyVerified(file:RecoveryFile,target:string):Promise<void>{
  await mkdir(dirname(target),{recursive:true,mode:0o700});const output=await open(target,"wx",0o600);
  try{for await(const bytes of recoveryFileChunks(file.source,{expected:file})){let offset=0;while(offset<bytes.length){const result=await output.write(bytes,offset,bytes.length-offset);if(result.bytesWritten===0)throw new Error("Recovery copy stalled");offset+=result.bytesWritten;}}await output.sync();}finally{await output.close();}await syncPrivateDirectory(dirname(target));
}
async function readLines(file:RecoveryFile):Promise<string[]>{
  const text=await readBoundedPrivateText(file.source,128*1024*1024);return text.split("\n").filter(line=>line.trim().length>0);
}
async function privateReferences(files:readonly RecoveryFile[],roots:readonly RecoveryRoot[]):Promise<{keys:RecoveryKey[];references:RecoveryReference[];exclusions:string[]}>{
  const keys:RecoveryKey[]=[],references:RecoveryReference[]=[],exclusions:string[]=[];const keyBytes=new Map<string,Uint8Array>();
  for(const file of files){const [,rootId,...parts]=file.path.split("/");if(!rootId||!roots.some(root=>root.id===rootId)||!file.path.endsWith(".key"))continue;const key:RecoveryKey={id:`${rootId}:${parts.join("/")}`,rootId,path:parts.join("/"),sha256:file.sha256};keyBytes.set(key.id,parseVaultKey(await readBoundedPrivateText(file.source,1024,{requireOwnerOnly:true})));keys.push(key);}
  if(keys.length>1_000)throw new Error("Recovery key inventory exceeds bounds");
  for(const file of files){if(!file.path.endsWith(".enc"))continue;const [,rootId,...parts]=file.path.split("/");if(rootId===undefined)throw new Error("Encrypted file has no recovery root");
    const lines=await readLines(file);let keyId:string|undefined;
    for(const key of keys){try{for(const line of lines){if((JSON.parse(line) as {$superBrainEncrypted?:unknown}).$superBrainEncrypted!==1)throw new Error("Plaintext in encrypted artifact");JSON.parse(decryptVaultLine(line,keyBytes.get(key.id)!));}keyId=key.id;break;}catch{/* Try only declared private keys; no plaintext fallback. */}}
    if(keyId===undefined){exclusions.push(`unresolved:encrypted-artifact:${file.path}`);continue;}
    references.push({id:`stored:${file.path}`,rootId,path:parts.join("/"),kind:lines.length>1?"encrypted-jsonl":"encrypted-json",keyId,sha256:file.sha256});
  }
  return {keys,references,exclusions};
}
function coveredPath(files:readonly RecoveryFile[],root:RecoveryRoot,suffix:string):RecoveryFile|undefined{return files.find(file=>file.path===`roots/${root.id}/${suffix}`);}

export async function createPrivateRecoveryBundle(options:RecoveryBackupOptions):Promise<{manifest:RecoveryManifest;receipt:RecoveryVerificationReceipt;archive:string}>{
  if(!/^[a-z_][a-z0-9_]*$/i.test(options.database.schema))throw new Error("Recovery database schema is invalid");
  const roots=await Promise.all(options.roots.map(async root=>({...root,sourceRoot:await realpath(root.sourceRoot)})));
  if(roots.some(root=>root.kind==="ingress"))throw new Error("Capture ingress generations are inventoried automatically");
  const destination=await newDestination(options.destination,roots.map(root=>root.sourceRoot));
  const staging=await mkdtemp(join(dirname(destination),".super-brain-recovery-"));
  const seal=await sealPrivateRoots(roots.map(root=>({root:root.sourceRoot,writers:root.writers})),{...(options.signal===undefined?{}:{signal:options.signal})}).catch(async error=>{await rm(staging,{recursive:true,force:true});throw error;});
  let published=false;
  try {
    const generations:{root:RecoveryRoot;directories:readonly string[]}[]=[];
    for(const [index,config] of options.captures.entries()){
      const state=await realpath(config.stateRoot),vault=await realpath(config.vaultRoot);
      if(!roots.some(root=>root.kind==="capture-state"&&root.sourceRoot===state)||!roots.some(root=>root.kind==="vault"&&root.sourceRoot===vault))throw new Error("Capture topology omits state or vault root");
      const journal=new CaptureIngressJournal(state,await receiptEncryptionKey(config));const rotation=await journal.rotate(seal.id);
      generations.push({root:{id:`capture-ingress-${index}`,machineId:roots.find(root=>root.sourceRoot===state)!.machineId,kind:"ingress",sourceRoot:rotation.root,writers:["capture","hook-relay"]},directories:rotation.generations});
    }
    const topology=[...roots,...generations.map(item=>item.root)];
    return await withRecoveryBarrier({connectionString:options.database.connectionString,schema:options.database.schema,...(options.signal===undefined?{}:{signal:options.signal})},async(boundary,signal)=>{
      const exclusions=["browser-local optional telemetry is outside this enrolled filesystem topology","repository base commits and native source checkouts remain declared external reconstruction dependencies"];
      const files:RecoveryFile[]=[];
      const dump=join(staging,"database.dump");await runRecoveryPostgres(options.database.pgDump??"pg_dump",["--format=custom","--no-owner","--no-acl",`--schema=${boundary.schema}`,`--snapshot=${boundary.snapshotId}`,`--file=${dump}`],options.database.connectionString,{signal});
      files.push(await recoveryFile(dump,"database.dump"));
      for(const root of roots){
        const inventory=await recoveryInventory(root.sourceRoot,`roots/${root.id}`,{signal,skip:async path=>{
          if(root.kind==="worker-jobs"&&/^[a-f0-9]{64}\/lease\.json(?:\.recovery)?$/.test(path)){
            const lease=JSON.parse(await readBoundedPrivateText(join(root.sourceRoot,path),16_384)) as {privateWriterProtocol?:unknown;pid?:unknown;token?:unknown};
            if(lease.privateWriterProtocol!==1||typeof lease.pid!=="number"||typeof lease.token!=="string")throw new Error("Unsupported worker lease prevents coordinated recovery");exclusions.push(`ephemeral worker lease reinitialized:roots/${root.id}/${path}`);return true;
          }
          if(root.kind==="worker-jobs"&&path==="processing-status.json"){exclusions.push(`ephemeral worker status reinitialized:roots/${root.id}/${path}`);return true;}
          if(root.kind==="node-outbox"&&["outbox.sqlite","outbox.sqlite-wal","outbox.sqlite-shm"].includes(path))return true;
          if(path.endsWith(".tmp")){exclusions.push(`unpublished temporary artifact excluded:roots/${root.id}/${path}`);return true;}
          return false;
        }});files.push(...inventory);
        if(root.kind==="node-outbox"){
          const sqlite=join(staging,`${root.id}.sqlite`);await backupTelemetrySqlite(root.sourceRoot,sqlite);files.push(await recoveryFile(sqlite,`roots/${root.id}/outbox.sqlite`));exclusions.push(`SQLite delivery claims reset on consistent copy:roots/${root.id}/outbox.sqlite; stable command IDs retained`);
        }
      }
      for(const generation of generations)for(const directory of generation.directories)files.push(...await recoveryInventory(directory,`roots/${generation.root.id}/sealed/${basename(directory)}`,{signal}));
      files.sort((a,b)=>a.path.localeCompare(b.path));
      const privateInventory=await privateReferences(files,topology);exclusions.push(...privateInventory.exclusions);
      const references=[...privateInventory.references];
      await readRecoveryEventPages({connectionString:options.database.connectionString,schema:boundary.schema,snapshotId:boundary.snapshotId,signal},async events=>{
        for(const event of events){
          for(const change of event.changes){
            const artifact=change.verb==="create"&&change.nodeKind==="x.fold.transcript-artifact"?change.after.artifact as {id?:unknown;source?:unknown;sha256?:unknown;stored?:unknown;storedSha256?:unknown}:undefined;
            if(artifact?.stored===true&&typeof artifact.id==="string"&&typeof artifact.source==="string"&&typeof artifact.sha256==="string"){
              const suffix=`${artifact.source}/${artifact.sha256.slice(0,2)}/${artifact.sha256}.jsonl`;
              const matches=topology.filter(root=>root.kind==="vault").flatMap(root=>{const file=coveredPath(files,root,`${suffix}.enc`)??coveredPath(files,root,suffix);return file===undefined?[]:[{root,file}];});
              const match=matches.find(({file})=>artifact.storedSha256===undefined||file.sha256===artifact.storedSha256);
              if(match===undefined)exclusions.push(`unresolved:canonical-transcript:${artifact.id}`);
              else{const encrypted=privateInventory.references.find(ref=>`roots/${ref.rootId}/${ref.path}`===match.file.path);references.push(encrypted===undefined?{id:`event:${event.id}:${artifact.id}`,rootId:match.root.id,path:relative(`roots/${match.root.id}`,match.file.path),kind:"bytes",sha256:match.file.sha256}:{...encrypted,id:`event:${event.id}:${artifact.id}`});}
            }
          }
          const identity=event.capture.identity;
          if(identity?.receiptId!==undefined){
            const capture=options.captures.find(config=>config.sensorId===identity.sensor&&config.workspaceId===event.capture.scope.workspace);
            const root=capture===undefined?undefined:roots.find(root=>root.kind==="capture-state"&&root.sourceRoot===resolve(capture.stateRoot));
            const suffix=`receipts/receiver/completed/${createHash("sha256").update(identity.receiptId).digest("hex")}.json.enc`;
            if(root===undefined||coveredPath(files,root,suffix)===undefined)exclusions.push(`unresolved:canonical-receipt:${event.id}`);
          }
        }
      });
      const manifest:RecoveryManifest={version:1,id:seal.id,createdAt:new Date().toISOString(),cutoffAt:seal.observedAt,database:{schema:boundary.schema,maxIngestionPosition:boundary.maxIngestionPosition,snapshotId:boundary.snapshotId,protocolVersion:1},roots:topology,keys:privateInventory.keys,references,coverage:exclusions.some(value=>value.startsWith("unresolved:"))?"incomplete":"complete-declared-topology",exclusions,files:files.map(({source:_source,...file})=>file)};
      if(options.requireComplete!==false&&manifest.coverage!=="complete-declared-topology")throw new Error("Recovery has unresolved private dependencies; explicit incomplete mode is required");
      await writeRecoveryArchive(destination,manifest,files,options.encryptionKey,signal);
      const verified=await verifyRecoveryArchive(destination,options.encryptionKey,join(staging,"verified"),{signal});
      try{published=true;return{manifest,receipt:verified.receipt,archive:destination};}finally{await verified.cleanup();}
    });
  } finally {await seal.release();await rm(staging,{recursive:true,force:true});if(!published)await rm(destination,{force:true});}
}

export interface RecoveryRestoreOptions {
  readonly archive:string;readonly encryptionKey:Uint8Array;readonly staging:string;
  readonly database:{readonly connectionString:string;readonly pgRestore?:string;readonly psql?:string};
  readonly roots:Readonly<Record<string,string>>;
  readonly signal?:AbortSignal;
}
/** Restore accepts only a new, explicitly disposable database and distinct empty private roots. */
export async function restorePrivateRecoveryBundle(options:RecoveryRestoreOptions):Promise<RecoveryVerificationReceipt>{
  const verified=await verifyRecoveryArchive(options.archive,options.encryptionKey,options.staging,{...(options.signal===undefined?{}:{signal:options.signal})});
  const created:string[]=[];let completed=false;
  try{
    const targets=new Map<string,string>();
    for(const root of verified.manifest.roots){const target=options.roots[root.id];if(target===undefined)throw new Error("Restore requires a destination for every declared private root");targets.set(root.id,await newDestination(target,[...targets.values()].filter(path=>created.includes(path))));}
    const paths=[...targets.values()];if(new Set(paths).size!==paths.length||paths.some(path=>paths.some(other=>path!==other&&(path.startsWith(`${other}/`)||other.startsWith(`${path}/`)))))throw new Error("Restore roots must be distinct and non-nested");
    const uri=new URL(options.database.connectionString);if(!/^super_brain_restore_[a-z0-9_]+$/.test(decodeURIComponent(uri.pathname.slice(1))))throw new Error("Automated restore requires an explicitly disposable super_brain_restore_* database");
    await runRecoveryPostgres(options.database.psql??"psql",["-X","--set=ON_ERROR_STOP=1","--command=DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind IN ('r','p')) THEN RAISE EXCEPTION 'Restore target must be empty'; END IF; END $$;"],options.database.connectionString,{...(options.signal===undefined?{}:{signal:options.signal})});
    for(const root of verified.manifest.roots){const target=targets.get(root.id)!;await mkdir(target,{mode:0o700});created.push(target);
      const write=async()=>{for(const file of verified.manifest.files.filter(file=>file.path.startsWith(`roots/${root.id}/`))){const suffix=file.path.slice(`roots/${root.id}/`.length);await copyVerified({...file,source:join(verified.staging,file.path)},join(target,suffix));}};
      if(root.kind==="ingress")await write();else{for(const writer of root.writers)await withPrivateRootWrite(target,writer,async()=>undefined);await withPrivateRootWrite(target,root.writers[0]!,write);}
    }
    await runRecoveryPostgres(options.database.pgRestore??"pg_restore",["--single-transaction","--exit-on-error","--no-owner","--no-acl",join(verified.staging,"database.dump")],options.database.connectionString,{...(options.signal===undefined?{}:{signal:options.signal})});
    completed=true;return verified.receipt;
  }finally{await verified.cleanup();if(!completed)for(const path of created.reverse())await rm(path,{recursive:true,force:true});}
}

export async function transferPrivateRecoveryBundle(options:{archive:string;destination:string;encryptionKey:Uint8Array;staging:string;signal?:AbortSignal}):Promise<RecoveryVerificationReceipt>{
  const destination=await newDestination(options.destination,[]);const source=await recoveryFile(options.archive,"recovery.sbr");await copyVerified(source,destination);
  const verified=await verifyRecoveryArchive(destination,options.encryptionKey,options.staging,{destination:"transferred",...(options.signal===undefined?{}:{signal:options.signal})});try{return verified.receipt;}finally{await verified.cleanup();}
}
