import { describe, expect, it } from "vitest";
import { canonicalProjectId, makeIdentityEvent, rebuildIdentities, resolveProjectIds, type IdentityInput } from "../src/index.js";
import type { FoldEvent } from "@_89/fold";
const context = { workspaceId: "w", principalId: "admin", author: { kind: "human" as const, id: "admin" } };
const review = { reason: "Reviewed source evidence", evidenceEventIds: [], active: true };
function append(events: FoldEvent[], operation: IdentityInput) {
  const event = makeIdentityEvent(context, { t: events.length + 1, worldDate: "2026-09-15" }, events.at(-1)?.id ?? null, operation);
  rebuildIdentities([...events, event]); events.push(event); return event;
}
describe("reviewed identity replay", () => {
  it("separates people from source accounts and records attributable reassignment and revocation", () => {
    const events: FoldEvent[] = [];
    for (const id of ["andrew", "jake"]) append(events, { kind: "entity", input: { id, kind: "person", label: "Same display name", ...review } });
    append(events, { kind: "entity", input: { id: "account", kind: "account", label: "Coding", source: { provider: "codex", externalId: "account-1" }, ...review } });
    append(events, { kind: "attribution", input: { entityId: "account", personId: "andrew", ...review } });
    append(events, { kind: "attribution", input: { entityId: "account", personId: "jake", ...review } });
    let projected = rebuildIdentities(events);
    expect(projected.attributions.get("account")).toMatchObject({ personId: "jake", actorId: "admin" });
    expect(() => append(events, { kind: "entity", input: { id: "jake", kind: "person", label: "Jake", ...review, active: false } })).toThrow(/Revoke active/);
    append(events, { kind: "attribution", input: { entityId: "account", personId: "jake", ...review, active: false } });
    projected = rebuildIdentities(events);
    expect(projected.history.filter((item) => item.kind === "attribution")).toHaveLength(3);
    expect(projected.attributions.get("account")?.active).toBe(false);
    expect(() => append(events, { kind: "entity", input: { id: "duplicate", kind: "agent", label: "Wrong", source: { provider: "codex", externalId: "account-1" }, ...review } })).toThrow(/already represented/);
    expect(() => append(events, { kind: "entity", input: { id: "account", kind: "person", label: "Wrong", ...review } })).toThrow(/kind cannot change/);
  });
  it("merges aliases transitively and splits on revocation without changing source IDs", () => {
    const events: FoldEvent[] = [];
    append(events, { kind: "project-alias", input: { aliasProjectId: "worktree", canonicalProjectId: "local", ...review } });
    append(events, { kind: "project-alias", input: { aliasProjectId: "local", canonicalProjectId: "remote", ...review } });
    const merged = rebuildIdentities(events);
    expect(canonicalProjectId(merged, "worktree")).toBe("remote");
    expect(resolveProjectIds(merged, ["remote"])).toEqual(["local", "remote", "worktree"]);
    expect(() => append(events, { kind: "project-alias", input: { aliasProjectId: "remote", canonicalProjectId: "worktree", ...review } })).toThrow(/cycle/);
    append(events, { kind: "project-alias", input: { aliasProjectId: "local", canonicalProjectId: "remote", ...review, active: false } });
    expect(resolveProjectIds(rebuildIdentities(events), ["remote"])).toEqual(["remote"]);
    expect(canonicalProjectId(rebuildIdentities(events), "worktree")).toBe("local");
    expect(rebuildIdentities(events).history[0]!.input).toMatchObject({ aliasProjectId: "worktree", canonicalProjectId: "local" });
  });
  it("rejects stale revisions, forged authors, mismatched workspaces and unknown payloads", () => {
    const events: FoldEvent[] = [];
    const first = append(events, { kind: "entity", input: { id: "p", kind: "person", label: "Person", ...review } });
    const stale = makeIdentityEvent(context, { t: 2, worldDate: "2026-09-15" }, null, { kind: "entity", input: { id: "other", kind: "person", label: "Other", ...review } });
    expect(() => rebuildIdentities([first, stale])).toThrow(/revision conflict/);
    expect(() => rebuildIdentities([{ ...first, author: { kind: "agent", id: "admin" } }])).toThrow(/envelope/);
    expect(() => rebuildIdentities([{ ...first, capture: { ...first.capture, scope: { workspace: "other" } } }])).toThrow(/envelope/);
    expect(() => rebuildIdentities([{ ...first, kind: "identity.forged" }])).toThrow(/reserved for reviewed identity records/);
  });
});
