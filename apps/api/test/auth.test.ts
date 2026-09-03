import { describe, expect, it } from "vitest";

import {
  StaticCredentialConfigurationError,
  StaticIdentityDirectory,
} from "../src/index.js";

describe("static identity directory", () => {
  it("authenticates hashed credentials and resolves workspace membership", async () => {
    const directory = new StaticIdentityDirectory({
      secret: {
        principalId: "user-a",
        workspaces: {
          "workspace-1": { role: "member", spaces: { "space-a": "reader" } },
        },
      },
    });
    const subject = await directory.authenticate("secret");
    expect(subject).toMatchObject({
      principalId: "user-a",
      author: { kind: "human", id: "user-a" },
    });
    expect(subject?.credentialId).toMatch(/^[a-f0-9]{64}$/);
    expect(subject?.credentialId).not.toContain("secret");
    expect(await directory.resolveAccess(subject!, "workspace-1")).toEqual({
      principalId: "user-a",
      workspaceId: "workspace-1",
      workspaceRole: "member",
      spaceRoles: { "space-a": "reader" },
    });
  });

  it("supports a credential-bound sensor author", async () => {
    const directory = new StaticIdentityDirectory({
      sensor: {
        principalId: "user-a",
        author: { kind: "sensor", id: "urn:sensor:terminal-1" },
        workspaces: { "workspace-1": { role: "member" } },
      },
    });
    expect(await directory.authenticate("sensor")).toMatchObject({
      author: { kind: "sensor", id: "urn:sensor:terminal-1" },
    });
  });

  it("binds optional least-privilege capabilities to the authenticated subject", async () => {
    const directory = new StaticIdentityDirectory({
      sensor: {
        principalId: "user-a",
        capabilities: ["events:write", "trajectories:write", "events:write"],
        workspaces: { "workspace-1": { role: "admin" } },
      },
    });
    const subject = await directory.authenticate("sensor");
    expect(subject?.capabilities).toEqual(["events:write", "trajectories:write"]);
    expect(await directory.resolveAccess({ ...subject!, capabilities: ["memories:read"] }, "workspace-1"))
      .toBeUndefined();
  });

  it("returns no identity or membership for unknown and forged credentials", async () => {
    const directory = new StaticIdentityDirectory({
      secret: {
        principalId: "user-a",
        author: { kind: "agent", id: "brain", productionId: "prod-1" },
        workspaces: { "workspace-1": { role: "member" } },
      },
    });
    expect(await directory.authenticate("wrong")).toBeUndefined();
    const subject = (await directory.authenticate("secret"))!;
    expect(
      await directory.resolveAccess(
        { ...subject, author: { ...subject.author, productionId: "prod-2" } },
        "workspace-1",
      ),
    ).toBeUndefined();
    expect(await directory.resolveAccess(subject, "workspace-2")).toBeUndefined();
  });

  it("fails closed on empty, malformed, and unknown configuration", () => {
    expect(() => new StaticIdentityDirectory({})).toThrow(/at least one credential/);
    expect(() =>
      new StaticIdentityDirectory({ token: { principalId: "user-a", workspaces: { w: { role: "root" } } } }),
    ).toThrow(StaticCredentialConfigurationError);
    expect(() =>
      new StaticIdentityDirectory({
        token: { principalId: "user-a", workspaces: {}, extra: true },
      }),
    ).toThrow(/invalid/);
    expect(() => StaticIdentityDirectory.fromJson("{"))
      .toThrow(/not valid JSON/);
  });
});
