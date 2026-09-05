import type { Author } from "@_89/fold";
import type { TaskEvidenceAuthority } from "@_89/fold-trajectory";
import type {
  FoldSdk,
  FoldSdkAccessContext,
  FoldSdkCursor,
  FoldConsumerCursor,
  FoldDeliveryCursor,
  MemoryRanker,
} from "@_89/fold-sdk";
import type { FoldLogEntry } from "@_89/fold";
import type { ReasoningProvider, ReasoningProviderCatalog } from "./reasoning.js";
import type { RequestRateLimiter } from "./rate-limit.js";
import type {
  ExternalIdentityProvisioningEvent,
  IdentityProvisioningAuditRecord,
  PlatformAccessAuditRecord,
  RepositoryEnrollment,
} from "@_89/fold-postgres";

export interface AuthenticatedSubject {
  readonly credentialId: string;
  readonly principalId: string;
  readonly author: Author;
  readonly capabilities?: readonly ApiCapability[];
  readonly identityProvider?: "static" | "clerk";
  readonly organizationId?: string;
  readonly organizationRoleLimit?: OrganizationRole;
  readonly taskEvidenceAuthority?: TaskEvidenceAuthority;
}

export const API_CAPABILITIES = [
  "events:read",
  "events:write",
  "memories:read",
  "memories:write",
  "feedback:write",
  "trajectories:read",
  "trajectories:write",
  "task-outcomes:write",
  "task-interventions:write",
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
] as const;

export type ApiCapability = (typeof API_CAPABILITIES)[number];

export const DEFAULT_ORGANIZATION_ID = "local";

export type OrganizationRole = "owner" | "admin" | "member";

export interface TenantKey {
  readonly organizationId: string;
  readonly workspaceId: string;
}

export interface OrganizationAccessContext extends FoldSdkAccessContext {
  readonly organizationId: string;
  readonly organizationRole: OrganizationRole;
}

export interface Authenticator {
  authenticate(bearerToken: string): Promise<AuthenticatedSubject | undefined>;
}

export interface MembershipResolver {
  resolveAccess(
    subject: AuthenticatedSubject,
    organizationId: string,
    workspaceId: string,
  ): Promise<OrganizationAccessContext | undefined>;
  resolveLegacyAccess(
    subject: AuthenticatedSubject,
    workspaceId: string,
  ): Promise<OrganizationAccessContext | undefined>;
}

export interface FoldSdkRegistry {
  sdkFor(tenant: TenantKey): Promise<FoldSdk>;
  streamEntries?(
    tenant: TenantKey,
    access: FoldSdkAccessContext,
    options: {
      readonly after?: FoldConsumerCursor;
      readonly includeDrafts?: boolean;
      readonly kinds?: readonly string[];
      readonly limit: number;
    },
  ): Promise<{
    readonly entries: readonly FoldLogEntry[];
    readonly scannedThrough?: FoldDeliveryCursor;
    readonly cursors: readonly FoldDeliveryCursor[];
  }>;
  latestEventCursor?(
    tenant: TenantKey,
    access: FoldSdkAccessContext,
    options: {
      readonly includeDrafts?: boolean;
      readonly kinds?: readonly string[];
    },
  ): Promise<FoldConsumerCursor | undefined>;
  consumerCursor?(tenant: TenantKey, consumerId: string): Promise<FoldConsumerCursor | undefined>;
  commitConsumerCursor?(
    tenant: TenantKey,
    consumerId: string,
    cursor: FoldConsumerCursor,
  ): Promise<void>;
}

export interface TenantAdministration {
  listRepositoryEnrollments(
    organizationId: string,
    workspaceId: string,
  ): Promise<readonly RepositoryEnrollment[]>;
  enrollRepository(input: {
    readonly organizationId: string;
    readonly workspaceId: string;
    readonly normalizedRemote: string;
    readonly projectId?: string;
    readonly enrolledBy: string;
  }): Promise<RepositoryEnrollment>;
  recordPlatformAccess(
    input: Omit<PlatformAccessAuditRecord, "id" | "accessedAt">,
  ): Promise<PlatformAccessAuditRecord>;
  listPlatformAccessAudit(
    organizationId: string,
    workspaceId: string,
  ): Promise<readonly PlatformAccessAuditRecord[]>;
  listPrincipalMemberships?(
    organizationId: string,
    principalId: string,
  ): Promise<readonly {
    readonly organizationId: string;
    readonly organizationRole: OrganizationRole;
    readonly workspaceId: string;
    readonly workspaceRole: FoldSdkAccessContext["workspaceRole"];
  }[]>;
  applyExternalIdentityProvisioningEvent?(
    input: ExternalIdentityProvisioningEvent,
  ): Promise<boolean>;
  listIdentityProvisioningAudit?(
    organizationId: string,
  ): Promise<readonly IdentityProvisioningAuditRecord[]>;
}

export interface IdentityProvisioningWebhook {
  handle(input: {
    readonly url: string;
    readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
    readonly body: Uint8Array;
  }): Promise<{ readonly applied: boolean }>;
}

export interface ApiDependencies {
  readonly authenticator: Authenticator;
  readonly memberships: MembershipResolver;
  readonly sdks: FoldSdkRegistry;
  readonly maxBodyBytes?: number;
  readonly memoryRanker?: MemoryRanker;
  readonly reasoner?: ReasoningProvider;
  readonly reasoners?: ReasoningProviderCatalog;
  readonly rateLimiter?: RequestRateLimiter;
  readonly corsOrigins?: readonly string[];
  readonly reportError?: (error: unknown) => void;
  readonly eventStreamPollMs?: number;
  readonly eventStreamMaxConnections?: number;
  readonly eventStreamMaxPerPrincipal?: number;
  readonly eventStreamMaxAgeMs?: number;
  readonly eventStreamDrainTimeoutMs?: number;
  readonly fleetOrphanAfterMs?: number;
  readonly tenantAdministration?: TenantAdministration;
  readonly identityProvisioningWebhook?: IdentityProvisioningWebhook;
}

export interface StaticWorkspaceMembership {
  readonly role: FoldSdkAccessContext["workspaceRole"];
  readonly spaces?: Readonly<Record<string, FoldSdkAccessContext["spaceRoles"][string]>>;
}

export interface StaticOrganizationMembership {
  readonly role: OrganizationRole;
  readonly workspaces: Readonly<Record<string, StaticWorkspaceMembership>>;
}

export interface StaticCredentialConfiguration {
  readonly principalId: string;
  readonly author?: Author;
  readonly capabilities?: readonly ApiCapability[];
  readonly taskEvidenceAuthority?: { readonly kind: "human" } | { readonly kind: "integration"; readonly integrationId: string };
  readonly workspaces?: Readonly<Record<string, StaticWorkspaceMembership>>;
  readonly organizations?: Readonly<Record<string, StaticOrganizationMembership>>;
}

export type StaticCredentialMap = Readonly<Record<string, StaticCredentialConfiguration>>;
