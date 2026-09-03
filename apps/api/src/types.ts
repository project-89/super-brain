import type { Author } from "@_89/fold";
import type {
  FoldSdk,
  FoldSdkAccessContext,
  FoldSdkCursor,
  MemoryRanker,
} from "@_89/fold-sdk";
import type { FoldLogEntry } from "@_89/fold";
import type { ReasoningProvider } from "./reasoning.js";
import type { RequestRateLimiter } from "./rate-limit.js";

export interface AuthenticatedSubject {
  readonly credentialId: string;
  readonly principalId: string;
  readonly author: Author;
  readonly capabilities?: readonly ApiCapability[];
}

export type ApiCapability =
  | "events:read"
  | "events:write"
  | "memories:read"
  | "memories:write"
  | "trajectories:read"
  | "trajectories:write"
  | "transcripts:read"
  | "transcripts:write"
  | "fleet:read"
  | "steering:read"
  | "steering:write"
  | "reasoning:read"
  | "consumers:read"
  | "consumers:write";

export interface Authenticator {
  authenticate(bearerToken: string): Promise<AuthenticatedSubject | undefined>;
}

export interface MembershipResolver {
  resolveAccess(
    subject: AuthenticatedSubject,
    workspaceId: string,
  ): Promise<FoldSdkAccessContext | undefined>;
}

export interface FoldSdkRegistry {
  sdkFor(workspaceId: string): Promise<FoldSdk>;
  streamEntries?(
    workspaceId: string,
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
    workspaceId: string,
    access: FoldSdkAccessContext,
    options: {
      readonly includeDrafts?: boolean;
      readonly kinds?: readonly string[];
    },
  ): Promise<FoldSdkCursor | undefined>;
  consumerCursor?(workspaceId: string, consumerId: string): Promise<FoldSdkCursor | undefined>;
  commitConsumerCursor?(
    workspaceId: string,
    consumerId: string,
    cursor: FoldSdkCursor,
  ): Promise<void>;
}

export interface ApiDependencies {
  readonly authenticator: Authenticator;
  readonly memberships: MembershipResolver;
  readonly sdks: FoldSdkRegistry;
  readonly maxBodyBytes?: number;
  readonly memoryRanker?: MemoryRanker;
  readonly reasoner?: ReasoningProvider;
  readonly rateLimiter?: RequestRateLimiter;
  readonly corsOrigins?: readonly string[];
  readonly reportError?: (error: unknown) => void;
  readonly eventStreamPollMs?: number;
  readonly fleetOrphanAfterMs?: number;
}

export interface StaticWorkspaceMembership {
  readonly role: FoldSdkAccessContext["workspaceRole"];
  readonly spaces?: Readonly<Record<string, FoldSdkAccessContext["spaceRoles"][string]>>;
}

export interface StaticCredentialConfiguration {
  readonly principalId: string;
  readonly author?: Author;
  readonly capabilities?: readonly ApiCapability[];
  readonly workspaces: Readonly<Record<string, StaticWorkspaceMembership>>;
}

export type StaticCredentialMap = Readonly<Record<string, StaticCredentialConfiguration>>;
