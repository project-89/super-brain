import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { SuperBrainApiError, nextEventStamp, type AuthorizedReadSubject, type TelemetryBatch } from "@_89/super-brain-client";
import { NodeTelemetryOutbox } from "../src/outbox.js";

const roots: string[] = []; const boxes: NodeTelemetryOutbox[] = [];
afterEach(async () => { await Promise.all(boxes.splice(0).map((box) => box.close())); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const subject: AuthorizedReadSubject = { organizationId: "org", workspaceId: "workspace", principalId: "actor-a" };
const batch = (n=1, who=subject): TelemetryBatch => ({ version: 1, subject: who, stamp: { id: `batch-${n}`, t: 1000, worldDate: "1970-01-01" }, items: [{
  stamp: { id: `feedback-${n}`, t: 1000, worldDate: "1970-01-01" }, memoryId: "private-memory-identifier",
  input: { version: 2, memoryRevision: 0, recallId: "recall-private-id", signal: "offered", rank: 1 },
}] });
async function directory() { const root=await mkdtemp(join(tmpdir(),"mcp-outbox-")); roots.push(root); return root; }
function box(directory: string, options: Partial<ConstructorParameters<typeof NodeTelemetryOutbox>[0]>={}) {
  const value=new NodeTelemetryOutbox({ directory, identity: async()=>subject, send: async()=>undefined, ...options }); boxes.push(value); return value;
}

it("persists encrypted minimal batches and reuses exact commands after an uncertain acknowledgement and restart", async()=>{
  const root=await directory(); let now=1000;
  const first=box(root,{now:()=>now,retryBaseMs:1,send:async()=>{throw new Error("unknown acknowledgement");}});
  await first.enqueue({ ...batch(), query:"NEVER_STORE_QUESTION", token:"NEVER_STORE_TOKEN", items:batch().items.map((item)=>({...item,input:{...item.input,detail:"NEVER_STORE_DETAIL"}})) } as TelemetryBatch);
  await first.flush(); expect(await first.status()).toMatchObject({retry:1});
  for(const file of await readdir(root)) if(file.startsWith("outbox.sqlite")) {
    const raw=(await readFile(join(root,file))).toString("latin1");
    for(const value of ["NEVER_STORE_QUESTION","NEVER_STORE_TOKEN","NEVER_STORE_DETAIL","private-memory-identifier","recall-private-id"]) expect(raw).not.toContain(value);
  }
  await first.close(); now+=10;
  const send=vi.fn().mockResolvedValue({}); const restarted=box(root,{now:()=>now,send});
  await restarted.enqueue(batch()); // Same durable command is deduplicated before dispatch.
  await restarted.flush(); expect(send).toHaveBeenCalledOnce(); expect(send.mock.calls[0]![0]).toEqual(batch());
  expect(await restarted.status()).toMatchObject({pending:0,retry:0});
});

it("bounds the queue and retries, retaining explicit denied and exhausted states", async()=>{
  let now=1000; const root=await directory();
  const outbox=box(root,{now:()=>now,maxBatches:2,maxAttempts:2,retryBaseMs:1,send:async(value)=>{throw value.stamp.id==="batch-1"?new SuperBrainApiError(403,"feedback_denied","private diagnostics"):new Error("network");}});
  await outbox.enqueue(batch(1)); await outbox.enqueue(batch(2)); await expect(outbox.enqueue(batch(3))).rejects.toThrow("outbox-full");
  await outbox.flush(); now+=10; await outbox.flush();
  expect(await outbox.status()).toMatchObject({denied:1,exhausted:1,pending:0,retry:0,unavailable:"queue-full"});
});

it("partitions actual subjects and defers a dispatch account race without changing the stored actor", async()=>{
  const root=await directory(); let now=1000; let active=subject;
  const other={...subject,principalId:"actor-b"}; let raced=false;
  const send=vi.fn().mockImplementation(async(value:TelemetryBatch)=>{
    if(!raced){raced=true;active=other;}
    if(active.principalId!==value.subject.principalId) throw new SuperBrainApiError(409,"feedback_subject_changed","account changed");
  });
  const outbox=box(root,{now:()=>now,identity:async()=>active,send,retryBaseMs:1});
  await outbox.enqueue(batch()); await outbox.flush(); expect(send).toHaveBeenCalledOnce();
  now+=10; await outbox.flush(); expect(send).toHaveBeenCalledOnce(); expect(await outbox.status()).toMatchObject({pending:0,retry:0});
  active=subject; expect(await outbox.status()).toMatchObject({retry:1});
  await outbox.flush(); expect(send).toHaveBeenCalledTimes(2); expect(send.mock.calls[1]![0]).toEqual(batch());
});

it("allows only one SQLite connection to claim a batch while another process connection drains", async()=>{
  const root=await directory(); let release!:()=>void; let started!:()=>void;
  const gate=new Promise<void>((resolve)=>{release=resolve;}); const entered=new Promise<void>((resolve)=>{started=resolve;});
  const send=vi.fn().mockImplementation(async()=>{started();await gate;});
  const a=box(root,{send});const b=box(root,{send}); await a.enqueue(batch());
  const first=a.flush(); await entered; await b.flush(); expect(send).toHaveBeenCalledOnce(); release(); await first;
});

it("cancels hung network work on close and leaves its exact durable batch pending", async()=>{
  const root=await directory();let started!:()=>void;const entered=new Promise<void>((resolve)=>{started=resolve;});let signal!:AbortSignal;
  const outbox=box(root,{send:async(_batch,value)=>{signal=value;started();return new Promise(()=>undefined);}});
  await outbox.enqueue(batch());const flushing=outbox.flush();await entered;await outbox.close();await flushing;expect(signal.aborted).toBe(true);
  const restarted=box(root);expect(await restarted.status()).toMatchObject({pending:1});
});

it("reports failed persistence as unavailable without inventing durable queued work", async()=>{
  const root=await directory();const path=join(root,"not-a-directory");await writeFile(path,"synthetic");const outbox=box(path);
  await expect(outbox.enqueue(batch())).rejects.toBeDefined();expect(await outbox.status()).toMatchObject({pending:0,unavailable:"storage-unavailable"});
});


it("accepts actual shared-client stamps and lets explicit terminal repair recover capacity",async()=>{
  const root=await directory();let forbidden=true;const send=vi.fn().mockImplementation(async()=>{if(forbidden)throw new SuperBrainApiError(403,"feedback_denied","denied");});
  const outbox=box(root,{send,maxBatches:1});const actual={...batch(),stamp:nextEventStamp(),items:batch().items.map((item)=>({...item,stamp:nextEventStamp()}))};
  await outbox.enqueue(actual);await outbox.flush();expect(await outbox.status()).toMatchObject({denied:1});
  forbidden=false;expect(await outbox.retryTerminal()).toBe(1);await outbox.flush();expect(await outbox.status()).toMatchObject({pending:0,denied:0});
  await outbox.enqueue(batch(2));forbidden=true;await outbox.flush();expect(await outbox.discardTerminal()).toBe(1);await expect(outbox.enqueue(batch(3))).resolves.toBeUndefined();
});

it("does not reclaim a batch terminalized by another process before an atomic claim",async()=>{
  const root=await directory();const owner=box(root,{send:async()=>{throw new SuperBrainApiError(403,"feedback_denied","denied");}});await owner.enqueue(batch());
  const moduleUrl=new URL("../dist/index.js",import.meta.url).href;
  const script=`
    import {DatabaseSync} from 'node:sqlite';
    import {readSync} from 'node:fs';
    import {NodeTelemetryOutbox} from ${JSON.stringify(moduleUrl)};
    const prepare=DatabaseSync.prototype.prepare;
    let blocked=false;
    DatabaseSync.prototype.prepare=function(sql){
      const stmt=prepare.call(this,sql);
      if(!blocked && sql.startsWith('UPDATE batches SET lease=')) {
        blocked=true;
        const pause=()=>{process.stdout.write('before-claim\\n');readSync(0,Buffer.alloc(1),0,1,null);};
        return new Proxy(stmt,{get(target,key){const value=Reflect.get(target,key);if(key==='get'||key==='run')return(...args)=>{pause();return value.apply(target,args);};return typeof value==='function'?value.bind(target):value;}});
      }
      return stmt;
    };
    let sent=0;
    const box=new NodeTelemetryOutbox({directory:process.argv[1],identity:async()=>(${JSON.stringify(subject)}),send:async()=>{sent++;}});
    await box.flush();const status=await box.status();await box.close();process.stdout.write(JSON.stringify({sent,status})+'\\n');
  `;
  const child=spawn(process.execPath,["--input-type=module","-e",script,root],{cwd:fileURLToPath(new URL("..",import.meta.url)),stdio:["pipe","pipe","pipe"]});
  let output="",errors="";let ready!:()=>void;const entered=new Promise<void>((resolve)=>{ready=resolve;});
  child.stdout.on("data",(chunk)=>{output+=chunk.toString();if(output.includes("before-claim"))ready();});child.stderr.on("data",(chunk)=>{errors+=chunk.toString();});
  const exited=new Promise<number|null>((resolve,reject)=>{child.once("error",reject);child.once("close",resolve);});
  try{
    await Promise.race([entered,exited.then(()=>{throw new Error(`child ended before claim: ${errors}`);})]);
    await owner.flush();expect(await owner.status()).toMatchObject({denied:1});
    child.stdin.write("x");expect(await exited,errors).toBe(0);
    const report=JSON.parse(output.trim().split("\n").at(-1)!);expect(report).toMatchObject({sent:0,status:{denied:1,pending:0,retry:0}});
  }finally{child.kill();await exited.catch(()=>undefined);}
},10_000);
