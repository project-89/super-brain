import { beforeEach, describe, expect, it, vi } from "vitest";
import { sortLog, type FoldEvent, type FoldLogEntry } from "@_89/fold";
import { continueTrajectories, makeTrajectoryTreeRecordedEvent, rebuildTrajectories } from "@_89/fold-trajectory";
import { FoldSdk, type FoldSdkStore } from "../src/index.js";
import { access, stamp } from "./helpers.js";

vi.mock("@_89/fold-trajectory", async (original) => {
  const actual = await original<typeof import("@_89/fold-trajectory")>();
  return { ...actual, continueTrajectories: vi.fn(actual.continueTrajectories), rebuildTrajectories: vi.fn(actual.rebuildTrajectories) };
});

const context = {
  access: access({ spaces: ["space-a"] }), author: { kind: "human" as const, id: "user-a" },
  capture: { scope: { workspace: "workspace-1", space: "space-a" }, identity: { task: "task", principal: "user-a", workspace: "workspace-1" } },
};
function tree(count: number) {
  return { taskId: "task", rootNodeId: "node-0",
    nodes: Array.from({ length: count }, (_, i) => ({ id: `node-${i}`, kind: "observation" as const, label: `Observation ${i}` })),
    edges: Array.from({ length: count - 1 }, (_, i) => ({ id: `edge-${i}`, sourceId: `node-${i}`, targetId: `node-${i + 1}`, label: "next" })),
  };
}
function event(id: string, time: number, count: number): FoldEvent {
  return makeTrajectoryTreeRecordedEvent(context, stamp(id, time), tree(count));
}
function fixture(events: FoldEvent[], immutableEventReferences = true) {
  const entries: FoldLogEntry[] = events.map((item) => ({ event: item, status: "canon" }));
  let revision = 1;
  const store: FoldSdkStore = {
    immutableEventReferences,
    read: async () => ({ entries: sortLog(entries), revision: String(revision) }),
    append: async (entry) => { entries.push(entry); revision += 1; },
    revision: async () => String(revision),
  };
  return { sdk: new FoldSdk(store), entries, update: () => { revision += 1; } };
}

