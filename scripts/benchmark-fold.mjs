import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { PostgresFoldDatabase } from '../packages/fold-postgres/dist/index.js';
import { FoldSdk, authorizeEventAccess } from '../packages/fold-sdk/dist/index.js';
import { rebuildMemories, recallMemories } from '../packages/fold-epistemic/dist/index.js';
import { LocalLexicalMemoryRanker } from '../apps/api/dist/index.js';
import { performanceFixture, tenant, access, context, uuid, stamp, digest } from './performance-fixture.mjs';

const require = createRequire(new URL('../packages/fold-postgres/package.json', import.meta.url));
const { Pool } = require('pg');
const connectionString = process.env.FOLD_TEST_DATABASE_URL;
if (!connectionString || !['127.0.0.1', 'localhost'].includes(new URL(connectionString).hostname)) throw new Error('FOLD_TEST_DATABASE_URL must name an explicit loopback disposable database');
if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Benchmark requires supported Node 24');
const mode = process.argv[2] ?? 'before';
const output = resolve(process.argv[3] ?? '.data/performance/phase6');
const schema = process.env.FOLD_BENCH_SCHEMA ?? `fold_benchmark_${mode.replace(/[^a-z0-9_]/g, '')}_${Date.now()}`;
if (!/^fold_benchmark_[a-z0-9_]+$/.test(schema)) throw new Error('Only uniquely named disposable benchmark schemas are allowed');
const summary = values => { const sorted = [...values].sort((a,b) => a-b); return { samples: values.length, p50Ms: sorted[Math.floor((sorted.length-1)*0.5)], p95Ms: sorted[Math.ceil((sorted.length-1)*0.95)], observationsMs: values }; };
const timed = async action => { const start = performance.now(); const value = await action(); return { value, ms: performance.now() - start }; };
const sample = async (count, action) => { const values=[]; for(let i=0;i<count;i++) values.push((await timed(()=>action(i))).ms); return summary(values); };
const save = async (name, value) => writeFile(resolve(output, name), JSON.stringify(value,null,2)+'\n',{mode:0o600});
await mkdir(output,{recursive:true,mode:0o700});
const database = new PostgresFoldDatabase({connectionString,schema,requireRlsEnforcement:true});
if (mode === 'cold') {
  const start=performance.now(); await database.open(); const sdk=new FoldSdk(database.store(tenant));
  const result=await sdk.recallMemoryPage(access,{limit:100,includeNeedsReview:true});
  console.log(JSON.stringify({openAndRecallMs:performance.now()-start,processElapsedMs:process.uptime()*1000,rssBytes:process.memoryUsage().rss,heapUsedBytes:process.memoryUsage().heapUsed,visibleMemories:result.total}));
  await database.close();
} else {
  const pool=new Pool({connectionString});
  const report={version:1,label:mode,startedAt:new Date().toISOString(),node:process.versions.node,schema,operations:{},correctness:{},notes:['Synthetic data only. Setup is excluded from operation latency. Samples are descriptive, not acceptance thresholds.','Late arrivals are in the initial ingestion tail. Canonical replay remains the correctness oracle.']};
  try {
    const built=performanceFixture(); assert.equal(built.entries.length,40000);
    await writeFile(resolve(output,'history.jsonl'),built.encoded,{mode:0o600,flag:'wx'}).catch(async error=>{if(error.code!=='EEXIST')throw error;assert.equal(digest(await readFile(resolve(output,'history.jsonl'))),built.metadata.sha256,'baseline input must remain byte-identical');});
    report.fixture=built.metadata;
    report.postgres=(await pool.query('SELECT version() AS version')).rows[0].version;
    await database.open();
    report.setupMs=(await timed(()=>database.store(tenant).appendMany(built.entries))).ms;
    await save(`${mode}-progress.json`,report);
    console.log(JSON.stringify({stage:'seeded',...built.metadata,setupMs:report.setupMs}));
    const cold=[];
    for(let i=0;i<3;i++) { const result=spawnSync(process.execPath,[new URL(import.meta.url).pathname,'cold',output],{env:{...process.env,FOLD_BENCH_SCHEMA:schema},encoding:'utf8',timeout:180000,maxBuffer:1024*1024}); if(result.status!==0)throw new Error(`cold subprocess failed: ${result.stderr}`); cold.push(JSON.parse(result.stdout.trim())); }
    report.coldStart=cold;
    const sdk=new FoldSdk(database.store(tenant));
    const all=await sdk.recallMemoryPage(access,{limit:100,includeNeedsReview:true}); report.fixture.ownerVisibleMemories=all.total;
    const other={...access,principalId:'principal-1',workspaceRole:'member',spaceRoles:{}};
    report.fixture.memberWithoutSpacesVisibleMemories=(await sdk.recallMemoryPage(other,{limit:100,includeNeedsReview:true})).total;
    report.operations.recall=await sample(12,()=>sdk.recallMemories(access,{limit:20}));
    report.operations.lexicalRank=await sample(12,()=>sdk.rankMemories(access,{query:'revision delivery',limit:20},new LocalLexicalMemoryRanker()));
    report.rssAfterReadsBytes=process.memoryUsage().rss;
    const full=(await database.store(tenant).read()).entries.filter(({event})=>authorizeEventAccess(event,access).allowed).map(({event})=>event);
    const replay=await timed(async()=>rebuildMemories(full)); report.operations.fullReplay={samples:1,p50Ms:replay.ms,p95Ms:replay.ms};
    const expected=recallMemories(replay.value,access,{limit:100,includeNeedsReview:true});
    assert.deepEqual(await sdk.recallMemories(access,{limit:100,includeNeedsReview:true}),expected); report.correctness.fullReplay=true;
    assert.equal((await new FoldSdk(database.store({...tenant,organizationId:'synthetic-unrelated-org'})).recallMemories(access)).length,0); report.correctness.tenantIsolation=true;
    await save(`${mode}-progress.json`,report); console.log(JSON.stringify({stage:'reads',coldStart:cold,operations:report.operations}));
    report.operations.append=await sample(8,i=>sdk.recordMemory(context(),stamp(`benchmark-append-${i}`,500000+i*10),{id:uuid(50000+i),source:'synthetic-benchmark',audience:'workspace',applicability:{kind:'global'},summary:`Benchmark append ${i}`}));
    const offered=(await sdk.recallMemories(access,{limit:100})).map(({memory})=>memory);
    report.operations.offeredFeedbackBatch100=await sample(3,async i=>{
      const base=600000+i*1000;
      const items=offered.map((memory,j)=>({stamp:stamp(`benchmark-offered-${i}-${String(j).padStart(3,'0')}`,base+j),memoryId:memory.id,input:{version:2,memoryRevision:memory.revision,recallId:`benchmark-recall-${i}`,signal:'offered'}}));
      const commandStamp=stamp(`benchmark-batch-${i}`,base);
      const result=await sdk.recordMemoryFeedbackBatch(context(),commandStamp,items,{...tenant,principalId:access.principalId}); assert.equal(result.events.length,100);
    });
    const gate=[];
    for(let i=0;i<30;i++) gate.push((await timed(async()=>{const client=await pool.connect();try{await client.query('BEGIN');await client.query("SELECT pg_advisory_xact_lock_shared(hashtext('fold-schema-v1'))");await client.query('ROLLBACK');}finally{client.release();}})).ms);
    report.operations.sharedSchemaGate=summary(gate);
    const tail=await database.store(tenant).read(); const authorized=tail.entries.filter(({event})=>authorizeEventAccess(event,access).allowed).map(({event})=>event);
    assert.deepEqual(await sdk.recallMemories(access,{limit:100,includeNeedsReview:true}),recallMemories(rebuildMemories(authorized),access,{limit:100,includeNeedsReview:true}));
    report.correctness.afterWritesReplay=true;report.finalRevision=tail.revision;report.rssFinalBytes=process.memoryUsage().rss;report.heapUsedFinalBytes=process.memoryUsage().heapUsed;
    report.completedAt=new Date().toISOString();await save(`${mode}.json`,report);console.log(JSON.stringify({stage:'complete',report:resolve(output,`${mode}.json`),operations:report.operations,rssFinalBytes:report.rssFinalBytes}));
  } finally {await database.close();await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await pool.end();}
}
