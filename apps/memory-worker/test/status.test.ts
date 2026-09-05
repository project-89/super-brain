import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import type { SuperBrainClient } from "@_89/super-brain-client";
import { publishWorkerProcessingStatus } from "../src/status.js";
import { TranscriptMemoryWorker } from "../src/worker.js";

const subject={organizationId:"org",workspaceId:"workspace",principalId:"worker"};
const coverage={pending:1,waiting:2,retry:3,completed:4,excluded:5,exhausted:6,oldestPendingAt:1000,
  byKind:{"extract-run":1,"extract-turn":1,propose:1,"verify-trajectory":1,"cognition-plan":1,synthesis:1}};
it("publishes an owner-only aggregate allowlist with measured lag and no job payloads",async()=>{
  const root=await mkdtemp(join(tmpdir(),"worker-status-"));try{
    const path=join(root,"status.json");
    await publishWorkerProcessingStatus(path,{version:1,status:"running",subject,observedAt:new Date(2000).toISOString(),coverage,
      payload:"PRIVATE_JOB_BODY",path:"PRIVATE_PATH",token:"PRIVATE_TOKEN"} as any);
    const text=await readFile(path,"utf8");expect(JSON.parse(text)).toEqual({version:1,status:"running",subject,observedAt:new Date(2000).toISOString(),coverage,lagMs:1000});
    expect(text).not.toContain("PRIVATE_");expect((await stat(path)).mode & 0o777).toBe(0o600);
  }finally{await rm(root,{recursive:true,force:true});}
});
it("publishes running/stopped lifecycle and does not fail processing when optional publication fails",async()=>{
  const root=await mkdtemp(join(tmpdir(),"worker-status-life-"));
  const api={identity:async()=>subject} as unknown as SuperBrainClient;
  const worker=new TranscriptMemoryWorker({client:api,stateRoot:join(root,"jobs"),vaultRoot:join(root,"vault"),statusFile:join(root,"status.json")});
  try{
    await worker.drainJobs();expect(JSON.parse(await readFile(join(root,"status.json"),"utf8"))).toMatchObject({status:"running",coverage:{pending:0,completed:0}});
    await worker.close();expect(JSON.parse(await readFile(join(root,"status.json"),"utf8"))).toMatchObject({status:"stopped"});
    const blocked=join(root,"blocked");await writeFile(blocked,"fixture");const warning=vi.fn();
    const other=new TranscriptMemoryWorker({client:api,stateRoot:join(root,"other-jobs"),vaultRoot:join(root,"vault"),statusFile:join(blocked,"status.json"),reportWarning:warning});
    try{await expect(other.drainJobs()).resolves.toEqual({proposed:0,promoted:0});expect(warning).toHaveBeenCalledWith("Processing status publication is unavailable");}finally{await other.close();}
  }finally{await worker.close();await rm(root,{recursive:true,force:true});}
});
