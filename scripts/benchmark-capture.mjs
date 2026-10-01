import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { PostgresFoldDatabase } from '../packages/fold-postgres/dist/index.js';
import { FoldSdk, authorizeEventAccess } from '../packages/fold-sdk/dist/index.js';
import { rebuildMemories, recallMemoryCorpus } from '../packages/fold-epistemic/dist/index.js';
import { measureCaptureRecall } from './performance-capture.mjs';
import { tenant, access, digest } from './performance-fixture.mjs';

const require=createRequire(new URL('../packages/fold-postgres/package.json',import.meta.url)),{Pool}=require('pg');
const connectionString=process.env.FOLD_TEST_DATABASE_URL;
if(!connectionString||!['127.0.0.1','localhost'].includes(new URL(connectionString).hostname))throw new Error('Explicit loopback disposable test DB required');
if(process.versions.node.split('.')[0]!=='24')throw new Error('Node24 required');
const label=process.argv[2]??'before',output=resolve(process.argv[3]??'.data/performance/phase6');
const schema=`fold_benchmark_capture_${Date.now()}`;
const database=new PostgresFoldDatabase({connectionString,schema,requireRlsEnforcement:true}),pool=new Pool({connectionString});
await mkdir(output,{recursive:true,mode:0o700});
const bytes=await readFile(resolve(output,'history.jsonl'));const entries=bytes.toString().trim().split('\n').map(line=>JSON.parse(line));
const report={version:1,label,node:process.versions.node,fixtureSha256:digest(bytes),eventCount:entries.length,correctness:{},startedAt:new Date().toISOString()};
try {
  assert.equal(entries.length,40000);await database.open();await database.store(tenant).appendMany(entries);
  const sdk=new FoldSdk(database.store(tenant));
  for(const subject of [access,{...access,principalId:'principal-1',workspaceRole:'member',spaceRoles:{}}]) {
    const events=entries.filter(({event})=>authorizeEventAccess(event,subject).allowed).map(({event})=>event);
    const expected=recallMemoryCorpus(rebuildMemories(events),subject,{includeNeedsReview:true});
    const actual=[];let cursor;
    do{const page=await sdk.recallMemoryPage(subject,{limit:100,includeNeedsReview:true,...(cursor?{cursor}:{})});actual.push(...page.memories.map(({memory})=>memory));cursor=page.nextCursor;}while(cursor);
    assert.deepEqual(actual,expected);report.correctness[subject.principalId]={completeCurrentRows:actual.length,fullRowsSha256:digest(JSON.stringify(actual)),fields:'all serialized fields including exact revisions, evidence, applicability, derivation refs and currentness'};
  }
  await writeFile(resolve(output,`${label}-replay-audit.json`),JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log(JSON.stringify({stage:'full-row-audit',correctness:report.correctness}));
  report.captureToRecall=await measureCaptureRecall(database);
  report.completedAt=new Date().toISOString();await writeFile(resolve(output,`${label}-capture.json`),JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(report));
}finally{await database.close();await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await pool.end();}
