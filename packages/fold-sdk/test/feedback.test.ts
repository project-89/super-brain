import { describe, expect, it } from "vitest";
import { makeMemoryFeedbackEvent, memoryFeedbackRecordsFromEvent, rebuildMemories } from "@_89/fold-epistemic";
import { FoldSdk } from "../src/index.js";
import { MEMORY_A, MEMORY_B, MemoryStore, access, memoryContext, stamp } from "./helpers.js";
const input = { version: 2 as const, memoryRevision: 0, recallId: "r", signal: "judged" as const, judgment: "helpful" as const };
describe("feedback command invariants", () => {
 it("reserves append, validates historical references during replay, and preserves legacy reads", async () => {
  const store=new MemoryStore(); const sdk=new FoldSdk(store); const context=memoryContext();
  const created=await sdk.recordMemory(context,stamp("create",100),{id:MEMORY_A,source:"test",applicability:{kind:"global"}});
  const event=makeMemoryFeedbackEvent(context,stamp("feedback",200),created.memory,input);
  await expect(sdk.append(context.access,event)).rejects.toThrow(/feedback command/);
  const forged=structuredClone(event); const change=forged.changes[0]!; if (change.verb==="create") change.after.memoryRevision=999;
  expect(()=>rebuildMemories([created.event,forged])).toThrow(/historical revision/);
  const legacy=structuredClone(event); const legacyChange=legacy.changes[0]!; if(legacyChange.verb==="create") { delete legacyChange.after.version; delete legacyChange.after.memoryRevision; delete legacyChange.after.recallId; delete legacyChange.after.judgment; legacyChange.after.signal="helpful"; }
  expect(memoryFeedbackRecordsFromEvent(legacy)[0]).not.toHaveProperty("version"); expect(()=>rebuildMemories([created.event,legacy])).not.toThrow();
  expect(()=>makeMemoryFeedbackEvent(context,stamp("legacy-write",200),created.memory,{signal:"helpful"})).toThrow(/version 2/);
 });
 it("uses one latest requester judgment only for equal-relevance ties and ignores stale revisions", async()=>{
  const sdk=new FoldSdk(new MemoryStore()); const context=memoryContext({audience:"workspace"});
  for(const [id,time] of [[MEMORY_A,100],[MEMORY_B,101]] as const) await sdk.recordMemory(context,stamp(`create-${time}`,time),{id,audience:"workspace",source:"test",applicability:{kind:"global"}});
  const ranker={descriptor:{id:"fixed",kind:"lexical" as const},rank:async()=>[{memoryId:MEMORY_B,score:0.5},{memoryId:MEMORY_A,score:0.5}]};
  await sdk.recordMemoryFeedback(context,stamp("helpful",200),MEMORY_A,input);
  const ranked=await sdk.rankMemories(context.access,{query:"test"},ranker); expect(ranked.memories[0]?.memory.id).toBe(MEMORY_A); expect(ranked.feedback?.basis).toBe("requester-latest-judgment-tiebreak-v1");
  expect((await sdk.rankMemories(access({principalId:"another"}),{query:"test"},ranker)).memories[0]?.memory.id).toBe(MEMORY_B);
  for(let i=0;i<5;i++) await sdk.recordMemoryFeedback(context,stamp(`repeat-${i}`,210+i),MEMORY_A,{...input,recallId:`arbitrary-${i}`});
  expect((await sdk.memoryFeedbackSummary(context.access,MEMORY_A)).helpful).toBe(1);
  await sdk.recordMemoryFeedback(context,stamp("unhelpful",220),MEMORY_A,{...input,judgment:"unhelpful",recallId:"new"});
  expect((await sdk.memoryFeedbackSummary(context.access,MEMORY_A))).toMatchObject({helpful:0,unhelpful:1,reviewSuggested:true});
  await sdk.reviseMemory(context,stamp("revise",230),MEMORY_A,{summary:"corrected"});
  expect((await sdk.rankMemories(context.access,{query:"test"},ranker)).feedback?.items).toEqual([]);
 });
 it("stages an entire mixed-revision batch once and rechecks membership on receipt retry",async()=>{
  const store=new MemoryStore();const sdk=new FoldSdk(store);const context={...memoryContext(),access:{...access(),organizationId:"org"}};
  await sdk.recordMemory(context,stamp("create",100),{id:MEMORY_A,source:"test",applicability:{kind:"global"}});
  const subject={organizationId:"org",workspaceId:"workspace-1",principalId:"user-a"};
  const items=[{stamp:stamp("one",200),memoryId:MEMORY_A,input},{stamp:stamp("two",201),memoryId:MEMORY_A,input:{...input,memoryRevision:99}}];
  await expect(sdk.recordMemoryFeedbackBatch(context,stamp("bad",200),items,subject)).rejects.toThrow(/revision/);expect(store.entries).toHaveLength(1);
  const valid=[items[0]!]; const result=await sdk.recordMemoryFeedbackBatch(context,stamp("batch",200),valid,subject); expect(store.entries).toHaveLength(2);
  expect(await sdk.recordMemoryFeedbackBatch(context,stamp("batch",200),valid,subject)).toEqual(result);expect(store.entries).toHaveLength(2);
  await sdk.forgetMemory(context,stamp("forget",300),MEMORY_A,"removed");
  await expect(sdk.recordMemoryFeedbackBatch(context,stamp("batch",200),valid,subject)).rejects.toThrow(/unavailable/);
 });
 it("rejects stale ranked claims when another SDK forgets memory during provider work",async()=>{
  const store=new MemoryStore(); const first=new FoldSdk(store), second=new FoldSdk(store); const context=memoryContext();
  await first.recordMemory(context,stamp("source",100),{id:MEMORY_A,source:"test",applicability:{kind:"global"}});
  let entered!:()=>void; const started=new Promise<void>((resolve)=>{entered=resolve;});
  let release!:()=>void; const waiting=new Promise<void>((resolve)=>{release=resolve;});
  const ranking=first.rankMemories(context.access,{query:"test"},{descriptor:{id:"slow",kind:"semantic"},rank:async()=>{entered();await waiting;return[{memoryId:MEMORY_A,score:1}];}});
  const rejected=expect(ranking).rejects.toThrow(/changed while ranking/);
  await started;await second.forgetMemory(context,stamp("forget-source",200),MEMORY_A,"removed");release();await rejected;
 });

});
