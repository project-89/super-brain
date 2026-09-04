import { describe, expect, it } from "vitest";

import {
  CompositeAuthenticator,
  PostgresMembershipResolver,
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
    expect(await directory.resolveAccess(subject!, "local", "workspace-1")).toEqual({
      principalId: "user-a",
      organizationId: "local",
      organizationRole: "owner",
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

  it("requires an organization-qualified lookup when workspace names are ambiguous", async () => {
    const directory = new StaticIdentityDirectory({
      secret: {
        principalId: "user-a",
        organizations: {
          "org-a": { role: "owner", workspaces: { shared: { role: "admin" } } },
          "org-b": { role: "member", workspaces: { shared: { role: "member" } } },
        },
      },
    });
    const subject = (await directory.authenticate("secret"))!;
    await expect(directory.resolveLegacyAccess(subject, "shared")).resolves.toBeUndefined();
    await expect(directory.resolveAccess(subject, "org-b", "shared")).resolves.toMatchObject({
      organizationId: "org-b",
      organizationRole: "member",
      workspaceRole: "member",
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
    expect(await directory.resolveAccess({ ...subject!, capabilities: ["memories:read"] }, "local", "workspace-1"))
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
        "local",
        "workspace-1",
      ),
    ).toBeUndefined();
    expect(await directory.resolveAccess(subject, "local", "workspace-2")).toBeUndefined();
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

  it("composes providers and enforces token-bound organization and role limits", async () => {
    const fallback = {
      async authenticate(token: string) {
        return token === "external" ? {
          credentialId: "clerk:session:a",
          principalId: "principal-a",
          author: { kind: "human" as const, id: "principal-a" },
          identityProvider: "clerk" as const,
          organizationId: "organization-a",
          organizationRoleLimit: "member" as const,
        } : undefined;
      },
    };
    const composite = new CompositeAuthenticator([
      { async authenticate() { return undefined; } },
      fallback,
    ]);
    const subject = (await composite.authenticate("external"))!;
    const memberships = new PostgresMembershipResolver({
      async resolveMembership(organizationId, workspaceId, principalId) {
        return {
          organizationId,
          organizationRole: "owner",
          workspaceId,
          workspaceRole: "admin",
          principalId,
          spaceRoles: {},
        };
      },
    });

    await expect(memberships.resolveAccess(subject, "organization-b", "workspace-a"))
      .resolves.toBeUndefined();
    await expect(memberships.resolveAccess(subject, "organization-a", "workspace-a"))
      .resolves.toMatchObject({ organizationRole: "member", workspaceRole: "admin" });
  });
});
