import { createHash } from "node:crypto";

import { authorSchema } from "@_89/fold";
import { validateAccessContext } from "@_89/fold-epistemic";
import { z } from "zod";
import type { PostgresTenantAdministration, TenantMembershipRecord } from "@_89/fold-postgres";

import type {
  AuthenticatedSubject,
  ApiCapability,
  Authenticator,
  MembershipResolver,
  OrganizationRole,
} from "./types.js";
import { DEFAULT_ORGANIZATION_ID } from "./types.js";

const staticWorkspaceMembershipSchema = z
  .object({
    role: z.enum(["owner", "admin", "member"]),
    spaces: z.record(z.enum(["admin", "writer", "reader"])).optional(),
  })
  .strict();

const staticOrganizationMembershipSchema = z.object({
  role: z.enum(["owner", "admin", "member"]),
  workspaces: z.record(staticWorkspaceMembershipSchema),
}).strict();

const staticCredentialSchema = z
  .object({
    principalId: z.string().min(1),
    author: authorSchema.optional(),
    capabilities: z.array(z.enum([
      "events:read",
      "events:write",
      "memories:read",
      "memories:write",
      "trajectories:read",
      "trajectories:write",
      "transcripts:read",
      "transcripts:write",
      "fleet:read",
      "steering:read",
      "steering:write",
      "reasoning:read",
      "consumers:read",
      "consumers:write",
      "organization:admin",
      "platform:data-read",
    ])).max(16).optional(),
    workspaces: z.record(staticWorkspaceMembershipSchema).optional(),
    organizations: z.record(staticOrganizationMembershipSchema).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.workspaces === undefined) === (value.organizations === undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "exactly one of workspaces or organizations is required",
      });
    }
  });

const staticCredentialMapSchema = z.record(staticCredentialSchema);

type ParsedCredentialMap = z.infer<typeof staticCredentialMapSchema>;
type ParsedWorkspaceMembership = z.infer<typeof staticWorkspaceMembershipSchema>;

interface StoredOrganizationMembership {
  readonly role: OrganizationRole;
  readonly workspaces: Readonly<Record<string, ParsedWorkspaceMembership>>;
}

interface StoredCredential {
  readonly subject: AuthenticatedSubject;
  readonly organizations: Readonly<Record<string, StoredOrganizationMembership>>;
}

export class StaticCredentialConfigurationError extends Error {
  override readonly name = "StaticCredentialConfigurationError";
}

function nonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new StaticCredentialConfigurationError(`${label} must not be empty`);
  }
}

