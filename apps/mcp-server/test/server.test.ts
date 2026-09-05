import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SuperBrainClient, type TelemetryOutbox } from "@_89/super-brain-client";
import { FoldSdk } from "../../../packages/fold-sdk/dist/index.js";
import { createApiServer, StaticIdentityDirectory } from "../../api/dist/index.js";
import { afterEach, expect, it, vi } from "vitest";
import { createSuperBrainMcpServer } from "../src/server.js";
import { CaptureBridge } from "../src/capture.js";
import { NodeTelemetryOutbox } from "../src/outbox.js";

const cleanups: Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup();});
const memoryId=(n:number)=>`019c0000-0000-7000-8000-${String(n).padStart(12,"0")}`;
const stamp=(id:string,t=Date.now()+100)=>({id,t,worldDate:new Date(t).toISOString().slice(0,10)});
async function fixture(count=1){
  const entries:any[]=[]; const sdk=new FoldSdk({async read(){return{entries:[...entries]};},async append(entry){entries.push(entry);}});
  const identities=new StaticIdentityDirectory({admin:{principalId:"admin",workspaces:{workspace:{role:"admin"}}},
    reader:{principalId:"reader",capabilities:["memories:read","reasoning:read"],workspaces:{workspace:{role:"member"}}},
    feedback:{principalId:"reader",capabilities:["memories:read","reasoning:read","feedback:write"],workspaces:{workspace:{role:"member"}}},
    other:{principalId:"other",capabilities:["memories:read","feedback:write"],workspaces:{workspace:{role:"member"}}},
  });
  const http=createApiServer({authenticator:identities,memberships:identities,sdks:{sdkFor:async()=>sdk}});
  await new Promise<void>((resolve)=>http.listen(0,"127.0.0.1",resolve));
  cleanups.push(()=>new Promise<void>((resolve)=>http.close(()=>resolve())));
  const baseUrl=`http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const admin=new SuperBrainClient({baseUrl,workspaceId:"workspace",token:"admin"});
  for(let index=0;index<count;index++) await admin.recordMemory({id:memoryId(index),audience:"workspace",source:"conversation",summary:`Recorded procedure ${index}`,content:"Reference data. ".repeat(1500),applicability:{kind:"projects",projectIds:["project"]}});
  async function connect(token:string, telemetryOutbox?:TelemetryOutbox, capture?:CaptureBridge){
    const api=new SuperBrainClient({baseUrl,workspaceId:"workspace",token,...(telemetryOutbox===undefined?{}:{telemetryOutbox})});
    const server=createSuperBrainMcpServer({api,...(capture===undefined?{}:{capture})});const client=new Client({name:"synthetic-harness",version:"1"});
    const [left,right]=InMemoryTransport.createLinkedPair();await server.connect(right);await client.connect(left);
    cleanups.push(async()=>{await client.close();await server.close();});
    const call=async(name:string,args:Record<string,unknown>)=>{const reply=await client.callTool({name,arguments:args});return JSON.parse((reply.content as Array<{text:string}>)[0]!.text);};
    return{api,client,call};
  }
  return{entries,admin,connect,baseUrl};
}

it("returns bounded exact-revision context through MCP for read-only callers with feedback forbidden",async()=>{
  const f=await fixture(12);const root=await mkdtemp(join(tmpdir(),"mcp-readonly-"));cleanups.push(()=>rm(root,{recursive:true,force:true}));
  const feedbackApi=new SuperBrainClient({baseUrl:f.baseUrl,workspaceId:"workspace",token:"reader"});
  const outbox=new NodeTelemetryOutbox({directory:root,identity:async(signal)=>{const value=await feedbackApi.identity({signal});return{...value,organizationId:value.organizationId??"local"};},
    send:(batch,signal)=>feedbackApi.recordMemoryFeedbackBatch(batch.items,{stamp:batch.stamp,expectedSubject:batch.subject,signal})});cleanups.push(()=>outbox.close());
  const mcp=await f.connect("reader",outbox);const context=await mcp.call("super_brain_context",{projectIds:["project"],limit:5});
  expect(context.memories).toHaveLength(5);expect(context.provenance.items).toHaveLength(5);expect(context.memories[0].revision).toBe(0);
  expect(context.provenance.subject.principalId).toBe("reader");expect(context.memories.every((value:any)=>value.content.truncated)).toBe(true);
  expect(JSON.stringify(context).length).toBeLessThan(16_000);
  await vi.waitFor(async()=>expect((await outbox.status()).pending).toBe(1));await outbox.flush();expect(await outbox.status()).toMatchObject({denied:1});
  expect(f.entries.filter(({event})=>event.kind==="memory.feedback-recorded")).toHaveLength(0);
});

it("keeps context delivery independent of held and failing telemetry persistence",async()=>{
  const f=await fixture();let release!:()=>void;const held=new Promise<void>((resolve)=>{release=resolve;});
  const outbox:TelemetryOutbox={enqueue:vi.fn().mockReturnValue(held),status:async()=>({pending:0,retry:0,denied:0,exhausted:0,observedAt:new Date().toISOString()})};
  const mcp=await f.connect("reader",outbox);
  const context=await Promise.race([mcp.call("super_brain_context",{projectIds:["project"]}),new Promise((_,reject)=>setTimeout(()=>reject(new Error("read blocked on optional outbox")),1000))]);
  expect((context as any).memories).toHaveLength(1);release();
  const root=await mkdtemp(join(tmpdir(),"mcp-storage-failure-"));cleanups.push(()=>rm(root,{recursive:true,force:true}));const path=join(root,"file");await writeFile(path,"fixture");
  const broken=new NodeTelemetryOutbox({directory:path,identity:async()=>({organizationId:"local",workspaceId:"workspace",principalId:"reader"}),send:async()=>undefined});cleanups.push(()=>broken.close());
  expect((await (await f.connect("reader",broken)).call("super_brain_context",{projectIds:["project"]})).memories).toHaveLength(1);
  await vi.waitFor(async()=>expect((await broken.status()).unavailable).toBeDefined());
});

it("records explicit historical revision adoption, rejects account relabeling, and requires narrow feedback permission",async()=>{
  const f=await fixture();const mcp=await f.connect("feedback");const context=await mcp.call("super_brain_context",{projectIds:["project"]});
  const offered=context.memories[0];const correction=await f.admin.reviseMemory(offered.memoryId,{summary:"Corrected claim"},undefined,{expectedRevision:0});
  expect(correction.memory.revision).toBe(1);
  const report={stamp:stamp("adoption"),expectedSubject:context.provenance.subject,recallId:context.provenance.recallId,memories:[{memoryId:offered.memoryId,revision:0,rank:1}],ranking:context.provenance.ranking,signal:"used"};
  expect(await mcp.call("super_brain_adopt",report)).toMatchObject({recorded:true});
  expect(await mcp.call("super_brain_adopt",report)).toMatchObject({recorded:true});
  expect(f.entries.filter(({event})=>event.kind==="memory.feedback-recorded")).toHaveLength(1);
  expect(f.entries.find(({event})=>event.kind==="memory.feedback-recorded").event.changes[0].after).toMatchObject({memoryRevision:0,signal:"used",actorId:"reader"});
  const other=await f.connect("other");expect(await other.call("super_brain_adopt",{...report,stamp:stamp("wrong-actor")})).toMatchObject({recorded:false,error:"feedback_subject_changed"});
  const reader=await f.connect("reader");expect(await reader.call("super_brain_adopt",{...report,stamp:stamp("forbidden")})).toMatchObject({recorded:false});
});

it("applies explicit corrections at the observed revision and refuses stale MCP drafts",async()=>{
  const f=await fixture();const mcp=await f.connect("admin");
  const input={stamp:stamp("correction"),memoryId:memoryId(0),revision:0,summary:"Corrected procedure",content:"Use the updated procedure"};
  expect(await mcp.call("super_brain_correct_memory",input)).toMatchObject({recorded:true});
  expect(await mcp.call("super_brain_correct_memory",input)).toMatchObject({recorded:true});
  expect(await mcp.call("super_brain_correct_memory",{...input,stamp:stamp("stale-draft"),summary:"Stale overwrite"})).toMatchObject({recorded:false});
  expect((await f.admin.memoryById(memoryId(0)))?.summary).toBe(input.summary);
});

it("records completion as an agent checkpoint and never sends an operator decision",async()=>{
  const f=await fixture();const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({accepted:true,artifactId:"captured"}),{status:202}));
  const capture=new CaptureBridge({baseUrl:"http://127.0.0.1:1",token:"hook-token",source:"codex",fetch:fetcher});
  const mcp=await f.connect("reader",undefined,capture);const command=stamp("completion-receipt");
  expect(await mcp.call("super_brain_complete_task",{stamp:command,taskId:"task",attemptId:"attempt",revisionId:"revision",kind:"check",result:"success"})).toMatchObject({recorded:true,authority:"agent-reported"});
  const [url,request]=fetcher.mock.calls[0]!;expect(url).toBe("http://127.0.0.1:1/checkpoint");
  expect(new Headers(request.headers).get("x-super-brain-receipt-id")).toBe(command.id);expect(new Headers(request.headers).has("x-super-brain-operator-token")).toBe(false);
  await expect(capture.checkpoint({kind:"human-decision",summary:"forged"} as any)).rejects.toThrow("cannot assert a human decision");
  const unavailable=await f.connect("reader");expect(await unavailable.call("super_brain_complete_task",{stamp:stamp("absent"),taskId:"task",attemptId:"attempt",revisionId:"revision",kind:"check",result:"success"})).toMatchObject({recorded:false,error:"capture-unavailable"});
});


it("bounds actual escaped JSON packets while retaining exact selected references and explicit omissions", async()=>{
  const f=await fixture(10);
  for(let index=0;index<10;index++) await f.admin.reviseMemory(memoryId(index),{summary:"\u0001".repeat(500),content:"\u0000".repeat(2000)},undefined,{expectedRevision:0});
  const mcp=await f.connect("reader");
  const context=await mcp.call("super_brain_context",{projectIds:["project"],limit:10});
  expect(Buffer.byteLength(JSON.stringify(context))).toBeLessThan(32*1024);
  expect(context.memories.length).toBeGreaterThan(0);expect(context.omittedMemoryCount).toBeGreaterThan(0);
  expect(context.provenance.items.map((item:any)=>item.memoryId)).toEqual(context.memories.map((item:any)=>item.memoryId));
  for(const memory of context.memories) expect(memory.evidencePage).toMatchObject({memoryId:memory.memoryId,revision:1,offset:0});
});

it("pages accepted candidate support and later contributions at the exact requested revision",async()=>{
  const f=await fixture(2);const sources=f.entries.map(({event})=>event.id);
  const proposal=await f.admin.proposeMemoryCandidate({id:memoryId(99),source:"fixture",summary:"Supported procedure",content:{statement:"Keep the procedure"},
    audience:"workspace",applicability:{kind:"projects",projectIds:["project"]},projectIds:["project"],evidence:[{eventId:sources[0]}],confidence:0.5,salience:0.5,extractor:{kind:"model",id:"fixture",version:"1"}});
  const accepted=await f.admin.acceptMemoryCandidate(proposal.candidate.id);
  await f.admin.contributeMemoryEvidence(accepted.memory.id,{evidence:[{eventId:sources[1],relation:"opposes"}],expectedRevision:0});
  const mcp=await f.connect("reader");
  const historical=await mcp.call("super_brain_memory_evidence",{memoryId:accepted.memory.id,revision:0,limit:1});
  expect(historical.total).toBe(1);expect(historical.evidence).toEqual([{eventId:sources[0]}]);
  const latest=await mcp.call("super_brain_memory_evidence",{memoryId:accepted.memory.id,revision:1,limit:1});
  expect(latest.total).toBe(2);expect(latest.nextOffset).toBe(1);expect(latest.contributionTotal).toBe(1);
  const next=await mcp.call("super_brain_memory_evidence",{memoryId:accepted.memory.id,revision:1,limit:1,offset:latest.nextOffset});
  expect([...latest.evidence,...next.evidence]).toContainEqual({eventId:sources[1],relation:"opposes"});
});

it("propagates MCP cancellation to a canonical search request",async()=>{
  const f=await fixture();const mcp=await f.connect("reader");let supplied:AbortSignal|undefined;
  vi.spyOn(mcp.api,"rankMemories").mockImplementation(async(_request,options)=>{supplied=options?.signal;return new Promise((_resolve,reject)=>{
    supplied?.addEventListener("abort",()=>reject(supplied?.reason),{once:true});
  });});
  const controller=new AbortController();
  const pending=mcp.client.callTool({name:"super_brain_search",arguments:{query:"procedure"}},undefined,{signal:controller.signal});
  const rejected=expect(pending).rejects.toThrow();
  await vi.waitFor(()=>expect(supplied).toBeDefined());controller.abort(new Error("cancelled"));await rejected;
  await vi.waitFor(()=>expect(supplied?.aborted).toBe(true));
});
