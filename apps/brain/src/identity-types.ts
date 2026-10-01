export type IdentityKind = "person" | "account" | "agent" | "machine";

export interface IdentitySource {
  readonly provider: string;
  readonly externalId: string;
}

export interface IdentityEntityInput {
  readonly id: string;
  readonly kind: IdentityKind;
  readonly label: string;
  readonly source?: IdentitySource;
  readonly active: boolean;
  readonly reason: string;
  readonly evidenceEventIds: readonly string[];
}

export interface IdentityEntity extends IdentityEntityInput {
  readonly eventId: string;
  readonly recordedAt: number;
  readonly actorId: string;
}

export interface IdentityAttributionInput {
  readonly entityId: string;
  readonly personId: string;
  readonly active: boolean;
  readonly reason: string;
  readonly evidenceEventIds: readonly string[];
}

export interface IdentityAttribution extends IdentityAttributionInput {
  readonly entityLabel?: string;
  readonly personLabel?: string;
  readonly eventId: string;
  readonly recordedAt: number;
  readonly actorId: string;
}

export interface ProjectAliasInput {
  readonly aliasProjectId: string;
  readonly canonicalProjectId: string;
  readonly active: boolean;
  readonly reason: string;
  readonly evidenceEventIds: readonly string[];
}

export interface ProjectAlias extends ProjectAliasInput {
  readonly aliasProjectName?: string;
  readonly canonicalProjectName?: string;
  readonly eventId: string;
  readonly recordedAt: number;
  readonly actorId: string;
}

export interface IdentityScope {
  readonly workspaceId: string;
  readonly visibility: "workspace";
}

export interface IdentityPage<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly nextCursor?: string;
  readonly revision: string | null;
  readonly scope: IdentityScope;
  readonly canManage: boolean;
}

export interface IdentityHistory {
  readonly kind: "entity" | "attribution" | "project-alias";
  readonly input: IdentityEntityInput | IdentityAttributionInput | ProjectAliasInput;
  readonly eventId: string;
  readonly recordedAt: number;
  readonly actorId: string;
  readonly previousRevision: string | null;
  readonly workspaceId: string;
}

export interface IdentityProject {
  readonly id: string;
  readonly name: string;
  readonly canonicalProjectId: string;
}

export interface ProjectAliasPreview {
  readonly revision: string | null;
  readonly previewToken: string;
  readonly scope: IdentityScope;
  readonly conflicts: readonly string[];
  readonly affected: { readonly projectIds: readonly string[]; readonly runs: number; readonly memories: number; readonly candidates: number };
  readonly beforeCanonicalProjectId: string;
  readonly afterCanonicalProjectId: string;
}
