import { createClerkClient, type ClerkClient } from "@clerk/backend";
import { verifyWebhook, type WebhookEvent } from "@clerk/backend/webhooks";
import { authorSchema, type Author } from "@_89/fold";
import type {
  ExternalOrganizationBinding,
  ExternalPrincipalBinding,
  TenantMembershipRecord,
  ExternalIdentityProvisioningEvent,
} from "@_89/fold-postgres";
import { z } from "zod";

import type { ApiCapability, AuthenticatedSubject, Authenticator, OrganizationRole } from "./types.js";
import { API_CAPABILITIES } from "./types.js";

const SUPER_BRAIN_SCOPE_PREFIX = "super-brain:";
const CLERK_TOKEN_TYPES = ["session_token", "api_key", "m2m_token"] as const;

const integrationClaimsSchema = z.object({
  super_brain: z.object({
    organizationId: z.string().trim().min(1).optional(),
    author: authorSchema.optional(),
  }).passthrough().optional(),
}).passthrough();

const membershipSchema = z.object({
  organizationId: z.string().trim().min(1),
  organizationRole: z.enum(["owner", "admin", "member"]),
  workspaceId: z.string().trim().min(1),
  workspaceRole: z.enum(["owner", "admin", "member"]),
  principalId: z.string().trim().min(1),
  spaceRoles: z.record(z.enum(["admin", "writer", "reader"])).default({}),
}).strict();

const bindingConfigurationSchema = z.object({
  organizations: z.record(z.string().trim().min(1)),
  principals: z.record(z.string().trim().min(1)),
  memberships: z.array(membershipSchema).max(10_000),
}).strict();

export interface ClerkVerifiedIdentity {
  readonly tokenType: (typeof CLERK_TOKEN_TYPES)[number];
  readonly credentialId: string;
  readonly externalPrincipalId: string;
  readonly externalOrganizationId?: string;
  readonly organizationRole?: string;
  readonly scopes?: readonly string[];
  readonly author?: Author;
}

export interface ClerkTokenVerifier {
  verify(bearerToken: string): Promise<ClerkVerifiedIdentity | undefined>;
}

export interface ExternalIdentityResolver {
  resolveExternalOrganization(provider: string, externalId: string): Promise<string | undefined>;
  resolveExternalPrincipal(provider: string, externalId: string): Promise<string | undefined>;
}

export interface ClerkProvisioningStore {
  applyExternalIdentityProvisioningEvent(input: ExternalIdentityProvisioningEvent): Promise<boolean>;
  resolveExternalOrganization?(provider: string, externalId: string): Promise<string | undefined>;
}

export interface ClerkBindingConfiguration {
  readonly organizations: readonly ExternalOrganizationBinding[];
  readonly principals: readonly ExternalPrincipalBinding[];
  readonly memberships: readonly TenantMembershipRecord[];
}

export class ClerkBindingConfigurationError extends Error {
  override readonly name = "ClerkBindingConfigurationError";
}

export class ClerkWebhookVerificationError extends Error {
  override readonly name = "ClerkWebhookVerificationError";
}

function claims(value: unknown): z.infer<typeof integrationClaimsSchema>["super_brain"] {
  const parsed = integrationClaimsSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data.super_brain : undefined;
}

function machineOrganizationId(
  clerkOrganizationId: string | null | undefined,
  machineClaims: unknown,
): string | undefined {
  return clerkOrganizationId ?? claims(machineClaims)?.organizationId;
}

export class ClerkBackendTokenVerifier implements ClerkTokenVerifier {
  private readonly client: ClerkClient;

