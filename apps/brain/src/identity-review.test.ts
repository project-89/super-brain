import { describe, expect, it } from "vitest";
import { evidenceIds, identityHistoryLabel, identityInputProblem, IdentityPageChangedError, matchesIdentityReview, mergeIdentityPages, withIdentitySource } from "./identity-review";

describe("identity review inputs", () => {
  const base = { active: true, reason: "Reviewed source evidence", evidenceEventIds: [] };
  it("keeps evidence IDs complete and deduplicates exact lines", () => {
    expect(evidenceIds(" first-event \nsecond,event\nfirst-event\n")).toEqual(["first-event", "second,event"]);
  });
  it("requires explicit people/source identity and attribution boundaries", () => {
    expect(identityInputProblem({ ...base, id: "person", kind: "person", label: "Andrew" })).toBeUndefined();
    expect(identityInputProblem({ ...base, id: "account", kind: "account", label: "Account" })).toContain("provider");
    expect(identityInputProblem({ ...base, id: "person", kind: "person", label: "Andrew", source: { provider: "git", externalId: "a" } })).toContain("cannot");
    expect(identityInputProblem({ ...base, entityId: "same", personId: "same" })).toContain("separate");
    expect(identityInputProblem({ ...base, entityId: "source", personId: "person" })).toBeUndefined();
  });
  it("requires alias review reasons and distinct targets", () => {
    expect(identityInputProblem({ ...base, aliasProjectId: "old", canonicalProjectId: "new" })).toBeUndefined();
    expect(identityInputProblem({ ...base, aliasProjectId: "old", canonicalProjectId: "new", reason: " " })).toContain("reason");
    expect(identityInputProblem({ ...base, aliasProjectId: "same", canonicalProjectId: "same" })).toContain("different");
  });
  it("invalidates the reviewed input after any target, reason, status, or evidence edit", () => {
    const input = { ...base, aliasProjectId: "old", canonicalProjectId: "new" };
    const reviewed = JSON.stringify(input);
    expect(matchesIdentityReview(input, reviewed)).toBe(true);
    expect(matchesIdentityReview(input, undefined)).toBe(false);
    for (const next of [{ ...input, canonicalProjectId: "other" }, { ...input, reason: "Changed" }, { ...input, active: false }, { ...input, evidenceEventIds: ["new-evidence"] }]) expect(matchesIdentityReview(next, reviewed)).toBe(false);
  });
  it("never pairs stale first-page fields with a newer revision or different workspace", () => {
    const first = { items: [{ id: "a", label: "Old name" }], total: 2, nextCursor: "next", revision: "revision-one", scope: { workspaceId: "w", visibility: "workspace" as const }, canManage: true };
    const next = { ...first, items: [{ id: "b", label: "Another person" }], nextCursor: undefined };
    expect(mergeIdentityPages(first, next, (item) => item.id).items).toEqual([...first.items, ...next.items]);
    expect(() => mergeIdentityPages(first, { ...next, revision: "revision-two" }, (item) => item.id)).toThrow(IdentityPageChangedError);
    expect(() => mergeIdentityPages(first, { ...next, scope: { ...next.scope, workspaceId: "other" } }, (item) => item.id)).toThrow(IdentityPageChangedError);
    expect(first.items[0]?.label).toBe("Old name");
    expect(first.revision).toBe("revision-one");
  });
  it("removes empty optional source fields and matches server field limits", () => {
    const agent = { ...base, id: "agent", kind: "agent" as const, label: "Worker" };
    expect(withIdentitySource(agent, "provider", "")).not.toHaveProperty("source");
    expect(withIdentitySource(agent, "provider", "codex").source).toEqual({ provider: "codex", externalId: "" });
    expect(identityInputProblem({ ...agent, label: "x".repeat(301) })).toContain("300");
    expect(identityInputProblem({ ...agent, evidenceEventIds: Array.from({ length: 101 }, (_, index) => String(index)) })).toContain("100");
  });
  it("describes revocation without claiming evidence was deleted", () => {
    expect(identityHistoryLabel({ kind: "project-alias", input: { ...base, active: false, aliasProjectId: "old", canonicalProjectId: "new" } })).toBe("Project alias revoked");
    expect(identityHistoryLabel({ kind: "attribution", input: { ...base, active: false, entityId: "source", personId: "person" } })).toBe("Person attribution revoked");
  });
});
