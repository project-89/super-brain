import { describe, expect, it } from "vitest";

import { assertCanAppendEvent, authorizeEventAccess, FoldSdk } from "../src/index.js";
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

  it("allows platform reads within the requested tenant but never platform writes", async () => {
    const platformAccess = {
      ...access({ principalId: "support-user" }),
      platformDataAccess: true,
    } as const;
    const privateEvent = event({
      id: "event-private",
      t: 1,
      creatorId: "user-b",
      spaceId: "private-space",
    });

    expect(authorizeEventAccess(privateEvent, platformAccess)).toEqual({ allowed: true });
    expect(authorizeEventAccess(
      event({ id: "event-other-org-target", t: 2, workspaceId: "workspace-2" }),
      platformAccess,
    )).toEqual({ allowed: false, reason: "workspace-mismatch" });
    expect(() => assertCanAppendEvent(privateEvent, platformAccess)).toThrow(/read-only/);

    const sdk = new FoldSdk(new MemoryStore());
    await expect(sdk.append(platformAccess, privateEvent)).rejects.toThrow(/read-only/);
  });

  it("validates access even when the store is empty", async () => {
    const sdk = new FoldSdk(new MemoryStore());
    await expect(
      sdk.listEntries(access({ workspaceRole: "invalid" as never })),
    ).rejects.toThrow(/unsupported workspace role/);
  });
});