  constructor(private readonly options: {
    readonly secretKey: string;
    readonly publishableKey: string;
    readonly machineSecretKey?: string;
    readonly authorizedParties: readonly string[];
    readonly client?: Pick<ClerkClient, "authenticateRequest">;
  }) {
    if (options.secretKey.trim().length === 0) throw new TypeError("Clerk secretKey is required");
    if (options.publishableKey.trim().length === 0) throw new TypeError("Clerk publishableKey is required");
    if (options.authorizedParties.length === 0 || options.authorizedParties.some((party) => party.trim().length === 0)) {
      throw new TypeError("at least one Clerk authorized party is required");
    }
    this.client = options.client === undefined
      ? createClerkClient({
          secretKey: options.secretKey,
          publishableKey: options.publishableKey,
          telemetry: { disabled: true },
        })
      : options.client as ClerkClient;
  }

  async verify(bearerToken: string): Promise<ClerkVerifiedIdentity | undefined> {
    if (bearerToken.trim().length === 0) return undefined;
    const state = await this.client.authenticateRequest(
      new Request("https://super-brain.invalid/v1/auth", {
        headers: { authorization: `Bearer ${bearerToken}` },
      }),
      {
        acceptsToken: [...CLERK_TOKEN_TYPES],
        authorizedParties: [...this.options.authorizedParties],
        ...(this.options.machineSecretKey === undefined
          ? {}
          : { machineSecretKey: this.options.machineSecretKey }),
      },
    );
    if (!state.isAuthenticated) return undefined;
    const auth = state.toAuth();
    if (auth.tokenType === "session_token") {
      if (
        typeof auth.userId !== "string" ||
        typeof auth.orgId !== "string" ||
        typeof auth.sessionId !== "string"
      ) return undefined;
      return {
        tokenType: "session_token",
        credentialId: `clerk:session:${auth.sessionId}`,
        externalPrincipalId: `user:${auth.userId}`,
        externalOrganizationId: auth.orgId,
        ...(typeof auth.orgRole === "string" ? { organizationRole: auth.orgRole } : {}),
      };
    }
    if (auth.tokenType === "api_key") {
      const integration = claims(auth.claims);
      const externalOrganizationId = machineOrganizationId(auth.orgId, auth.claims);
      return {
        tokenType: "api_key",
        credentialId: `clerk:api-key:${auth.id}`,
        externalPrincipalId: `api-key:${auth.id}`,
        ...(externalOrganizationId === undefined ? {} : { externalOrganizationId }),
        scopes: [...auth.scopes],
        ...(integration?.author === undefined ? {} : { author: integration.author }),
      };
    }
    const integration = claims(auth.claims);
    const externalOrganizationId = machineOrganizationId(undefined, auth.claims);
    return {
      tokenType: "m2m_token",
      credentialId: `clerk:m2m:${auth.id}`,
      externalPrincipalId: `machine:${auth.machineId}`,
      ...(externalOrganizationId === undefined ? {} : { externalOrganizationId }),
      scopes: [...auth.scopes],
      ...(integration?.author === undefined ? {} : { author: integration.author }),
    };
  }
}

function capabilities(scopes: readonly string[] | undefined): readonly ApiCapability[] | undefined {
  if (scopes === undefined) return undefined;
  const granted = new Set(scopes);
  return API_CAPABILITIES.filter(
    (capability) => granted.has(capability) || granted.has(`${SUPER_BRAIN_SCOPE_PREFIX}${capability}`),
  );
}

function organizationRoleLimit(role: string | undefined): OrganizationRole {
  const normalized = role?.replace(/^org:/, "");
  if (normalized === "owner" || normalized === "admin") return normalized;
  return "member";
}

export class ClerkAuthenticator implements Authenticator {
  constructor(
    private readonly verifier: ClerkTokenVerifier,
    private readonly identities: ExternalIdentityResolver,
  ) {}

