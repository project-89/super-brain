import { describe, expect, it } from "vitest";

import { authorizeEventAccess, FoldSdk } from "../src/index.js";
import { access, event, MemoryStore } from "./helpers.js";

describe("SDK capture-scope access", () => {
  it("authorizes workspace-shared and currently accessible space events", () => {
    expect(authorizeEventAccess(event({ id: "event-a", t: 1 }), access())).toEqual({
      allowed: true,
    });
    expect(
      authorizeEventAccess(
        event({ id: "event-b", t: 2, spaceId: "space-a" }),
        access({ spaces: ["space-a"] }),
      ),
    ).toEqual({ allowed: true });
  });

  it("denies other workspaces, creators, and inaccessible spaces", () => {
    expect(
      authorizeEventAccess(
        event({ id: "event-a", t: 1, workspaceId: "workspace-2" }),
        access(),
      ),
    ).toEqual({ allowed: false, reason: "workspace-mismatch" });
    expect(
      authorizeEventAccess(
        event({ id: "event-b", t: 2, creatorId: "user-b" }),
        access({ workspaceRole: "owner" }),
      ),
    ).toEqual({ allowed: false, reason: "creator-mismatch" });
    expect(
      authorizeEventAccess(event({ id: "event-c", t: 3, spaceId: "space-a" }), access()),
    ).toEqual({ allowed: false, reason: "space-inaccessible" });
  });

  it("validates access even when the store is empty", async () => {
    const sdk = new FoldSdk(new MemoryStore());
    await expect(
      sdk.listEntries(access({ workspaceRole: "invalid" as never })),
    ).rejects.toThrow(/unsupported workspace role/);
  });
});
