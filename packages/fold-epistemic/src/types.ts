import type { Author, CaptureEnvelope, JsonValue } from "@_89/fold";

export type WorkspaceRole = "owner" | "admin" | "member";
export type SpaceRole = "admin" | "writer" | "reader";

export interface EpistemicAccessContext {
  readonly principalId: string;
  readonly workspaceId: string;
  readonly workspaceRole: WorkspaceRole;
  readonly spaceRoles: Readonly<Record<string, SpaceRole>>;
}

export interface MemoryEntityRef {
  readonly id: string;
  readonly type: string;
  readonly name: string;
}

export interface PersonalMemory {
  readonly id: string;
  readonly workspaceId: string;
  readonly spaceId?: string;
  readonly creatorId: string;
  readonly source: string;
  readonly summary: string;
  readonly content: JsonValue;
  readonly tags: readonly string[];
  readonly entities: readonly MemoryEntityRef[];
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly revision: number;
}

export interface MemoryInput {
  readonly id: string;
  readonly spaceId?: string;
  readonly source: string;
  readonly summary?: string;
  readonly content?: JsonValue;
  readonly tags?: readonly string[];
  readonly entities?: readonly MemoryEntityRef[];
}

export interface MemoryRevisionPatch {
  readonly summary?: string;
  readonly content?: JsonValue;
  readonly tags?: readonly string[];
}

export interface ForgottenMemory {
  readonly memoryId: string;
  readonly workspaceId: string;
  readonly spaceId?: string;
  readonly creatorId: string;
  readonly forgottenAt: number;
  readonly reason: string;
}

export interface MemoryProjection {
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
  readonly scope?: RecallScope;
  readonly tags?: readonly string[];
  readonly sources?: readonly string[];
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