function credentialId(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function validateMembership(
  principalId: string,
  organizationId: string,
  workspaceId: string,
  membership: ParsedWorkspaceMembership,
): void {
  nonEmpty(organizationId, "organization id");
  nonEmpty(workspaceId, "workspace id");
  validateAccessContext({
    principalId,
    organizationId,
    workspaceId,
    workspaceRole: membership.role,
    spaceRoles: membership.spaces ?? {},
  });
}

function parseConfiguration(input: unknown): ParsedCredentialMap {
  const parsed = staticCredentialMapSchema.safeParse(input);
  if (!parsed.success) {
    throw new StaticCredentialConfigurationError(
      `credential configuration is invalid: ${parsed.error.issues[0]?.message ?? "unknown error"}`,
    );
  }
  return parsed.data;
}

export class StaticIdentityDirectory implements Authenticator, MembershipResolver {
  private readonly credentials = new Map<string, StoredCredential>();

  constructor(configuration: unknown) {
    const parsedConfiguration = parseConfiguration(configuration);
    for (const [token, configured] of Object.entries(parsedConfiguration)) {
      nonEmpty(token, "credential token");
      nonEmpty(configured.principalId, "credential principalId");
      const author = authorSchema.parse(
        configured.author ?? { kind: "human", id: configured.principalId },
      );
      const organizations: Readonly<Record<string, StoredOrganizationMembership>> =
        configured.organizations ?? {
          [DEFAULT_ORGANIZATION_ID]: {
            role: "owner",
            workspaces: configured.workspaces ?? {},
          },
        };
      for (const [organizationId, organization] of Object.entries(organizations)) {
        nonEmpty(organizationId, "organization id");
        for (const [workspaceId, membership] of Object.entries(organization.workspaces)) {
          validateMembership(configured.principalId, organizationId, workspaceId, membership);
        }
      }
      const id = credentialId(token);
      this.credentials.set(id, {
        subject: {
          credentialId: id,
          principalId: configured.principalId,
          author,
          ...(configured.capabilities === undefined
            ? {}
            : { capabilities: [...new Set(configured.capabilities)] as ApiCapability[] }),
        },
        organizations,
      });
    }
    if (this.credentials.size === 0) {
      throw new StaticCredentialConfigurationError("at least one credential is required");
    }
  }

  static fromJson(json: string): StaticIdentityDirectory {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new StaticCredentialConfigurationError("credential configuration is not valid JSON");
    }
    return new StaticIdentityDirectory(parseConfiguration(parsed));
  }

  async authenticate(bearerToken: string): Promise<AuthenticatedSubject | undefined> {
    if (bearerToken.length === 0) return undefined;
    const subject = this.credentials.get(credentialId(bearerToken))?.subject;
    return subject === undefined
      ? undefined
      : {
          ...subject,
          author: { ...subject.author },
          ...(subject.capabilities === undefined ? {} : { capabilities: [...subject.capabilities] }),
        };
  }

  async resolveAccess(
    subject: AuthenticatedSubject,
    organizationId: string,
    workspaceId: string,
  ) {
    const stored = this.credentials.get(subject.credentialId);
    if (
      stored === undefined ||
      stored.subject.principalId !== subject.principalId ||
      stored.subject.author.kind !== subject.author.kind ||
      stored.subject.author.id !== subject.author.id ||
      stored.subject.author.productionId !== subject.author.productionId ||
      JSON.stringify(stored.subject.capabilities) !== JSON.stringify(subject.capabilities)
    ) {
      return undefined;
    }
    const organization = stored.organizations[organizationId];
    if (organization === undefined) return undefined;
    const membership = organization.workspaces[workspaceId];
    if (membership === undefined) return undefined;
    return {
      principalId: subject.principalId,
      organizationId,
      organizationRole: organization.role,
      workspaceId,
      workspaceRole: membership.role,
      spaceRoles: { ...(membership.spaces ?? {}) },
    };
  }

  async resolveLegacyAccess(subject: AuthenticatedSubject, workspaceId: string) {
    const stored = this.credentials.get(subject.credentialId);
    if (stored === undefined) return undefined;
    const organizations = Object.keys(stored.organizations).filter(
      (organizationId) => stored.organizations[organizationId]?.workspaces[workspaceId] !== undefined,
    );
    if (organizations.length !== 1) return undefined;
    return this.resolveAccess(subject, organizations[0]!, workspaceId);
  }

  configuredMemberships(): readonly TenantMembershipRecord[] {
    const memberships = new Map<string, TenantMembershipRecord>();
    for (const stored of this.credentials.values()) {
      for (const [organizationId, organization] of Object.entries(stored.organizations)) {
        for (const [workspaceId, workspace] of Object.entries(organization.workspaces)) {
          const record: TenantMembershipRecord = {
            organizationId,
            organizationRole: organization.role,
            workspaceId,
            workspaceRole: workspace.role,
            principalId: stored.subject.principalId,
            spaceRoles: { ...(workspace.spaces ?? {}) },
          };
          const key = JSON.stringify([organizationId, workspaceId, record.principalId]);
          const previous = memberships.get(key);
          if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(record)) {
            throw new StaticCredentialConfigurationError(
              `principal ${record.principalId} has conflicting memberships for ${organizationId}/${workspaceId}`,
            );
          }
          memberships.set(key, record);
        }
      }
    }
    return [...memberships.values()];
  }
}

export class PostgresMembershipResolver implements MembershipResolver {
  constructor(private readonly administration: PostgresTenantAdministration) {}

  async resolveAccess(subject: AuthenticatedSubject, organizationId: string, workspaceId: string) {
    const membership = await this.administration.resolveMembership(
      organizationId,
      workspaceId,
      subject.principalId,
    );
    if (membership === undefined) return undefined;
    return {
      principalId: subject.principalId,
      organizationId,
      organizationRole: membership.organizationRole,
      workspaceId,
      workspaceRole: membership.workspaceRole,
      spaceRoles: { ...membership.spaceRoles },
    };
  }

  resolveLegacyAccess(subject: AuthenticatedSubject, workspaceId: string) {
    return this.resolveAccess(subject, DEFAULT_ORGANIZATION_ID, workspaceId);
  }
}
