import type { Author } from "@_89/fold";
import type { MemoryCandidateView, PersonalMemory } from "@_89/fold-epistemic";
import type {
  FoldSdk,
  FoldSdkAccessContext,
  FoldSdkCursor,
  FoldIngestionCursor,
  MemoryRanker,
} from "@_89/fold-sdk";
import type { FoldLogEntry } from "@_89/fold";
import type { ReasoningProvider, ReasoningProviderCatalog } from "./reasoning.js";
import type { DataQualityReport } from "./data-quality.js";
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
}

export const API_CAPABILITIES = [
  "events:read",
  "events:write",
  "memories:read",
  "memories:write",
  "trajectories:read",
  "trajectories:write",
  "trajectories:review",
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
  eventById?(tenant: TenantKey, access: FoldSdkAccessContext, eventId: string): Promise<FoldLogEntry | undefined>;
  sdkFor(
    tenant: TenantKey,
    selection?: {
      readonly kinds?: readonly string[];
      readonly kindPrefixes?: readonly string[];
      readonly latestBySession?: boolean;
      readonly trajectoryTaskId?: string;
      readonly transcriptRunId?: string;
      readonly transcriptChunkRunIds?: readonly string[];
    },
  ): Promise<FoldSdk>;
  dataQuality?(
    tenant: TenantKey,
    access: FoldSdkAccessContext,
  ): Promise<DataQualityReport | undefined>;
  memories?(
    tenant: TenantKey,
    access: FoldSdkAccessContext,
  ): Promise<readonly PersonalMemory[]>;
  memoryCandidates?(
    tenant: TenantKey,
    access: FoldSdkAccessContext,
  ): Promise<readonly MemoryCandidateView[]>;
  trajectoryTasks?(
    tenant: TenantKey,
    access: FoldSdkAccessContext,
    options: {
      readonly limit: number;
      readonly before?: { readonly lastRecordedAt: number; readonly taskId: string };
    },
  ): Promise<{
    readonly tasks: readonly {
      readonly taskId: string;
      readonly trajectoryCount: number;
      readonly successCount: number;
      readonly failureCount: number;
      readonly unknownCount: number;
      readonly lastRecordedAt: number;
    }[];
    readonly total: number;
    readonly nextCursor?: { readonly lastRecordedAt: number; readonly taskId: string };
  }>;
  eventPage?(
    tenant: TenantKey,
    access: FoldSdkAccessContext,
    options: {
      readonly includeDrafts?: boolean;
      readonly kinds?: readonly string[];
      readonly limit: number;
      readonly before?: FoldSdkCursor;
      readonly identity?: Readonly<Partial<Record<"session" | "run" | "project" | "agent", string>>>;
    },
  ): Promise<{ readonly entries: readonly FoldLogEntry[]; readonly total: number; readonly nextCursor?: FoldSdkCursor }>;
  streamEntries?(
    tenant: TenantKey,
    access: FoldSdkAccessContext,
    options: {
      readonly after?: FoldSdkCursor;
      readonly includeDrafts?: boolean;
      readonly kinds?: readonly string[];
      readonly limit: number;
    },
  ): Promise<{
    readonly entries: readonly FoldLogEntry[];
    readonly scannedThrough?: FoldSdkCursor;
  }>;
  latestEventCursor?(
    tenant: TenantKey,
    access: FoldSdkAccessContext,
    options: {
      readonly includeDrafts?: boolean;
      readonly kinds?: readonly string[];
    },
  ): Promise<FoldSdkCursor | undefined>;
  consumerCursor?(tenant: TenantKey, consumerId: string): Promise<FoldSdkCursor | undefined>;
  ingestionEntries?(tenant: TenantKey, access: FoldSdkAccessContext, options: {
    readonly after?: FoldIngestionCursor; readonly includeDrafts?: boolean; readonly kinds?: readonly string[]; readonly limit: number;
  }): Promise<{ readonly items: readonly { readonly entry: FoldLogEntry; readonly cursor: FoldIngestionCursor }[]; readonly scannedThrough?: FoldIngestionCursor }>;
  latestIngestionCursor?(tenant: TenantKey, access: FoldSdkAccessContext, options: { readonly kinds?: readonly string[]; readonly includeDrafts?: boolean }): Promise<FoldIngestionCursor>;
  ingestionConsumerStatus?(tenant: TenantKey, access: FoldSdkAccessContext, consumerId: string, options: { readonly kinds?: readonly string[]; readonly includeDrafts?: boolean }): Promise<{
    readonly cursor: FoldIngestionCursor | null; readonly legacyCursor: FoldSdkCursor | null; readonly migrationRequired: boolean; readonly headCursor: FoldIngestionCursor;
  }>;
  migrateConsumerCursor?(tenant: TenantKey, consumerId: string): Promise<void>;
  resetConsumerCursor?(tenant: TenantKey, consumerId: string, actorId: string, expectedCursor: FoldIngestionCursor, reason: string): Promise<void>;
  commitIngestionCursor?(tenant: TenantKey, consumerId: string, cursor: FoldIngestionCursor): Promise<void>;
  commitConsumerCursor?(
    tenant: TenantKey,
    consumerId: string,
    cursor: FoldSdkCursor,
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
  readonly workspaces?: Readonly<Record<string, StaticWorkspaceMembership>>;
  readonly organizations?: Readonly<Record<string, StaticOrganizationMembership>>;
}

export type StaticCredentialMap = Readonly<Record<string, StaticCredentialConfiguration>>;
