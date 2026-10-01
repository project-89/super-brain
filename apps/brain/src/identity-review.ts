import type { IdentityAttributionInput, IdentityEntityInput, IdentityHistory, IdentityPage, ProjectAliasInput } from "./identity-types";

export type IdentityReviewInput = IdentityEntityInput | IdentityAttributionInput | ProjectAliasInput;

export class IdentityPageChangedError extends Error {
  override readonly name = "IdentityPageChangedError";
}

export function mergeIdentityPages<T>(current: IdentityPage<T>, next: IdentityPage<T>, keyOf: (item: T) => string): IdentityPage<T> {
  if (current.revision !== next.revision || current.scope.workspaceId !== next.scope.workspaceId || current.scope.visibility !== next.scope.visibility) {
    throw new IdentityPageChangedError("Identity state changed while paging. Refresh this view before reviewing changes.");
  }
  const seen = new Set(current.items.map(keyOf));
  return { ...next, items: [...current.items, ...next.items.filter((item) => !seen.has(keyOf(item)))] };
}

export function matchesIdentityReview(input: IdentityReviewInput, reviewed: string | undefined): boolean {
  return reviewed !== undefined && JSON.stringify(input) === reviewed;
}

export function evidenceIds(value: string): string[] {
  return [...new Set(value.split(/\r?\n/).map((id) => id.trim()).filter(Boolean))];
}

export function identityInputProblem(input: IdentityReviewInput): string | undefined {
  if (!input.reason.trim()) return "A reason is required.";
  if (input.reason.trim().length > 2000) return "Reason must be at most 2000 characters.";
  if (input.evidenceEventIds.length > 100 || input.evidenceEventIds.some((id) => id.trim().length === 0 || id.trim().length > 500)) return "Use at most 100 evidence IDs, each at most 500 characters.";
  if ("id" in input) {
    if (!input.id.trim() || !input.label.trim()) return "An identity ID and name are required.";
    if (input.id.trim().length > 500 || input.label.trim().length > 300) return "Name must be at most 300 characters; identity ID at most 500.";
    if (input.kind === "person" && input.source !== undefined) return "People cannot be source accounts.";
    if (input.kind === "account" && input.source === undefined) return "Source accounts require a provider and external ID.";
    if (input.source !== undefined && (!input.source.provider.trim() || !input.source.externalId.trim())) return "Both provider and external ID are required.";
    if (input.source !== undefined && (input.source.provider.trim().length > 500 || input.source.externalId.trim().length > 500)) return "Provider and external ID must each be at most 500 characters.";
  } else if ("entityId" in input) {
    if (!input.entityId || !input.personId) return "Select a source identity and a person.";
    if (input.entityId === input.personId) return "A person and source identity must be separate records.";
  } else {
    if (!input.aliasProjectId || !input.canonicalProjectId) return "Select both project identities.";
    if (input.aliasProjectId === input.canonicalProjectId) return "Select two different project identities.";
  }
  return undefined;
}

export function withIdentitySource(input: IdentityEntityInput, field: "provider" | "externalId", value: string): IdentityEntityInput {
  const source = { provider: input.source?.provider ?? "", externalId: input.source?.externalId ?? "", [field]: value };
  if (source.provider === "" && source.externalId === "") {
    const { source: _source, ...withoutSource } = input;
    return withoutSource;
  }
  return { ...input, source };
}

export function identityHistoryLabel(record: Pick<IdentityHistory, "kind" | "input">): string {
  if (record.kind === "entity") return record.input.active ? "Identity recorded" : "Identity deactivated";
  if (record.kind === "attribution") return record.input.active ? "Person attribution recorded" : "Person attribution revoked";
  return record.input.active ? "Project alias recorded" : "Project alias revoked";
}
