/** Captures values without invoking getters or toJSON. No expected answers belong in this module. */
export function snapshotOracleValue(value: unknown): string {
  const seen = new Set<object>();
  const visit = (input: unknown): unknown => {
    if (input === null) return ["null"];
    if (typeof input === "string" || typeof input === "boolean") return [typeof input, input];
    if (typeof input === "number") return ["number", Number.isNaN(input) ? "NaN" : input === Infinity ? "+Infinity" : input === -Infinity ? "-Infinity" : Object.is(input, -0) ? "-0" : input];
    if (typeof input !== "object") return [typeof input, typeof input === "bigint" ? String(input) : null];
    if (seen.has(input)) return ["cycle"];
    seen.add(input);
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const properties = Reflect.ownKeys(descriptors).map((key) => {
      const descriptor = Reflect.get(descriptors, key) as PropertyDescriptor;
      return [typeof key === "symbol" ? ["symbol", String(key)] : key,
        "value" in descriptor ? visit(descriptor.value) : ["accessor"],
        descriptor.enumerable === true, descriptor.configurable === true, descriptor.writable === true];
    });
    seen.delete(input);
    const prototype = Object.getPrototypeOf(input) as object | null;
    const constructor = prototype === null ? undefined : Object.getOwnPropertyDescriptor(prototype, "constructor");
    const constructorSource = typeof constructor?.value === "function" ? Function.prototype.toString.call(constructor.value) : "";
    // Stable across host/container realms; changing a caller object's prototype is still input mutation.
    const prototypeKind = prototype === null ? "null" : constructorSource === "function Object() { [native code] }" && Object.getPrototypeOf(prototype) === null ? "plain-object" :
      constructorSource === "function Array() { [native code] }" && Array.isArray(prototype) ? "plain-array" : "custom";
    return [Array.isArray(input) ? "array" : "object", prototypeKind, properties];
  };
  return JSON.stringify(visit(value));
}

/** Prevents a non-JSON result from becoming an apparently valid value during JSON transport. */
export function isOracleJson(value: unknown): boolean {
  const seen = new Set<object>();
  const visit = (input: unknown): boolean => {
    if (input === null || typeof input === "string" || typeof input === "boolean") return true;
    if (typeof input === "number") return Number.isFinite(input);
    if (typeof input !== "object" || seen.has(input)) return false;
    seen.add(input);
    const array = Array.isArray(input);
    const prototype = Object.getPrototypeOf(input) as object | null;
    if (prototype !== null) {
      const constructor = Object.getOwnPropertyDescriptor(prototype, "constructor");
      const expected = array ? "function Array() { [native code] }" : "function Object() { [native code] }";
      if (constructor === undefined || typeof constructor.value !== "function" || Function.prototype.toString.call(constructor.value) !== expected) return false;
      if (!array && Object.getPrototypeOf(prototype) !== null) return false;
      for (let parent: object | null = prototype; parent !== null; parent = Object.getPrototypeOf(parent) as object | null) {
        if (Object.getOwnPropertyDescriptor(parent, "toJSON") !== undefined) return false;
      }
    }
    const descriptors = Object.getOwnPropertyDescriptors(input);
    let valid = true;
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = Reflect.get(descriptors, key) as PropertyDescriptor;
      if (array && key === "length") continue;
      if (typeof key !== "string" || !descriptor.enumerable || !("value" in descriptor) || !visit(descriptor.value)) { valid = false; break; }
    }
    if (array) {
      if (Object.keys(input).length !== input.length) valid = false;
      for (let index = 0; valid && index < input.length; index += 1) if (!Object.hasOwn(descriptors, String(index))) valid = false;
    }
    seen.delete(input);
    return valid;
  };
  return visit(value);
}
