import type { Author } from "@_89/fold";
import type {
  FoldSdk,
  FoldSdkAccessContext,
  MemoryRanker,
} from "@_89/fold-sdk";
import type { ReasoningProvider } from "./reasoning.js";
import type { RequestRateLimiter } from "./rate-limit.js";

export interface AuthenticatedSubject {
  readonly credentialId: string;
  readonly principalId: string;
  readonly author: Author;
}

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
}

export interface StaticWorkspaceMembership {
  readonly role: FoldSdkAccessContext["workspaceRole"];
  readonly spaces?: Readonly<Record<string, FoldSdkAccessContext["spaceRoles"][string]>>;
}

export interface StaticCredentialConfiguration {
  readonly principalId: string;
  readonly author?: Author;
  readonly workspaces: Readonly<Record<string, StaticWorkspaceMembership>>;
}

export type StaticCredentialMap = Readonly<Record<string, StaticCredentialConfiguration>>;
