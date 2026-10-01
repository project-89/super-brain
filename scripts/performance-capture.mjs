import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { FoldSdk } from '../packages/fold-sdk/dist/index.js';
import { SuperBrainClient } from '../packages/super-brain-client/dist/index.js';
import { createApiServer, StaticIdentityDirectory } from '../apps/api/dist/index.js';
import { CaptureEngine, CaptureReceiptQueue, DurableSpool, HookVault, StateStore, parseCaptureConfig, receiptEncryptionKey } from '../apps/capture-daemon/dist/index.js';
import { TranscriptMemoryWorker, createCapturedEventVerifier } from '../apps/memory-worker/dist/index.js';
import { tenant } from './performance-fixture.mjs';

/** Actual private receipt -> capture -> HTTP -> durable worker -> HTTP recall.
 * Dispatch/drain is explicit, so this does not include periodic watcher scheduling delay.
 */
export async function measureCaptureRecall(database) {
  const root=await mkdtemp(join(tmpdir(),'fold-performance-capture-'));
  const repository=join(root,'repository');await mkdir(repository);
  execFileSync('git',['init','-q',repository]);await writeFile(join(repository,'input.txt'),'Synthetic performance fixture\n');
  execFileSync('git',['-C',repository,'add','input.txt']);
  execFileSync('git',['-C',repository,'-c','user.name=Synthetic','-c','user.email=synthetic@example.test','commit','-qm','Synthetic input']);
  const sensorId='urn:sensor:performance-capture';
  const config=parseCaptureConfig({apiUrl:'http://127.0.0.1:1',...tenant,apiToken:'synthetic-test-token',sensorId,hookToken:'synthetic-hook',operatorToken:'synthetic-operator',stateRoot:join(root,'capture'),vaultRoot:join(root,'vault'),port:8377,bindHost:'127.0.0.1',heartbeatWindowMs:90000,heartbeatIntervalMs:30000,reasoningPolicy:'exclude'});
  const key=await receiptEncryptionKey(config);const spool=new DurableSpool(config.stateRoot);const state=new StateStore(config.stateRoot);
  const engine=new CaptureEngine(config,state,new HookVault(config.vaultRoot,key),spool);await engine.initialize();
  const queue=new CaptureReceiptQueue(engine,key);
  const sdk=new FoldSdk(database.store(tenant));
  const directory=new StaticIdentityDirectory({'synthetic-test-token':{principalId:'performance-worker',author:{kind:'sensor',id:sensorId},organizations:{[tenant.organizationId]:{role:'owner',workspaces:{[tenant.workspaceId]:{role:'admin'}}}}}});
  const server=createApiServer({authenticator:directory,memberships:directory,sdks:{sdkFor:async()=>sdk}});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const client=new SuperBrainClient({baseUrl:`http://127.0.0.1:${server.address().port}`,...tenant,token:'synthetic-test-token'});
  const worker=new TranscriptMemoryWorker({client,vaultRoot:config.vaultRoot,stateRoot:join(root,'worker'),autoPromote:true,continuousCognition:false,verifyCapturedEvent:createCapturedEventVerifier({stateRoot:config.stateRoot,vaultRoot:config.vaultRoot,receiptEncryptionKey:key,vaultEncryptionKey:key,trustedSensorId:sensorId,...tenant})});
  const observations=[], seen=new Set();
  try {
    for(let i=0;i<3;i++) {
      const sessionId=`performance-${i}`,common={session_id:sessionId,cwd:repository};
      await engine.ingest('codex',{...common,hook_event_name:'UserPromptSubmit',prompt:'Review the synthetic exact revision',task_key:`performance-task-${i}`});
      const acceptance=await engine.acceptanceContext('codex',sessionId);assert.ok(acceptance.revisionId);
      const started=performance.now();
      await queue.accept({version:1,id:`performance-approval-${i}`,source:'codex',occurredAt:new Date().toISOString(),endpoint:'/decision',payload:{...common,hook_event_name:'HumanDecision',summary:`Accepted synthetic performance revision ${i}`,acceptance:{version:1,taskId:acceptance.taskId,attemptId:acceptance.attemptId,revisionId:acceptance.revisionId,verdict:'success'}}},{kind:'local-operator',principalId:`operator:${sensorId}`,authenticatedAt:new Date().toISOString()});
      await queue.drain();
      const event=(await spool.list()).flatMap(({job})=>job.kind==='event'?[job.event]:[]).find(event=>!seen.has(event.id)&&event.changes.some(change=>change.verb==='create'&&change.after.observation==='human_decision'));
      assert.ok(event,'captured approval must be present');seen.add(event.id);
      await client.appendEvent(event);
      const processed=await worker.processLiveEvent(event);assert.equal(processed.promoted,1);
      const packet=await client.recallMemoryPacket({sources:['live-human-decision'],limit:100});
      assert.ok(packet.memories.some(({memory})=>memory.evidence?.some(ref=>ref.eventId===event.id)),'new exact captured evidence must be recallable');
      observations.push(performance.now()-started);console.log(JSON.stringify({stage:"capture-sample",sample:i,milliseconds:observations.at(-1)}));
    }
    return {samples:observations.length,observationsMs:observations,boundary:'private receipt acceptance through captured event, HTTP append, explicit durable worker drain, attested promotion and HTTP recall; excludes periodic watcher scheduling',verified:true};
  } finally {
    await worker.close();
    await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
    await rm(root,{recursive:true,force:true});
  }
}
