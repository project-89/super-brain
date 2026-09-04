import { describe, expect, it } from "vitest";

import {
  ClerkAuthenticator,
  ClerkBackendTokenVerifier,
  ClerkBindingConfigurationError,
  ClerkProvisioningWebhook,
  parseClerkBindingConfiguration,
  type ClerkTokenVerifier,
  type ClerkVerifiedIdentity,
  type ExternalIdentityResolver,
} from "../src/index.js";
import type { ExternalIdentityProvisioningEvent } from "@_89/fold-postgres";

function backendClient(auth: unknown) {
  return {
    async authenticateRequest() {
      return { isAuthenticated: true, toAuth: () => auth };
    },
  } as never;
}

function backendVerifier(auth: unknown): ClerkBackendTokenVerifier {
  return new ClerkBackendTokenVerifier({
    secretKey: "sk_test_secret",
    publishableKey: "pk_test_public",
    authorizedParties: ["https://brain.example"],
    client: backendClient(auth),
  });
}

function identityResolver(): ExternalIdentityResolver {
  return {
    async resolveExternalOrganization(provider, externalId) {
      return provider === "clerk" && externalId === "org_external" ? "organization-a" : undefined;
    },
    async resolveExternalPrincipal(provider, externalId) {
      const principals: Readonly<Record<string, string>> = {
        "user:user_external": "principal-user",
        "api-key:ak_external": "principal-capture",
        "machine:machine_external": "principal-worker",
      };
      return provider === "clerk" ? principals[externalId] : undefined;
    },
  };
}

