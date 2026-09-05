import type { Author, CaptureEnvelope, JsonValue } from "@_89/fold";

export type WorkspaceRole = "owner" | "admin" | "member";
export type SpaceRole = "admin" | "writer" | "reader";

export interface EpistemicAccessContext {
  readonly principalId: string;
  readonly organizationId?: string;
  readonly platformDataAccess?: boolean;
  readonly workspaceId: string;
  readonly workspaceRole: WorkspaceRole;
  readonly spaceRoles: Readonly<Record<string, SpaceRole>>;
}

export interface MemoryEntityRef {
  readonly id: string;
  readonly type: string;
  readonly name: string;
}

export type MemoryAudience = "personal" | "workspace";

export type MemoryApplicability =
  | { readonly kind: "unresolved" }
  | { readonly kind: "global" }
  | { readonly kind: "projects"; readonly projectIds: readonly string[] };
export interface MemoryRevisionRef { readonly memoryId: string; readonly revision: number }
export interface MemoryCurrentness { readonly status: "current" | "needs-review" | "superseded"; readonly reasons: readonly string[] }
export interface MemorySourceCandidateRef { readonly candidateId: string; readonly revision: number; readonly decisionEventId: string }
export interface MemoryValidityInput {
  readonly applicability?: MemoryApplicability;
  readonly sourceMemoryRefs?: readonly MemoryRevisionRef[];
  readonly supersedes?: readonly MemoryRevisionRef[];
  readonly contradicts?: readonly MemoryRevisionRef[];
}
export interface MemoryEvidenceContributionInput { readonly evidence: readonly MemoryCandidateEvidence[]; readonly expectedRevision?: number }
/** Attested at the authorized command boundary; replay retains the actor and scope. */
export type MemoryWriteAuthority = "creator" | "workspace-writer" | "space-writer";


export interface PersonalMemory extends MemoryValidityInput {
  readonly currentness?: MemoryCurrentness;
  readonly sourceCandidate?: MemorySourceCandidateRef;
  readonly id: string;
  readonly workspaceId: string;
  readonly spaceId?: string;
  readonly creatorId: string;
  readonly audience: MemoryAudience;
  readonly projectIds: readonly string[];
  readonly source: string;
  readonly summary: string;
  readonly content: JsonValue;
  readonly tags: readonly string[];
  readonly entities: readonly MemoryEntityRef[];
  readonly evidence?: readonly MemoryCandidateEvidence[];
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly revision: number;
}

export interface MemoryInput extends MemoryValidityInput {
  readonly sourceCandidate?: MemorySourceCandidateRef;
  readonly id: string;
  readonly spaceId?: string;
  readonly audience?: MemoryAudience;
  readonly projectIds?: readonly string[];
  readonly source: string;
  readonly summary?: string;
  readonly content?: JsonValue;
  readonly tags?: readonly string[];
  readonly entities?: readonly MemoryEntityRef[];
  readonly evidence?: readonly MemoryCandidateEvidence[];
}

export interface MemoryRevisionPatch extends MemoryValidityInput {
  readonly summary?: string;
  readonly content?: JsonValue;
  readonly tags?: readonly string[];
  readonly evidence?: readonly MemoryCandidateEvidence[];
}

export interface ForgottenMemory {
  readonly memoryId: string;
  readonly workspaceId: string;
  readonly spaceId?: string;
  readonly creatorId: string;
  readonly audience: MemoryAudience;
  readonly forgottenAt: number;
  readonly reason: string;
}

export interface MemoryProjection {
  readonly revisions?: ReadonlyMap<string, ReadonlyMap<number, PersonalMemory>>;
  readonly memories: ReadonlyMap<string, PersonalMemory>;
  readonly forgotten: ReadonlyMap<string, ForgottenMemory>;
}

export type RecallDenialReason =
  | "workspace-mismatch"
  | "creator-mismatch"
  | "space-inaccessible";

export type RecallDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: RecallDenialReason };

export type RecallScope =
  | { readonly kind: "all" }
  | { readonly kind: "workspace" }
  | { readonly kind: "space"; readonly spaceId: string };

export interface SemanticMemoryCandidate {
  readonly memoryId: string;
  readonly score: number;
}

export interface RecallRequest {
  readonly includeNeedsReview?: boolean;
  readonly scope?: RecallScope;
  readonly tags?: readonly string[];
  readonly sources?: readonly string[];
  readonly projectIds?: readonly string[];
  readonly from?: number;
  readonly to?: number;
  readonly limit?: number;
  readonly candidates?: readonly SemanticMemoryCandidate[];
}

export interface RecalledMemory {
  readonly memory: PersonalMemory;
  readonly score?: number;
}

export interface MemoryCaptureIdentity extends Readonly<Record<string, string>> {
  readonly principal: string;
  readonly workspace: string;
}

export interface MemoryCandidateEvidence {
  readonly relation?: "supports" | "opposes";
  readonly eventId: string;
  readonly projectId?: string;
  readonly runId?: string;
  readonly turnId?: string;
}

export interface MemoryCandidateExtractor {
  readonly kind: "rule" | "model" | "human";
  readonly id: string;
  readonly version: string;
}

export interface MemoryCandidateInput extends MemoryValidityInput {
  readonly id: string;
  readonly spaceId?: string;
  readonly audience?: MemoryAudience;
  readonly projectIds?: readonly string[];
  readonly source: string;
  readonly summary: string;
  readonly content: JsonValue;
  readonly tags?: readonly string[];
  readonly entities?: readonly MemoryEntityRef[];
  readonly evidence: readonly MemoryCandidateEvidence[];
  readonly confidence: number;
  readonly salience: number;
  readonly extractor: MemoryCandidateExtractor;
}

export interface MemoryCandidate extends Omit<MemoryCandidateInput, "audience" | "projectIds" | "tags" | "entities"> {
  readonly workspaceId: string;
  readonly proposerId: string;
  readonly audience: MemoryAudience;
  readonly projectIds: readonly string[];
  readonly tags: readonly string[];
  readonly entities: readonly MemoryEntityRef[];
  readonly revision?: number;
  readonly updatedAt?: number;
  readonly proposedAt: number;
  readonly proposalEventId: string;
}

export type MemoryCandidateDecision =
  | {
      readonly kind: "accepted";
      readonly candidateId: string;
      readonly actorId: string;
      readonly atMs: number;
      readonly eventId: string;
      readonly candidateRevision?: number;
      readonly memoryId: string;
    }
  | {
      readonly kind: "rejected";
      readonly candidateId: string;
      readonly actorId: string;
      readonly atMs: number;
      readonly eventId: string;
      readonly reason: string;
    };

export interface MemoryCandidateView {
  readonly candidate: MemoryCandidate;
  readonly status: "proposed" | "accepted" | "rejected";
  readonly decision?: MemoryCandidateDecision;
}

export interface MemoryCandidateProjection {
  readonly candidates: ReadonlyMap<string, MemoryCandidate>;
  readonly decisions: ReadonlyMap<string, MemoryCandidateDecision>;
}

export type MemoryCaptureEnvelope = Omit<CaptureEnvelope, "identity"> & {
  readonly identity: MemoryCaptureIdentity;
};

export interface EpistemicEventContext {
  readonly access: EpistemicAccessContext;
  readonly author: Author;
  readonly capture: MemoryCaptureEnvelope;
}

export interface EpistemicEventStamp {
  readonly id: string;
  readonly t: number;
  readonly worldDate: string;
}
