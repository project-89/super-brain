import { describe, expect, it } from "vitest";
import { StaticIdentityDirectory } from "../src/index.js";
import { MEMORY_A, apiRequest, memoryRecordBody, startApi } from "./helpers.js";
const path = "/v1/workspaces/workspace-1";
const stamp = (id: string, t = 200) => ({ id, t, worldDate: "2026-09-04" });
const feedback = (overrides: Record<string,unknown> = {}) => ({ version: 2, memoryRevision: 0, recallId: "recall-a", signal: "judged", judgment: "helpful", ...overrides });
const identities = () => new StaticIdentityDirectory({
  writer: { principalId: "writer", workspaces: { "workspace-1": { role: "owner", spaces: { "space-a": "writer" } } } },
  reader: { principalId: "reader", capabilities: ["memories:read", "feedback:write"], workspaces: { "workspace-1": { role: "member", spaces: { "space-a": "reader" } } } },
  raw: { principalId: "reader", capabilities: ["events:write"], workspaces: { "workspace-1": { role: "member", spaces: { "space-a": "reader" } } } },
  other: { principalId: "other", capabilities: ["memories:read", "feedback:write"], workspaces: { "workspace-1": { role: "member" } } },
});
async function fixture() { const directory = identities(); const api = await startApi({ authenticator: directory, memberships: directory });
 const body = memoryRecordBody(); const created = await apiRequest(api.baseUrl, `${path}/memories`, { token: "writer", method: "POST", body: { ...body, input: { ...body.input, audience: "workspace", spaceId: "space-a" } } }); expect(created.status).toBe(201); return api;
}
describe("exact revision feedback HTTP boundary", () => {
 it("allows scoped readers to judge a historical revision, preserving creator and claim revision", async () => {
  const api = await fixture(); try {
   const revise = await apiRequest(api.baseUrl, `${path}/memories/${MEMORY_A}`, { token: "writer", method: "PATCH", body: { stamp: stamp("correction",150), expectedRevision: 0, patch: { summary: "Corrected" } } }); expect(revise.status).toBe(200);
   const result = await apiRequest(api.baseUrl, `${path}/memories/${MEMORY_A}/feedback`, { token: "reader", method: "POST", body: { stamp: stamp("judgment"), input: feedback() } }); expect(result).toMatchObject({ status: 201, body: { feedback: { version: 2, actorId: "reader", memoryRevision: 0 } } });
   expect(result.body.event.capture.scope).toEqual({workspace:"workspace-1",space:"space-a"});
   const current = await apiRequest(api.baseUrl, `${path}/memories/${MEMORY_A}`, {token:"reader"}); expect(current.body.memory).toMatchObject({revision:1,creatorId:"writer"});
   const denied = await apiRequest(api.baseUrl, `${path}/memories/${MEMORY_A}`, { token:"reader", method:"PATCH", body:{stamp:stamp("denied"), patch:{summary:"Wrong"}} }); expect(denied.status).toBe(403);
   const historical = await apiRequest(api.baseUrl, `${path}/memories/${MEMORY_A}/feedback?revision=0`, {token:"reader"}); expect(historical.body.summary).toMatchObject({helpful:1,reviewSuggested:false,basis:"actor-reported"});
   const latest = await apiRequest(api.baseUrl, `${path}/memories/${MEMORY_A}/feedback`, {token:"reader"}); expect(latest.body.summary.helpful).toBe(0);
  } finally { await api.close(); }
 });
 it("validates the whole batch before append, deduplicates retries, and rejects changed subjects", async () => {
  const api = await fixture(); try {
   const expectedSubject = {organizationId:"local",workspaceId:"workspace-1",principalId:"reader"};
   const item = {stamp:stamp("item"),memoryId:MEMORY_A,input:feedback()};
   const send = (body: unknown, token="reader") => apiRequest(api.baseUrl, `${path}/memory-feedback-batches`,{token,method:"POST",body});
   const bad = await send({stamp:stamp("batch-bad"),expectedSubject,items:[item,{...item,stamp:stamp("bad-item"),input:feedback({memoryRevision:999})}]}); expect(bad.status).toBe(409);
   expect((await apiRequest(api.baseUrl, `${path}/memories/${MEMORY_A}/feedback`, {token:"reader"})).body.summary.helpful).toBe(0);
   const body = {stamp:stamp("batch"),expectedSubject,items:[item]}; const first=await send(body); expect(first.status).toBe(201); expect((await send(body)).body).toEqual(first.body);
   expect((await send({...body,items:[{...item,input:feedback({judgment:"unhelpful"})}]})).status).toBe(409);
   expect(await send(body,"writer")).toMatchObject({status:409,body:{error:{code:"feedback_subject_changed"}}});
   expect(await send(body,"other")).toMatchObject({status:409,body:{error:{code:"feedback_subject_changed"}}});
  } finally { await api.close(); }
 });
 it("denies revisionless writes, unrelated outcome refs, and raw append bypass", async () => {
  const api = await fixture(); try {
   const send = (input: unknown,id="invalid") => apiRequest(api.baseUrl,`${path}/memories/${MEMORY_A}/feedback`,{token:"reader",method:"POST",body:{stamp:stamp(id),input}});
   expect((await send({signal:"helpful"})).status).toBe(400);
   expect((await send(feedback({signal:"outcome",judgment:undefined,outcomeEventId:"event-a"}),"outcome")).status).toBe(403);
   const valid=await send(feedback(),"valid"); expect(valid.status).toBe(201);
   const raw=await apiRequest(api.baseUrl,`${path}/events`,{token:"raw",method:"POST",body:{event:{...valid.body.event,id:"forged"},status:"canon"}}); expect(raw).toMatchObject({status:400,body:{error:{code:"reserved_event_route"}}});
   expect((await apiRequest(api.baseUrl,`${path}/memories/${MEMORY_A}/feedback`,{token:"other",method:"POST",body:{stamp:stamp("wrong-scope"),input:feedback()}})).status).toBe(404);
  } finally { await api.close(); }
 });
 it("binds provenance to the requesting reader and refuses a stale correction without breaking exact retry", async () => {
  const api = await fixture(); try {
   const recall=await apiRequest(api.baseUrl,`${path}/memories/recall`,{token:"reader",method:"POST",body:{}}); expect(recall.body.provenance).toMatchObject({subject:{principalId:"reader",organizationId:"local",workspaceId:"workspace-1"},items:[{memoryId:MEMORY_A,memoryRevision:0,rank:1}]});
   const inventory=await apiRequest(api.baseUrl,`${path}/memories?includeNeedsReview=true`,{token:"reader"}); expect(inventory.body.provenance).toMatchObject({subject:recall.body.provenance.subject,items:recall.body.provenance.items});
   const body={stamp:stamp("edit"),expectedRevision:0,patch:{summary:"Corrected"}};
   const edit=()=>apiRequest(api.baseUrl,`${path}/memories/${MEMORY_A}`,{token:"writer",method:"PATCH",body}); const first=await edit(); expect(first.status).toBe(200); expect((await edit()).body).toEqual(first.body);
   expect((await apiRequest(api.baseUrl,`${path}/memories/${MEMORY_A}`,{token:"writer",method:"PATCH",body:{...body,stamp:stamp("stale",201)}})).status).toBe(409);
  } finally { await api.close(); }
 });
 it("resolves task context and prevents private-space identifiers being copied into workspace feedback",async()=>{
  const api=await fixture();try{
   const task={version:1,taskId:"private-task",taskVersion:"v1",goal:"Private work",inputs:[]};
   expect((await apiRequest(api.baseUrl,`${path}/trajectory-tasks/private-task/manifests`,{token:"writer",method:"POST",body:{stamp:stamp("task",110),input:task,spaceId:"space-a"}})).status).toBe(201);
   const attempt={version:1,taskId:task.taskId,taskVersion:task.taskVersion,attemptId:"private-attempt",startRevision:{fingerprintStatus:"available",revisionId:"revision-a"}};
   expect((await apiRequest(api.baseUrl,`${path}/trajectory-tasks/private-task/attempts`,{token:"writer",method:"POST",body:{stamp:stamp("attempt",111),input:attempt,spaceId:"space-a"}})).status).toBe(201);
   const send=(memoryId:string,input:unknown,id:string)=>apiRequest(api.baseUrl,`${path}/memories/${memoryId}/feedback`,{token:"reader",method:"POST",body:{stamp:stamp(id),input}});
   expect((await send(MEMORY_A,feedback({taskId:"private-task",attemptId:"private-attempt"}),"scoped-context")).status).toBe(201);
   expect((await send(MEMORY_A,feedback({taskId:"missing"}),"missing-context")).status).toBe(403);
   const body=memoryRecordBody();const workspaceId="01890f47-7c00-7000-8000-000000000002";
   expect((await apiRequest(api.baseUrl,`${path}/memories`,{token:"writer",method:"POST",body:{...body,stamp:stamp("workspace-memory",120),input:{...body.input,id:workspaceId,audience:"workspace"}}})).status).toBe(201);
   expect((await send(workspaceId,feedback({taskId:"private-task",attemptId:"private-attempt"}),"broadened-context")).status).toBe(403);
  }finally{await api.close();}
 });

 it("rechecks membership after an asynchronous ranker before exposing search results",async()=>{
  const directory=identities();let revoked=false;let entered!:()=>void;const started=new Promise<void>((resolve)=>{entered=resolve;});let release!:()=>void;const wait=new Promise<void>((resolve)=>{release=resolve;});
  const api=await startApi({authenticator:directory,memberships:{
   resolveAccess:(...args)=>revoked&&args[0].principalId==="reader"?Promise.resolve(undefined):directory.resolveAccess(...args),
   resolveLegacyAccess:(...args)=>revoked&&args[0].principalId==="reader"?Promise.resolve(undefined):directory.resolveLegacyAccess(...args),
  },memoryRanker:{descriptor:{id:"delayed",kind:"semantic"},rank:async()=>{entered();await wait;return[{memoryId:MEMORY_A,score:1}];}}});
  try{
   const body=memoryRecordBody();expect((await apiRequest(api.baseUrl,`${path}/memories`,{token:"writer",method:"POST",body:{...body,input:{...body.input,audience:"workspace"}}})).status).toBe(201);
   const pending=apiRequest(api.baseUrl,`${path}/memories/search`,{token:"reader",method:"POST",body:{query:"decision"}});
   await started;revoked=true;release();expect(await pending).toMatchObject({status:403,body:{error:{code:"workspace_access_denied"}}});
  }finally{release();await api.close();}
 });

});
