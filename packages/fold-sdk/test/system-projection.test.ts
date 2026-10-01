import { fold, serializeFoldState } from "@_89/fold";
import { describe, expect, it, vi } from "vitest";

import { FoldSdk } from "../src/index.js";
import { access, event, MemoryStore } from "./helpers.js";

describe("System projection store contract", () => {
  it("keeps the non-PostgreSQL fallback incremental and equivalent to replay", async () => {
    const sdk = new FoldSdk(new MemoryStore(true));
    const compare = async (who = access()) => {
      const result = await sdk.systemProjection(who);
      const entries = await sdk.listEntries(who);
      expect(serializeFoldState(result.state)).toBe(serializeFoldState(fold(entries, {
        include: "canon", existingCreate: "replace", retainApplied: false,
      })));
      expect(result.appliedEventCount).toBe(entries.length);
      return result;
    };
    await sdk.append(access(), event({ id: "first", t: 10 }));
    const initial = await compare();
    expect(await sdk.systemProjection(access())).toBe(initial);
    await sdk.append(access(), event({ id: "last", t: 30 }));
    await compare();
    await sdk.append(access(), event({ id: "late", t: 20 }));
    await compare();
    await sdk.append(access({ spaces: ["secret"] }), event({ id: "private", t: 40, spaceId: "secret" }));
    expect((await compare(access({ spaces: ["secret"] }))).appliedEventCount).toBe(4);
    expect((await compare()).appliedEventCount).toBe(3);
    expect(initial.appliedEventCount).toBe(1);
    expect(initial.state.nodes.size).toBe(1);
  });

  it("delegates to the optimized store without loading or parsing the event log", async () => {
    const store = new MemoryStore();
    const result = { state: fold([], { include: "canon" }), appliedEventCount: 0, appliedChangeCount: 0 };
    const systemProjection = vi.fn(async () => result);
    const sdk = new FoldSdk(Object.assign(store, { systemProjection }));
    expect(await sdk.systemProjection(access(), "canon+draft")).toBe(result);
    expect(systemProjection).toHaveBeenCalledWith(access(), "canon+draft");
    expect(store.readCount).toBe(0);
  });
});
