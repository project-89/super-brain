import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { indexTree } from "@_89/fold-trace";
import { DEFAULT_FIXTURE_DIRECTORY, evaluateOracleResults, frozenDecisionTree, frozenOracleCases, verifyFrozenFixture, type OracleObservation } from "../src/oracle.js";
import { isOracleJson, snapshotOracleValue } from "../src/snapshot.js";

type Reducer = (state: unknown, arrivals: unknown) => unknown;
const authoredFixture = await readFile(new URL("./fixtures/known-good.mjs", import.meta.url), "utf8");
// These are fixed repository-authored test fixtures, never external/generated submissions.
function fixture(source = authoredFixture): Reducer { return runInNewContext(`${source.replace("export function", "function")}\nreduceDelivery`) as Reducer; }
async function observe(reducer: Reducer): Promise<OracleObservation[]> {
  return (await frozenOracleCases()).map((test) => {
    const input = JSON.parse(test.inputJson) as { state: unknown; arrivals: unknown };
    const inputBefore = snapshotOracleValue(input);
    try {
      const value = reducer(input.state, input.arrivals);
      return { id: test.id, status: "returned", value, outputIsJson: isOracleJson(value), inputBefore, inputAfter: snapshotOracleValue(input), freshState: value !== input.state,
        freshEvents: (value as {events?:unknown})?.events !== (input.state as {events?:unknown})?.events };
    } catch { return { id: test.id, status: "threw", inputBefore, inputAfter: snapshotOracleValue(input) }; }
  });
}

it("accepts an authored correct implementation including harmless shared payloads", async () => {
  const cases = await frozenOracleCases();
  expect(cases).toHaveLength(59);
  expect(await evaluateOracleResults(cases, await observe(fixture()))).toMatchObject({availability:"available",acceptance:"passed",passed:59,failed:0,unavailable:0,evaluation:{confidence:1}});
});
it.each([
  ["whitespace-tolerant decimal validation", "value.trim() !== value || !/^(0|[1-9][0-9]*)$/.test(value)", "!/^(0|[1-9][0-9]*)$/.test(value.trim())", "invalid-position-trailing-newline"],
  ["lossy number positions", "const number = BigInt(value);", "const number = Number(value);", "exact-large-sequence"],
  ["event-time filtering", "if (sequence > initial)", "if (BigInt(arrival.event.t) > initial)", "delayed-backdated"],
  ["raw JSON key ordering", "const immutable = canonical(event);", "const immutable = JSON.stringify(event);", "key-order-irrelevant"],
  ["locale-sensitive ID sort", "(a.id < b.id ? -1 : a.id > b.id ? 1 : 0)", "a.id.localeCompare(b.id)", "ordinary-id-order"],
  ["skipping old validation", "const immutable = remember(arrival.event);", "if (sequence <= initial) continue; const immutable = remember(arrival.event);", "older-conflict-validated"],
  ["payload-based occurrence dedup", "retained.set(arrival.event.id,arrival.event)", "retained.set(JSON.stringify(arrival.event.payload),arrival.event)", "equal-payload-distinct-ids"],
  ["changing input prototype", "const initial = position(state.checkpoint);", "Object.setPrototypeOf(state, null); const initial = position(state.checkpoint);", "empty-initial"],
  ["sorting input in place", "const initial = position(state.checkpoint);", "state.events.sort((a,b)=>a.t-b.t); const initial = position(state.checkpoint);", "empty-canonical-order"],
  ["ignoring duplicate sequence conflicts", "throw new Error('sequence conflict');", "void 0;", "duplicate-position-different-id"],
] as const)("rejects meaningful mutant: %s", async (_label, before, after, caseId) => {
  expect(authoredFixture).toContain(before);
  const result = await evaluateOracleResults(await frozenOracleCases(), await observe(fixture(authoredFixture.replace(before, after))));
  expect(result.acceptance).toBe("failed"); expect(result.checks.find((check)=>check.id===caseId)?.status).toBe("fail");
});
it("does not fabricate acceptance from missing, duplicated or mismatched driver observations", async () => {
  const cases = await frozenOracleCases(); const observations = await observe(fixture());
  for (const actual of [[], observations.slice(1), [...observations, observations[0]!], [{...observations[0]!,id:"unknown"},...observations.slice(1)]]) {
    const result = await evaluateOracleResults(cases, actual);
    expect(result).toMatchObject({availability:"unavailable",acceptance:"unavailable",evaluation:{confidence:null}});
  }
  const changed = observations.map((value,index)=>index===0?{...value,inputBefore:"wrong-input"}:value);
  expect((await evaluateOracleResults(cases,changed)).checks[0]?.status).toBe("unavailable");
});
it("requires a fresh state but permits safe retained-array structural sharing", async () => {
  const cases = await frozenOracleCases(); const observations = await observe(fixture());
  expect((await evaluateOracleResults(cases, observations.map(value=>({...value,freshEvents:false})))).acceptance).toBe("passed");
  expect((await evaluateOracleResults(cases, observations.map(value=>({...value,freshState:false})))).acceptance).toBe("failed");
});
it("rejects non-JSON outputs before serialization and captures mutation without getters", () => {
  let invoked=false; const accessor=Object.defineProperty({},"x",{get(){invoked=true;return 1;},enumerable:true});
  const hidden=Object.defineProperty({},"hidden",{value:1});
  const holeAndExtra = Object.assign([,1], { foo: 2 });
  const custom=Object.create({toJSON(){return {};}}) as unknown;
  for(const value of [new Date(),custom,hidden,accessor,[,1],holeAndExtra,{x:Infinity},{x:undefined},()=>1]) expect(isOracleJson(value)).toBe(false);
  snapshotOracleValue(accessor); expect(invoked).toBe(false);
  expect(isOracleJson(runInNewContext('({a:[1,null,{b:true}]})'))).toBe(true);
  expect(isOracleJson(Object.assign(Object.create(null),{toJSON:"ordinary data"}))).toBe(true);
  expect(snapshotOracleValue({x:Infinity})).not.toBe(snapshotOracleValue({x:null}));
});
it("loads the independent valid decision tree and verifies every frozen hash", async()=>{
  const tree=await frozenDecisionTree(); expect(indexTree(tree).nodes.size).toBeGreaterThan(5);
  const manifest=await verifyFrozenFixture(); expect(manifest.taskId).toBe(tree.taskId);
});

it("rejects edited frozen artifacts and a different executing oracle module", async()=>{
  const root=await mkdtemp(join(tmpdir(),"frozen-oracle-"));
  try {
    await cp(DEFAULT_FIXTURE_DIRECTORY,root,{recursive:true});
    await verifyFrozenFixture(root);
    const manifest=JSON.parse(await readFile(join(root,"freeze-manifest.json"),"utf8"));
    await writeFile(join(root,"freeze-manifest.json"),JSON.stringify({...manifest,oracleModuleSha256:["0".repeat(64)]}));
    await expect(verifyFrozenFixture(root)).rejects.toThrow("Executing oracle module");
    await writeFile(join(root,"freeze-manifest.json"),JSON.stringify(manifest));
    await writeFile(join(root,"public-task.md"),"changed after freeze");
    await expect(verifyFrozenFixture(root)).rejects.toThrow("Frozen artifact changed");
  } finally { await rm(root,{recursive:true,force:true}); }
});
