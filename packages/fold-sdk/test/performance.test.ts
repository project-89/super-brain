import { expect, it } from "vitest";
import { rebuildMemories, recallMemoryCorpus } from "@_89/fold-epistemic";
import type { FoldLogEntry } from "@_89/fold";
import { BoundedCache, FoldSdk, immutable, type FoldSdkProjectionCheckpoint, type FoldSdkProjectionCheckpointKey } from "../src/index.js";
import { MemoryStore, MEMORY_A, MEMORY_B, memoryContext, access, stamp } from "./helpers.js";

class CheckpointStore extends MemoryStore {
  readonly immutableSnapshots = true;
  readonly checkpoints = new Map<string, FoldSdkProjectionCheckpoint>();
  async revision(): Promise<string> { return String(this.entries.length); }
  override async read() { return { ...await super.read(), revision: await this.revision() }; }
  override async append(entry: FoldLogEntry) { this.entries.push(immutable(entry)); }
  override async appendMany(entries: readonly FoldLogEntry[]) { for (const entry of entries) await this.append(entry); }
  async readProjectionCheckpoint(key: FoldSdkProjectionCheckpointKey) { return this.checkpoints.get(key.projection); }
  async writeProjectionCheckpoint(checkpoint: FoldSdkProjectionCheckpoint) {
    if (checkpoint.sourceRevision !== await this.revision()) return false;
    // JSONB can reorder object properties while preserving the exact state.
    this.checkpoints.set(checkpoint.projection, JSON.parse(JSON.stringify(checkpoint, (_key, value) => value !== null && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).reverse()) : value)));
    return true;
  }
}

it("deeply freezes children of an already shallow-frozen snapshot", () => {
  const value = Object.freeze({ nested: { claim: "original" }, list: [{ value: 1 }] });
  immutable(value);
  expect(() => { value.nested.claim = "altered"; }).toThrow();
  expect(() => { value.list[0]!.value = 2; }).toThrow();
  const cyclic: { self?: unknown } = {}; cyclic.self = cyclic;
  expect(() => immutable(cyclic)).not.toThrow();
});

it("bounds retained cache cost, evicts least recently used entries, and rejects oversized items", () => {
  const cache = new BoundedCache<string, string>(10, 3, (value) => value.length);
  cache.set("a", "1234").set("b", "5678"); cache.get("a"); cache.set("c", "abcd");
  expect(cache.get("b")).toBeUndefined(); expect(cache.bytes).toBe(8);
  cache.set("huge", "12345678901"); expect(cache.get("huge")).toBeUndefined(); expect(cache.bytes).toBe(8);
});

it("loads exact-head restart projections without rereading the canonical log and scopes each cache to current access", async () => {
  const store = new CheckpointStore(), sdk = new FoldSdk(store), context = memoryContext();
  await sdk.recordMemory(context, stamp("source", 100), { id: MEMORY_A, source: "private", applicability: { kind: "global" }, summary: "Private exact claim" });
  const expected = await sdk.recallMemories(context.access); const count = store.readCount;
  expect(store.checkpoints.size).toBe(1);
  expect(await new FoldSdk(store).recallMemories(context.access)).toEqual(expected);
  expect(store.readCount).toBe(count);
  expect(await new FoldSdk(store).recallMemories(access({ principalId: "other" }))).toEqual([]);
  expect(store.readCount).toBeGreaterThan(count);
  const checkpoint = [...store.checkpoints.values()][0]!;
  store.checkpoints.set(checkpoint.projection, { ...checkpoint, stateVersion: "incompatible" });
  const before = store.readCount; expect(await new FoldSdk(store).recallMemories(context.access)).toEqual(expected);
  expect(store.readCount).toBeGreaterThan(before);
  const fresh = store.checkpoints.get(checkpoint.projection)!;
  store.checkpoints.set(checkpoint.projection, { ...fresh, state: { version: 1, sha256: "wrong", payload: { memories: [] } } });
  expect(await new FoldSdk(store).recallMemories(context.access)).toEqual(expected);
});

it("fully replays a late forget and invalidates derived claims across restart", async () => {
  const store = new CheckpointStore(), sdk = new FoldSdk(store), context = memoryContext({ audience: "workspace" });
  await sdk.recordMemory(context, stamp("source", 100), { id: MEMORY_A, audience: "workspace", source: "original", applicability: { kind: "global" } });
  await sdk.recordMemory(context, stamp("derived", 300), { id: MEMORY_B, audience: "workspace", source: "continuous-cognition", sourceMemoryRefs: [{ memoryId: MEMORY_A, revision: 0 }], applicability: { kind: "global" } });
  expect(await sdk.recallMemories(context.access)).toHaveLength(2);
  await new FoldSdk(store).forgetMemory(context, stamp("late-forget", 200), MEMORY_A, "late correction");
  const restarted = new FoldSdk(store);
  expect(await restarted.recallMemories(context.access)).toEqual([]);
  const rows = await restarted.recallMemoryPage(context.access, { includeNeedsReview: true });
  expect(rows.memories.map(({ memory }) => memory)).toEqual(recallMemoryCorpus(rebuildMemories(store.entries.map(({ event }) => event)), context.access, { includeNeedsReview: true }));
  expect(rows.memories[0]?.memory.currentness?.reasons).toContain("source-unavailable");
});

it("allows a canonical mutation on the same SDK while ranking waits, then rejects the stale result", async () => {
  const sdk = new FoldSdk(new CheckpointStore()), context = memoryContext();
  await sdk.recordMemory(context, stamp("source", 100), { id: MEMORY_A, source: "original", applicability: { kind: "global" } });
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const ranking = sdk.rankMemories(context.access, { query: "claim" }, { descriptor: { id: "held", kind: "semantic" }, async rank() { entered(); await held; return [{ memoryId: MEMORY_A, score: 1 }]; } });
  const rejected = expect(ranking).rejects.toThrow(/changed while ranking/);
  await started;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([sdk.forgetMemory(context, stamp("forget", 200), MEMORY_A, "while ranking"), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("canonical mutation blocked by provider")), 1_000); })]);
  } finally { clearTimeout(timer); release(); }
  await rejected;
});
