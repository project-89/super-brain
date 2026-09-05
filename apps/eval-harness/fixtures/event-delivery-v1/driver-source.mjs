import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const snapshot = (function snapshotOracleValue(value) {
  const seen = /* @__PURE__ */ new Set();
  const visit = (input) => {
    if (input === null) return ["null"];
    if (typeof input === "string" || typeof input === "boolean") return [typeof input, input];
    if (typeof input === "number") return ["number", Number.isNaN(input) ? "NaN" : input === Infinity ? "+Infinity" : input === -Infinity ? "-Infinity" : Object.is(input, -0) ? "-0" : input];
    if (typeof input !== "object") return [typeof input, typeof input === "bigint" ? String(input) : null];
    if (seen.has(input)) return ["cycle"];
    seen.add(input);
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const properties = Reflect.ownKeys(descriptors).map((key) => {
      const descriptor = Reflect.get(descriptors, key);
      return [
        typeof key === "symbol" ? ["symbol", String(key)] : key,
        "value" in descriptor ? visit(descriptor.value) : ["accessor"],
        descriptor.enumerable === true,
        descriptor.configurable === true,
        descriptor.writable === true
      ];
    });
    seen.delete(input);
    const prototype = Object.getPrototypeOf(input);
    const constructor = prototype === null ? void 0 : Object.getOwnPropertyDescriptor(prototype, "constructor");
    const constructorSource = typeof constructor?.value === "function" ? Function.prototype.toString.call(constructor.value) : "";
    const prototypeKind = prototype === null ? "null" : constructorSource === "function Object() { [native code] }" && Object.getPrototypeOf(prototype) === null ? "plain-object" : constructorSource === "function Array() { [native code] }" && Array.isArray(prototype) ? "plain-array" : "custom";
    return [Array.isArray(input) ? "array" : "object", prototypeKind, properties];
  };
  return JSON.stringify(visit(value));
});
const isJson = (function isOracleJson(value) {
  const seen = /* @__PURE__ */ new Set();
  const visit = (input) => {
    if (input === null || typeof input === "string" || typeof input === "boolean") return true;
    if (typeof input === "number") return Number.isFinite(input);
    if (typeof input !== "object" || seen.has(input)) return false;
    seen.add(input);
    const array = Array.isArray(input);
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== null) {
      const constructor = Object.getOwnPropertyDescriptor(prototype, "constructor");
      const expected = array ? "function Array() { [native code] }" : "function Object() { [native code] }";
      if (constructor === void 0 || typeof constructor.value !== "function" || Function.prototype.toString.call(constructor.value) !== expected) return false;
      if (!array && Object.getPrototypeOf(prototype) !== null) return false;
      for (let parent = prototype; parent !== null; parent = Object.getPrototypeOf(parent)) {
        if (Object.getOwnPropertyDescriptor(parent, "toJSON") !== void 0) return false;
      }
    }
    const descriptors = Object.getOwnPropertyDescriptors(input);
    let valid = true;
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = Reflect.get(descriptors, key);
      if (array && key === "length") continue;
      if (typeof key !== "string" || !descriptor.enumerable || !("value" in descriptor) || !visit(descriptor.value)) {
        valid = false;
        break;
      }
    }
    if (array) {
      if (Object.keys(input).length !== input.length) valid = false;
      for (let index = 0; valid && index < input.length; index += 1) if (!Object.hasOwn(descriptors, String(index))) valid = false;
    }
    seen.delete(input);
    return valid;
  };
  return visit(value);
});
const packet = JSON.parse(readFileSync(0, 'utf8'));
if (packet.version !== 1 || typeof packet.code !== 'string' || !Array.isArray(packet.cases)) throw new Error('invalid driver packet');
for (const test of packet.cases) {
  const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false }, microtaskMode: 'afterEvaluate' });
  Object.defineProperty(context, '__inputJson', { value: test.inputJson, writable: false, configurable: true });
  const input = vm.runInContext('JSON.parse(__inputJson)', context, { timeout: 250 });
  delete context.__inputJson;
  Object.defineProperty(context, '__input', { value: undefined, writable: true, configurable: false });
  Object.defineProperty(context, '__candidate', { value: undefined, writable: true, configurable: false });
  const inputBefore = snapshot(input);
  let module;
  try {
    module = new vm.SourceTextModule(packet.code, { context, identifier: 'candidate.mjs', importModuleDynamically() { throw new Error('imports disabled'); } });
    await module.link(() => { throw new Error('imports disabled'); });
    await module.evaluate({ timeout: 250 });
    if (typeof module.namespace.reduceDelivery !== 'function') throw new Error('reduceDelivery export missing');
    Object.defineProperty(context, '__candidate', { value: module.namespace.reduceDelivery, writable: false, configurable: false });
    Object.defineProperty(context, '__input', { value: input, writable: false, configurable: false });
  } catch {
    process.stdout.write(JSON.stringify({ id: test.id, unavailable: 'module-load' }) + '\n');
    continue;
  }
  let value, threw = false, timedOut = false;
  try {
    value = vm.runInContext('__candidate(__input.state, __input.arrivals)', context, { timeout: 250 });
  } catch (error) {
    threw = true;
    timedOut = error?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT';
  }
  if (timedOut) { process.stdout.write(JSON.stringify({ id: test.id, unavailable: 'execution-timeout' }) + '\n'); continue; }
  let inputAfter;
  try { inputAfter = snapshot(input); }
  catch { process.stdout.write(JSON.stringify({ id: test.id, unavailable: 'observer-failure' }) + '\n'); continue; }
  let observation;
  if (threw) observation = { id: test.id, status: 'threw', inputBefore, inputAfter };
  else {
    let outputIsJson = false, detached;
    try { outputIsJson = isJson(value); if (outputIsJson) detached = structuredClone(value); }
    catch { outputIsJson = false; }
    observation = { id: test.id, status: 'returned', ...(outputIsJson ? { value: detached } : {}), outputIsJson,
      inputBefore, inputAfter, freshState: value !== input.state,
      freshEvents: outputIsJson && value !== null && typeof value === 'object' && Object.getOwnPropertyDescriptor(value, 'events')?.value !== input.state?.events };
  }
  process.stdout.write(JSON.stringify(observation) + '\n');
}