describe("Clerk authentication", () => {
  it("normalizes organization-bound session identities", async () => {
    const verifier = backendVerifier({
      isAuthenticated: true,
      tokenType: "session_token",
      userId: "user_external",
      orgId: "org_external",
      sessionId: "session_external",
      orgRole: "org:admin",
    });

    await expect(verifier.verify("session-token")).resolves.toEqual({
      tokenType: "session_token",
      credentialId: "clerk:session:session_external",
      externalPrincipalId: "user:user_external",
      externalOrganizationId: "org_external",
      organizationRole: "org:admin",
    });
  });

  it("maps signed organization membership webhooks to deterministic tenant provisioning", async () => {
    const events: ExternalIdentityProvisioningEvent[] = [];
    const webhook = new ClerkProvisioningWebhook({
      async applyExternalIdentityProvisioningEvent(event) {
        events.push(event);
        return true;
      },
    }, {
      signingSecret: "whsec_test",
      defaultWorkspaceId: "primary",
      async verifier() {
        return {
          type: "organizationMembership.created",
          data: {
            role: "org:admin",
            organization: { id: "org_external", name: "Acme" },
            public_user_data: { user_id: "user_external" },
          },
        } as never;
      },
    });

    await expect(webhook.handle({
      url: "https://brain.example/v1/webhooks/clerk",
      headers: { "svix-id": "event-a" },
      body: new TextEncoder().encode("{}"),
    })).resolves.toEqual({ applied: true });
    expect(events).toEqual([{
      eventId: "event-a",
      provider: "clerk",
      type: "membership.upsert",
      externalOrganizationId: "org_external",
      organizationId: "clerk:org_external",
      organizationName: "Acme",
      externalPrincipalId: "user:user_external",
      principalId: "clerk:user:user_external",
      workspaceId: "primary",
      organizationRole: "admin",
      workspaceRole: "admin",
    }]);
  });

  it("normalizes scoped API keys and M2M tokens without trusting their subject as a principal", async () => {
    const apiKey = backendVerifier({
      isAuthenticated: true,
      tokenType: "api_key",
      id: "ak_external",
      orgId: "org_external",
      claims: {
        super_brain: {
          author: { kind: "sensor", id: "urn:sensor:capture-a" },
        },
      },
      scopes: ["super-brain:events:write", "unknown"],
    });
    await expect(apiKey.verify("api-key")).resolves.toMatchObject({
      credentialId: "clerk:api-key:ak_external",
      externalPrincipalId: "api-key:ak_external",
      externalOrganizationId: "org_external",
      author: { kind: "sensor", id: "urn:sensor:capture-a" },
    });

    const m2m = backendVerifier({
      isAuthenticated: true,
      tokenType: "m2m_token",
      id: "m2m_external",
      machineId: "machine_external",
      claims: { super_brain: { organizationId: "org_external" } },
      scopes: ["memories:read"],
    });
    await expect(m2m.verify("m2m-token")).resolves.toMatchObject({
      credentialId: "clerk:m2m:m2m_external",
      externalPrincipalId: "machine:machine_external",
      externalOrganizationId: "org_external",
    });
  });

  it("maps only pre-provisioned identities and recognized machine scopes", async () => {
    const identity: ClerkVerifiedIdentity = {
      tokenType: "api_key",
      credentialId: "clerk:api-key:ak_external",
      externalPrincipalId: "api-key:ak_external",
      externalOrganizationId: "org_external",
      scopes: ["super-brain:events:write", "memories:read", "untrusted:scope"],
      author: { kind: "sensor", id: "urn:sensor:capture-a" },
    };
    const verifier: ClerkTokenVerifier = { async verify() { return identity; } };
    const authenticator = new ClerkAuthenticator(verifier, identityResolver());

    await expect(authenticator.authenticate("api-key")).resolves.toEqual({
      credentialId: "clerk:api-key:ak_external",
      principalId: "principal-capture",
      author: { kind: "sensor", id: "urn:sensor:capture-a" },
      capabilities: ["events:write", "memories:read"],
      identityProvider: "clerk",
      organizationId: "organization-a",
    });
  });

  it("fails closed without active organization context or complete external bindings", async () => {
    const missingOrganization: ClerkTokenVerifier = {
      async verify() {
        return {
          tokenType: "session_token",
          credentialId: "clerk:session:a",
          externalPrincipalId: "user:user_external",
        };
      },
    };
    await expect(new ClerkAuthenticator(missingOrganization, identityResolver()).authenticate("token"))
      .resolves.toBeUndefined();

    const missingPrincipal: ClerkTokenVerifier = {
      async verify() {
        return {
          tokenType: "session_token",
          credentialId: "clerk:session:b",
          externalPrincipalId: "user:unknown",
          externalOrganizationId: "org_external",
        };
      },
    };
    await expect(new ClerkAuthenticator(missingPrincipal, identityResolver()).authenticate("token"))
      .resolves.toBeUndefined();
  });

  it("parses explicit bindings and rejects membership references outside them", () => {
    expect(parseClerkBindingConfiguration(JSON.stringify({
      organizations: { org_external: "organization-a" },
      principals: { "user:user_external": "principal-user" },
      memberships: [{
        organizationId: "organization-a",
        organizationRole: "owner",
        workspaceId: "workspace-a",
        workspaceRole: "owner",
        principalId: "principal-user",
      }],
    }))).toMatchObject({
      organizations: [{ externalId: "org_external", organizationId: "organization-a" }],
      principals: [{ externalId: "user:user_external", principalId: "principal-user" }],
      memberships: [{ spaceRoles: {} }],
    });
    expect(() => parseClerkBindingConfiguration(JSON.stringify({
      organizations: { org_external: "organization-a" },
      principals: {},
      memberships: [{
        organizationId: "organization-a",
        organizationRole: "owner",
        workspaceId: "workspace-a",
        workspaceRole: "owner",
        principalId: "missing",
      }],
    }))).toThrow(ClerkBindingConfigurationError);

    expect(() => parseClerkBindingConfiguration(JSON.stringify({
      organizations: { org_external: "organization-a", " org_external ": "organization-b" },
      principals: {},
      memberships: [],
    }))).toThrow("external organization ids must be unique after trimming");
  });
});
