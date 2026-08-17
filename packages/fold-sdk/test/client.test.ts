import { describe, expect, it } from "vitest";

import { FoldSdk } from "../src/index.js";
import { access, event, MemoryStore } from "./helpers.js";

describe("Fold SDK producer and consumer API", () => {
  it("appends canonical entries and returns them in Fold order", async () => {
    const sdk = new FoldSdk(new MemoryStore());
    await sdk.append(access(), event({ id: "event-b", t: 2 }));
    await sdk.append(access(), event({ id: "event-a", t: 1 }));

    const entries = await sdk.listEntries(access());
    expect(entries.map((entry) => entry.event.id)).toEqual(["event-a", "event-b"]);
    expect(entries.every((entry) => entry.status === "canon")).toBe(true);
  });

  it("keeps draft inclusion explicit", async () => {
    const sdk = new FoldSdk(new MemoryStore());
    await sdk.append(access(), event({ id: "event-a", t: 1 }));
    await sdk.append(access(), event({ id: "event-b", t: 2 }), "draft");

    expect((await sdk.listEntries(access())).map((entry) => entry.event.id)).toEqual(["event-a"]);
    expect(
      (await sdk.listEntries(access(), { include: "canon+draft" })).map(
        (entry) => entry.event.id,
      ),
    ).toEqual(["event-a", "event-b"]);
  });

  it("filters every read by current workspace, creator, and space access", async () => {
    const store = new MemoryStore();
    const sdk = new FoldSdk(store);
    await sdk.append(access(), event({ id: "public", t: 1 }));
    await sdk.append(access(), event({ id: "private-a", t: 2, creatorId: "user-a" }));
    await sdk.append(
      access({ principalId: "user-b" }),
      event({ id: "private-b", t: 3, creatorId: "user-b" }),
    );
    await sdk.append(
      access({ spaces: ["space-a"] }),
      event({ id: "space-a", t: 4, spaceId: "space-a" }),
    );
    await sdk.append(
      access({ spaces: ["space-removed"] }),
      event({ id: "space-removed", t: 5, spaceId: "space-removed" }),
    );
    await sdk.append(
      access({ workspaceId: "workspace-2" }),
      event({ id: "other-workspace", t: 6, workspaceId: "workspace-2" }),
    );

    const visible = await sdk.listEntries(access({ spaces: ["space-a"] }));
    expect(visible.map((entry) => entry.event.id)).toEqual(["public", "private-a", "space-a"]);
  });

  it("rejects appends outside the authenticated capture scope", async () => {
    const sdk = new FoldSdk(new MemoryStore());
    await expect(
      sdk.append(access(), event({ id: "workspace", t: 1, workspaceId: "workspace-2" })),
    ).rejects.toThrow(/workspace-mismatch/);
    await expect(
      sdk.append(access(), event({ id: "creator", t: 2, creatorId: "user-b" })),
    ).rejects.toThrow(/creator-mismatch/);
    await expect(
      sdk.append(access(), event({ id: "space", t: 3, spaceId: "space-a" })),
    ).rejects.toThrow(/space-inaccessible/);
  });

  it("rejects duplicate IDs and nonmonotonic same-time producer IDs", async () => {
    const sdk = new FoldSdk(new MemoryStore());
    await sdk.append(access(), event({ id: "event-b", t: 10 }));
    await expect(sdk.append(access(), event({ id: "event-b", t: 11 }))).rejects.toThrow(
      /duplicate event id/,
    );
    await expect(sdk.append(access(), event({ id: "event-a", t: 10 }))).rejects.toThrow(
      /not lexicographically monotonic/,
    );
  });

  it("serializes concurrent appends through one SDK instance", async () => {
    const sdk = new FoldSdk(new MemoryStore());
    await Promise.all([
      sdk.append(access(), event({ id: "event-a", t: 1 })),
      sdk.append(access(), event({ id: "event-b", t: 1 })),
    ]);
    expect((await sdk.listEntries(access())).map((entry) => entry.event.id)).toEqual([
      "event-a",
      "event-b",
    ]);
  });

  it("uses explicit inclusive cursors and kind filters", async () => {
    const sdk = new FoldSdk(new MemoryStore());
    await sdk.append(access(), event({ id: "event-a", t: 1, kind: "alpha" }));
    await sdk.append(access(), event({ id: "event-b", t: 2, kind: "beta" }));
    await sdk.append(access(), event({ id: "event-c", t: 2, kind: "alpha" }));

    const throughB = await sdk.listEntries(access(), { cursor: { t: 2, eventId: "event-b" } });
    expect(throughB.map((entry) => entry.event.id)).toEqual(["event-a", "event-b"]);
    expect(
      (await sdk.listEntries(access(), { kinds: ["alpha"] })).map((entry) => entry.event.id),
    ).toEqual(["event-a", "event-c"]);
    await expect(
      sdk.listEntries(access(), { cursor: { t: 2, eventId: "missing" } }),
    ).rejects.toThrow(/does not identify an event/);
  });

  it("projects only records visible to the caller", async () => {
    const sdk = new FoldSdk(new MemoryStore());
    await sdk.append(access(), event({ id: "event-a", t: 1, subject: "visible" }));
    await sdk.append(
      access({ principalId: "user-b" }),
      event({ id: "event-b", t: 2, creatorId: "user-b", subject: "hidden" }),
    );
    const projected = await sdk.project(access());
    expect([...projected.state.nodes.keys()]).toEqual(["visible"]);
    expect(projected.entries).toHaveLength(1);
  });

  it("recovers its queue after a rejected operation", async () => {
    const sdk = new FoldSdk(new MemoryStore());
    await expect(
      sdk.append(access(), event({ id: "denied", t: 1, creatorId: "user-b" })),
    ).rejects.toThrow();
    await expect(sdk.append(access(), event({ id: "accepted", t: 2 }))).resolves.toMatchObject({
      event: { id: "accepted" },
    });
  });

  it("fails closed on invalid read configuration", async () => {
    const sdk = new FoldSdk(new MemoryStore());
    await expect(
      sdk.listEntries(access(), { include: "unknown" as never }),
    ).rejects.toThrow(/read inclusion/);
    await expect(
      sdk.listEntries(access(), { cursor: { t: Number.NaN, eventId: "event-a" } }),
    ).rejects.toThrow(/cursor t/);
    await expect(
      sdk.listEntries(access(), { cursor: { t: 1, eventId: " " } }),
    ).rejects.toThrow(/cursor eventId/);
    await expect(sdk.listEntries(access(), { kinds: [" "] })).rejects.toThrow(/event kinds/);
  });

  it("rejects a corrupt store before returning raw records", async () => {
    const store = new MemoryStore();
    const duplicate = { event: event({ id: "event-a", t: 1 }), status: "canon" as const };
    store.entries.push(duplicate, duplicate);
    await expect(new FoldSdk(store).listEntries(access())).rejects.toThrow(/duplicate event id/);
  });
});
