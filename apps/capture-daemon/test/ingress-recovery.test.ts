import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { sealPrivateRoots } from "@_89/super-brain-importer";
import { CaptureEngine, CaptureHttpServer, CaptureReceiptQueue, DurableSpool, HookOutbox, HookVault, StateStore, parseCaptureConfig, receiptEncryptionKey, type HookOccurrence } from "../src/index.js";
import { CaptureIngressJournal } from "../src/ingress.js";
async function fixture(){
  const base=await mkdtemp(join(tmpdir(),"recovery-ingress-"));
  const config={...parseCaptureConfig({apiUrl:"http://127.0.0.1:3003",workspaceId:"workspace-a",apiToken:"synthetic",sensorId:"urn:sensor:recovery",hookToken:"synthetic-hook",operatorToken:"synthetic-operator",stateRoot:join(base,"state"),vaultRoot:join(base,"vault"),port:8377,bindHost:"127.0.0.1",heartbeatWindowMs:90_000,heartbeatIntervalMs:30_000,reasoningPolicy:"exclude"}),port:0};
  const key=await receiptEncryptionKey(config),spool=new DurableSpool(config.stateRoot),state=new StateStore(config.stateRoot),vault=new HookVault(config.vaultRoot,key),engine=new CaptureEngine(config,state,vault,spool);await engine.initialize();
  return{base,config,key,spool,state,vault,engine,queue:new CaptureReceiptQueue(engine,key)};
}
const occurrence=(id:string,prompt=id):HookOccurrence=>({version:1,id,source:"codex",endpoint:"/hook",occurredAt:"2026-09-05T00:00:00.000Z",payload:{session_id:"recovery-session",hook_event_name:"UserPromptSubmit",prompt}});
it("includes pre-boundary acknowledgements, journals held HTTP arrivals, and replays exact occurrences after restart",async()=>{
  const f=await fixture(),sender=new HookOutbox(f.config.stateRoot,f.key);
  const first=await sender.persist("codex",occurrence("before").payload,"/hook","before");await f.queue.accept(first);
  const server=new CaptureHttpServer(f.config,f.engine,f.spool);
  const seal=await sealPrivateRoots([{root:f.config.stateRoot,writers:["capture","hook-relay"]},{root:f.config.vaultRoot,writers:["capture"]}]);
  const address=await server.start();
  const journal=new CaptureIngressJournal(f.config.stateRoot,f.key);
  try{
    expect((await f.queue.list()).some(record=>record.occurrence.id==="before")).toBe(true);
    const during=await sender.persist("codex",occurrence("during").payload,"/hook","during");
    const response=await fetch(`http://${address.host}:${address.port}/hook`,{method:"POST",headers:{"content-type":"application/json","x-agent-source":"codex","x-super-brain-hook-token":f.config.hookToken,"x-super-brain-receipt-id":during.id,"x-super-brain-occurred-at":during.occurredAt},body:JSON.stringify(during.payload)});
    expect(response.status).toBe(202);expect(await response.json()).toMatchObject({accepted:true,receiptId:"during",deferred:true});
    const deferred=(await journal.pending("receiver"))[0]!;expect(deferred.occurrence.occurredAt).toBe(during.occurredAt);expect(deferred.receivedAt).toBeTruthy();
    const boundary=await journal.rotate(seal.id);
    await f.queue.accept(occurrence("after"));
    expect((await readdir(boundary.generations[0]!)).length).toBe(2);
    expect((await readdir(join(boundary.root,"pending"))).length).toBe(1);
    await expect(f.queue.accept({...occurrence("after"),payload:{different:true}})).rejects.toThrow(/reused/);
    await seal.release();await server.close();
    const engine=new CaptureEngine(f.config,new StateStore(f.config.stateRoot),new HookVault(f.config.vaultRoot,f.key),new DurableSpool(f.config.stateRoot));await engine.initialize();const queue=new CaptureReceiptQueue(engine,f.key);await queue.drain();
    expect((await journal.pending("receiver")).length).toBe(0);
    const retry=await queue.accept(occurrence("after"));expect(retry.artifactId).toMatch(/^[a-f0-9]{64}$/);expect(retry.deferred).toBeUndefined();
    const stored=JSON.stringify(await engine.stateStore.load());expect(stored).toContain(retry.artifactId!);
    await sender.acknowledge("during");expect((await journal.pending("sender")).length).toBe(0);
  }finally{await seal.release();await server.close();await rm(f.base,{recursive:true,force:true});}
},15_000);
