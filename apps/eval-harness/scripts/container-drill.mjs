#!/usr/bin/env node
// Only authored synthetic modules; this drill never contacts a model provider.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { containerDriverSource, executeInContainer, evaluateOracleResults, frozenOracleCases, NODE_IMAGE, sha256 } from '../dist/index.js';
const cases = await frozenOracleCases();
const valid = cases.find(test => test.expected.kind === 'return');
const invalid = cases.find(test => test.expected.kind === 'throw');
assert(valid && invalid);
const run = async (code, selected) => {
  const result = await executeInContainer(code, selected, { image: NODE_IMAGE });
  assert.equal(result.process.exitCode, 0, `Container failed: ${result.protocolIssues.join(',')}`);
  return result;
};
const reference = await run(await readFile(fileURLToPath(new URL('../test/fixtures/known-good.mjs', import.meta.url)), 'utf8'), cases);
const evaluation = await evaluateOracleResults(cases, reference.observations);
assert.equal(evaluation.acceptance, 'passed'); assert.equal(evaluation.passed, 59);
const hostile = await run("export function reduceDelivery() { return new Proxy({}, { ownKeys() { throw new Error('observer trap'); } }); }", [invalid]);
assert.equal(hostile.observations[0]?.status, 'returned'); assert.equal(hostile.observations[0]?.outputIsJson, false);
assert.equal((await evaluateOracleResults([invalid], hostile.observations)).acceptance, 'failed');
const nullResult = await run('export function reduceDelivery() { return null; }', [valid]);
assert.equal(nullResult.observations[0]?.status, 'returned');
assert.equal((await evaluateOracleResults([valid], nullResult.observations)).acceptance, 'failed');
const setter = await run("Object.defineProperty(globalThis, '__candidate', { set() {}, get() { return () => { throw new Error('substitute'); }; } }); export function reduceDelivery() { return null; }", [invalid]);
assert.equal(setter.observations.length, 0); assert.equal((await evaluateOracleResults([invalid], setter.observations)).acceptance, 'unavailable');
const inputSetter = await run("Object.defineProperty(globalThis, '__input', { set() {} }); export function reduceDelivery() { return null; }", [valid]);
assert.equal(inputSetter.observations.length, 0);
const prototype = await run('export function reduceDelivery(state) { Object.setPrototypeOf(state, null); return { ...state }; }', [valid]);
assert.notEqual(prototype.observations[0]?.inputBefore, prototype.observations[0]?.inputAfter);
assert.equal((await evaluateOracleResults([valid], prototype.observations)).acceptance, 'failed');
const forbiddenImport = await run("import fs from 'node:fs'; export function reduceDelivery() { return fs; }", [valid]);
assert.equal(forbiddenImport.observations.length, 0);
const timeout = await run('export function reduceDelivery() { while (true) {} }', [valid]);
assert.equal(timeout.observations.length, 0); assert.ok(timeout.protocolIssues.includes('unavailable-driver-observation'));
const globals = await run("export function reduceDelivery() { return { process: typeof process, fetch: typeof fetch, inputJson: typeof globalThis.__inputJson }; }", [valid]);
assert.deepEqual(globals.observations[0]?.value, { process: 'undefined', fetch: 'undefined', inputJson: 'undefined' });
console.log(JSON.stringify({ kind: 'authored-synthetic-container-drill', image: NODE_IMAGE, driverSha256: sha256(containerDriverSource()), knownGood: { total: evaluation.total, passed: evaluation.passed }, boundaryRegressions: 8 }));