  async authenticate(bearerToken: string): Promise<AuthenticatedSubject | undefined> {
    const verified = await this.verifier.verify(bearerToken);
    if (verified?.externalOrganizationId === undefined) return undefined;
    const [organizationId, principalId] = await Promise.all([
      this.identities.resolveExternalOrganization("clerk", verified.externalOrganizationId),
      this.identities.resolveExternalPrincipal("clerk", verified.externalPrincipalId),
    ]);
    if (organizationId === undefined || principalId === undefined) return undefined;
    const author = verified.tokenType === "session_token"
      ? { kind: "human" as const, id: principalId }
      : verified.author ?? { kind: "agent" as const, id: principalId };
    return {
      credentialId: verified.credentialId,
      principalId,
      author,
      ...(verified.tokenType === "session_token"
        ? { organizationRoleLimit: organizationRoleLimit(verified.organizationRole), taskEvidenceAuthority: { kind: "human" as const, principalId } }
        : { capabilities: capabilities(verified.scopes) ?? [] }),
      identityProvider: "clerk",
      organizationId,
    };
  }
}

function provisionedOrganizationId(externalId: string): string {
  return `clerk:${externalId}`;
}

function provisionedPrincipalId(externalUserId: string): string {
  return `clerk:user:${externalUserId}`;
}

function provisionedRole(role: string): {
  readonly organizationRole: TenantMembershipRecord["organizationRole"];
  readonly workspaceRole: TenantMembershipRecord["workspaceRole"];
} {
  const normalized = role.replace(/^org:/, "");
  if (normalized === "owner") return { organizationRole: "owner", workspaceRole: "owner" };
  if (normalized === "admin") return { organizationRole: "admin", workspaceRole: "admin" };
  return { organizationRole: "member", workspaceRole: "member" };
}

export class ClerkProvisioningWebhook {
  constructor(
    private readonly store: ClerkProvisioningStore,
    private readonly options: {
      readonly signingSecret: string;
      readonly defaultWorkspaceId?: string;
      readonly verifier?: (request: Request, options: { readonly signingSecret: string }) => Promise<WebhookEvent>;
    },
  ) {
    if (options.signingSecret.trim().length === 0) throw new TypeError("Clerk webhook signing secret is required");
  }

  async handle(input: {
    readonly url: string;
    readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
    readonly body: Uint8Array;
  }): Promise<{ readonly applied: boolean }> {
    const headers = new Headers();
    for (const [name, value] of Object.entries(input.headers)) {
      if (typeof value === "string") headers.set(name, value);
      else for (const entry of value ?? []) headers.append(name, entry);
    }
    const body = input.body.buffer.slice(
      input.body.byteOffset,
      input.body.byteOffset + input.body.byteLength,
    ) as ArrayBuffer;
    const request = new Request(input.url, { method: "POST", headers, body });
    let event: WebhookEvent;
    try {
      event = await (this.options.verifier ?? verifyWebhook)(request, {
        signingSecret: this.options.signingSecret,
      });
    } catch {
      throw new ClerkWebhookVerificationError("Clerk webhook signature is invalid");
    }
    const eventId = headers.get("svix-id")?.trim();
    if (eventId === undefined || eventId.length === 0) throw new TypeError("Clerk webhook id is required");

    // Clerk's signed payload timestamp is source occurrence time; Svix delivery time can change on retry.
    // https://clerk.com/docs/guides/development/webhooks/overview#payload-structure
    const occurredAt = (event as WebhookEvent & { readonly timestamp?: unknown }).timestamp;
    if (typeof occurredAt !== "number" || !Number.isSafeInteger(occurredAt) || occurredAt < 0) {
      throw new TypeError("Clerk provisioning event requires its signed occurrence timestamp");
    }
    const organizationId = async (externalId: string) =>
      await this.store.resolveExternalOrganization?.("clerk", externalId) ?? provisionedOrganizationId(externalId);

    if (event.type === "organization.created" || event.type === "organization.updated") {
      return {
        applied: await this.store.applyExternalIdentityProvisioningEvent({
          eventId,
          occurredAt,
          provider: "clerk",
          type: "organization.upsert",
          externalOrganizationId: event.data.id,
          organizationId: await organizationId(event.data.id),
          organizationName: event.data.name,
        }),
      };
    }
    if (event.type === "organization.deleted") {
      if (event.data.id === undefined) throw new TypeError("deleted Clerk organization has no id");
      return {
        applied: await this.store.applyExternalIdentityProvisioningEvent({
          eventId,
          occurredAt,
          provider: "clerk",
          type: "organization.delete",
          externalOrganizationId: event.data.id,
          organizationId: await organizationId(event.data.id),
        }),
      };
    }
    if (
      event.type === "organizationMembership.created" ||
      event.type === "organizationMembership.updated" ||
      event.type === "organizationMembership.deleted"
    ) {
      const externalOrganizationId = event.data.organization.id;
      const externalUserId = event.data.public_user_data.user_id;
      const roles = provisionedRole(event.data.role);
      return {
        applied: await this.store.applyExternalIdentityProvisioningEvent({
          eventId,
          occurredAt,
          provider: "clerk",
          type: event.type === "organizationMembership.deleted" ? "membership.delete" : "membership.upsert",
          externalOrganizationId,
          organizationId: await organizationId(externalOrganizationId),
          organizationName: event.data.organization.name,
          externalPrincipalId: `user:${externalUserId}`,
          principalId: provisionedPrincipalId(externalUserId),
          workspaceId: this.options.defaultWorkspaceId ?? "default",
          ...roles,
        }),
      };
    }
    return { applied: false };
  }
}