beforeEach(() => vi.clearAllMocks());
describe("validated trajectory cache", () => {
  it("reuses warmed tree/report reads and folds only appended revisions after writes", async () => {
    const { sdk } = fixture([event("first", 1, 2)]);
    expect((await sdk.trajectoryTree(context.access, "task"))?.tree).toEqual(tree(2));
    expect(rebuildTrajectories).toHaveBeenCalledTimes(1);
    await sdk.trajectoryTree(context.access, "task");
    expect((await sdk.trajectoryReport(context.access, "task"))?.tree).toEqual(tree(2));
    expect(rebuildTrajectories).toHaveBeenCalledTimes(1);
    await sdk.recordTrajectoryTree(context, stamp("next", 2), tree(3));
    expect((await sdk.trajectoryTree(context.access, "task"))?.tree).toEqual(tree(3));
    expect(rebuildTrajectories).toHaveBeenCalledTimes(1);
    expect(continueTrajectories).toHaveBeenCalledExactlyOnceWith(expect.anything(), [expect.objectContaining({ id: "next" })]);
    await sdk.recordTrajectoryTree(context, stamp("next", 2), tree(3));
    expect(rebuildTrajectories).toHaveBeenCalledTimes(1);
  });

  it("replays instead of extending the cache when late insertion changes source ordering", async () => {
    const { sdk, entries, update } = fixture([event("first", 1, 2), event("last", 3, 4)]);
    await sdk.trajectoryTree(context.access, "task");
    entries.push({ event: event("middle", 2, 3), status: "canon" }); update();
    expect((await sdk.trajectoryTree(context.access, "task"))?.tree).toEqual(tree(4));
    expect(rebuildTrajectories).toHaveBeenCalledTimes(2);
    expect(continueTrajectories).not.toHaveBeenCalled();
  });

  it("rejects an invalid retroactive larger tree before persisting it", async () => {
    const { sdk, entries } = fixture([event("first", 1, 2), event("last", 3, 4)]);
    await sdk.trajectoryTree(context.access, "task");
    await expect(sdk.recordTrajectoryTree(context, stamp("retroactive", 2), tree(5))).rejects.toThrow("source-ordered history");
    expect(entries.map(({ event: item }) => item.id)).toEqual(["first", "last"]);
    expect((await sdk.trajectoryTree(context.access, "task"))?.tree).toEqual(tree(4));
  });

  it("keeps access-context caches separate and does not expose a warmed private-space tree", async () => {
    const { sdk } = fixture([event("first", 1, 2)]);
    await sdk.trajectoryTree(context.access, "task");
    expect(await sdk.trajectoryTree(access({ spaces: [] }), "task")).toBeUndefined();
    expect(await sdk.trajectoryTree(access({ workspaceId: "other", spaces: ["space-a"] }), "task")).toBeUndefined();
    expect((await sdk.trajectoryTree(context.access, "task"))?.tree).toEqual(tree(2));
  });

  it("revalidates replaced event objects and generic mutable store events", async () => {
    for (const immutable of [true, false]) {
      const { sdk, entries, update } = fixture([event("first", 1, 2)], immutable);
      await sdk.trajectoryTree(context.access, "task");
      const bad = { ...entries[0]!.event, changes: [] };
      if (immutable) entries[0] = { event: bad, status: "canon" };
      else Object.assign(entries[0]!.event, bad);
      update();
      await expect(sdk.trajectoryTree(context.access, "task")).rejects.toThrow();
    }
  });

  it("does not re-read historic envelopes after new rows only for immutable-reference stores", async () => {
    for (const immutable of [true, false]) {
      const first = event("first", 1, 2);
      const changes = first.changes;
      let historicEnvelopeReads = 0;
      Object.defineProperty(first, "changes", { get: () => { historicEnvelopeReads += 1; return changes; } });
      const { sdk, entries, update } = fixture([first], immutable);
      await sdk.trajectoryTree(context.access, "task");
      const before = historicEnvelopeReads;
      expect(before).toBeGreaterThan(0);
      entries.push({ event: event("next", 2, 3), status: "canon" }); update();
      await sdk.trajectoryTree(context.access, "task");
      if (immutable) expect(historicEnvelopeReads).toBe(before);
      else expect(historicEnvelopeReads).toBeGreaterThan(before);
    }
  });

  it("handles a 5,000-node chain and an additive extension without revalidating old revisions", async () => {
    const { sdk } = fixture([event("deep", 1, 5_000)]);
    expect((await sdk.trajectoryTree(context.access, "task"))?.tree.nodes).toHaveLength(5_000);
    await sdk.recordTrajectoryTree(context, stamp("deeper", 2), tree(5_001));
    expect((await sdk.trajectoryTree(context.access, "task"))?.tree.nodes).toHaveLength(5_001);
    expect(rebuildTrajectories).toHaveBeenCalledTimes(1);
    expect(continueTrajectories).toHaveBeenCalledTimes(1);
  });

  it("does not label partial cached entries with a concurrent writer's newer revision", async () => {
    const entries: FoldLogEntry[] = [{ event: event("first", 1, 2), status: "canon" }];
    const revision = vi.fn(async () => String(entries.length));
    const sdk = new FoldSdk({ immutableEventReferences: true,
      read: async () => ({ entries: sortLog(entries), revision: String(entries.length) }),
      append: async (entry) => {
        entries.push(entry);
        entries.push({ event: event("concurrent", 3, 4), status: "canon" });
      }, revision,
    });
    await sdk.trajectoryTree(context.access, "task");
    await sdk.recordTrajectoryTree(context, stamp("own-write", 2), tree(3));
    expect((await sdk.trajectoryTree(context.access, "task"))?.tree).toEqual(tree(4));
    expect(revision).not.toHaveBeenCalled();
  });
});
