/** Cost-bounded LRU. Costs include shared-reference arrays, not duplicate source payloads. */
export class BoundedCache<K, V> {
  private readonly items = new Map<K, { value: V; bytes: number }>();
  private retained = 0;
  constructor(readonly maxBytes: number, readonly maxEntries: number, private readonly cost: (value: V) => number) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || !Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new TypeError("invalid cache bounds");
  }
  get size(): number { return this.items.size; }
  get bytes(): number { return this.retained; }
  get(key: K): V | undefined {
    const item = this.items.get(key);
    if (item === undefined) return undefined;
    this.items.delete(key); this.items.set(key, item); return item.value;
  }
  set(key: K, value: V): this {
    this.delete(key);
    const bytes = this.cost(value);
    if (!Number.isFinite(bytes) || bytes < 0 || bytes > this.maxBytes) return this;
    while (this.items.size >= this.maxEntries || this.retained + bytes > this.maxBytes) this.delete(this.items.keys().next().value!);
    this.items.set(key, { value, bytes }); this.retained += bytes; return this;
  }
  delete(key: K): boolean {
    const item = this.items.get(key); if (item === undefined) return false;
    this.retained -= item.bytes; return this.items.delete(key);
  }
  clear(): void { this.items.clear(); this.retained = 0; }
}

export function serializedCost(value: unknown): number {
  // JSON wire bytes undercount JS strings and Map/object bookkeeping; use a conservative factor.
  return 2 * new TextEncoder().encode(JSON.stringify(value, (_key, item: unknown) => item instanceof Map ? [...item] : item)).byteLength;
}

export function immutable<T>(value: T): T {
  const seen = new WeakSet<object>();
  const visit = (item: unknown): void => {
    if (item === null || typeof item !== "object" || seen.has(item)) return;
    seen.add(item);
    if (!Object.isFrozen(item)) Object.freeze(item);
    for (const child of Object.values(item)) visit(child);
  };
  visit(value); return value;
}

export async function sha256(value: string): Promise<string> {
  const bytes = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