export function parseClerkBindingConfiguration(json: string): ClerkBindingConfiguration {
  let input: unknown;
  try {
    input = JSON.parse(json);
  } catch {
    throw new ClerkBindingConfigurationError("Clerk binding configuration is not valid JSON");
  }
  const parsed = bindingConfigurationSchema.safeParse(input);
  if (!parsed.success) {
    throw new ClerkBindingConfigurationError(
      `Clerk binding configuration is invalid: ${parsed.error.issues[0]?.message ?? "unknown error"}`,
    );
  }
  const organizations = Object.entries(parsed.data.organizations).map(([externalId, organizationId]) => ({
    externalId: externalId.trim(),
    organizationId,
  }));
  const principals = Object.entries(parsed.data.principals).map(([externalId, principalId]) => ({
    externalId: externalId.trim(),
    principalId,
  }));
  if (organizations.some(({ externalId }) => externalId.length === 0)) {
    throw new ClerkBindingConfigurationError("external organization ids must not be empty");
  }
  if (principals.some(({ externalId }) => externalId.length === 0)) {
    throw new ClerkBindingConfigurationError("external principal ids must not be empty");
  }
  if (new Set(organizations.map(({ externalId }) => externalId)).size !== organizations.length) {
    throw new ClerkBindingConfigurationError("external organization ids must be unique after trimming");
  }
  if (new Set(principals.map(({ externalId }) => externalId)).size !== principals.length) {
    throw new ClerkBindingConfigurationError("external principal ids must be unique after trimming");
  }
  const organizationIds = new Set(organizations.map(({ organizationId }) => organizationId));
  if (organizationIds.size !== organizations.length) {
    throw new ClerkBindingConfigurationError("each internal organization may have only one Clerk binding");
  }
  const principalIds = new Set(principals.map(({ principalId }) => principalId));
  const membershipKeys = new Set<string>();
  for (const membership of parsed.data.memberships) {
    if (!organizationIds.has(membership.organizationId)) {
      throw new ClerkBindingConfigurationError(`membership organization is not bound: ${membership.organizationId}`);
    }
    if (!principalIds.has(membership.principalId)) {
      throw new ClerkBindingConfigurationError(`membership principal is not bound: ${membership.principalId}`);
    }
    const key = JSON.stringify([
      membership.organizationId,
      membership.workspaceId,
      membership.principalId,
    ]);
    if (membershipKeys.has(key)) {
      throw new ClerkBindingConfigurationError("Clerk memberships must be unique per organization, workspace, and principal");
    }
    membershipKeys.add(key);
  }
  return { organizations, principals, memberships: parsed.data.memberships };
}
