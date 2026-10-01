import { describe, expect, it } from "vitest";
import { identityRevisionEventId, makeIdentityEvent, makeTranscriptProjectEvent } from "@_89/fold-transcript";
import { FoldSdk } from "../src/index.js";
import { access, event, MEMORY_A, MEMORY_B, MemoryStore, memoryContext, stamp } from "./helpers.js";
const admin = { access: access({ workspaceRole: "owner" }), author: { kind: "human" as const, id: "user-a" } };
const review = { reason: "Reviewed original records", evidenceEventIds: [], active: true };
const alias = { aliasProjectId: "local", canonicalProjectId: "remote", ...review };
async function seed(sdk: FoldSdk) {
  for (const [index, id] of ["local", "remote"].entries()) await sdk.append(admin.access,
    makeTranscriptProjectEvent({ author: { kind: "ingest", id: "test" }, capture: { scope: { workspace: "workspace-1" }, identity: { source: "codex" } } }, stamp(`project-${id}`, index + 1), { id, name: "Same name", identityKeyHash: String(index).repeat(64), resolution: "resolved", roots: [`/${id}`] }));
}
describe("reviewed identity SDK", () => {
  it("reserves deterministic identity event and subject namespaces before ordinary append", async () => {
    const sdk = new FoldSdk(new MemoryStore());
    const reservedId = identityRevisionEventId("workspace-1", null);
    await expect(sdk.append(admin.access, event({ id: reservedId, t: 1 }))).rejects.toThrow(/reserved/);
    await expect(sdk.append(admin.access, event({ id: "normal", t: 2, subject: `urn:fold:${reservedId}` }))).rejects.toThrow(/reserved/);
    await expect(sdk.recordMemory(memoryContext(), stamp(reservedId, 3), { id: MEMORY_A, source: "test" })).rejects.toThrow(/reserved/);
    await expect(sdk.reviseIdentity(admin, null, { kind: "entity", input: { id: "person", kind: "person", label: "Person", ...review } })).resolves.toMatchObject({ revision: reservedId });
  });

  it("previews requester-visible records and applies/revokes alias-aware recall without rewriting memories", async () => {
    const store = new MemoryStore(); const sdk = new FoldSdk(store); await seed(sdk);
    await sdk.recordMemory(memoryContext({ audience: "workspace" }), stamp("memory-a", 10), { id: MEMORY_A, audience: "workspace", source: "test", applicability: "project", projectIds: ["local"] });
    await sdk.recordMemory(memoryContext({ principalId: "user-b" }), stamp("private", 11), { id: MEMORY_B, source: "test", projectIds: ["local"] });
    const preview = await sdk.previewProjectAlias(admin.access, alias);
    expect(preview.affected).toMatchObject({ memories: 1, candidates: 0, projectIds: ["local", "remote"] });
    const result = await sdk.reviseIdentity(admin, preview.revision, { kind: "project-alias", input: alias }, preview.previewToken);
    expect((await sdk.recallMemories(admin.access, { projectIds: ["remote"] })).map(({ memory }) => memory.id)).toEqual([MEMORY_A]);
    expect((await sdk.memoryById(admin.access, MEMORY_A))?.projectIds).toEqual(["local"]);
    expect(await sdk.recallMemories(access({ workspaceId: "other" }), { projectIds: ["remote"] })).toEqual([]);
    expect(await sdk.reviseIdentity(admin, null, { kind: "project-alias", input: alias }, preview.previewToken)).toMatchObject({ event: { id: result.event.id } });
    const revoke = { ...alias, active: false }; const next = await sdk.previewProjectAlias(admin.access, revoke);
    await sdk.reviseIdentity(admin, next.revision, { kind: "project-alias", input: revoke }, next.previewToken);
    expect(await sdk.recallMemories(admin.access, { projectIds: ["remote"] })).toEqual([]);
    expect((await sdk.identities(admin.access)).history).toHaveLength(2);
    expect(store.entries.filter(({ event }) => event.kind === "memory.recorded")).toHaveLength(2);
  });
  it("rejects stale preview, generic identity ingress, restricted evidence and non-admin mutation", async () => {
    const sdk = new FoldSdk(new MemoryStore()); await seed(sdk);
    const preview = await sdk.previewProjectAlias(admin.access, alias);
    await sdk.recordMemory(memoryContext({ audience: "workspace" }), stamp("new-memory", 10), { id: MEMORY_A, audience: "workspace", source: "test", projectIds: ["local"] });
    await expect(sdk.reviseIdentity(admin, null, { kind: "project-alias", input: alias }, preview.previewToken)).rejects.toThrow(/preview changed/);
    const entity = { id: "person", kind: "person" as const, label: "Andrew", ...review };
    await expect(sdk.reviseIdentity({ ...admin, access: access() }, null, { kind: "entity", input: entity })).rejects.toThrow(/administrator/);
    const forged = makeIdentityEvent({ workspaceId: "workspace-1", principalId: "user-a", author: admin.author }, stamp("ignored", 20), null, { kind: "entity", input: entity });
    await expect(sdk.append(admin.access, forged)).rejects.toThrow(/reviewed identity/);
    await sdk.append(admin.access, event({ id: "private-source", t: 30, creatorId: "user-a" }));
    await expect(sdk.reviseIdentity(admin, null, { kind: "entity", input: { ...entity, evidenceEventIds: ["private-source"] } })).rejects.toThrow(/whole workspace/);
    expect((await sdk.previewProjectAlias(admin.access, { ...alias, canonicalProjectId: "unknown" })).conflicts).not.toEqual([]);
  });
  it("does not publish restricted project identities through workspace aliases", async () => {
    const sdk = new FoldSdk(new MemoryStore()); await seed(sdk);
    const scoped = { ...admin.access, spaceRoles: { secret: "reader" as const } };
    await sdk.append(scoped, makeTranscriptProjectEvent({ author: { kind: "ingest", id: "test" }, capture: { scope: { workspace: "workspace-1", space: "secret" }, identity: { source: "codex" } } }, stamp("restricted-project", 10), { id: "secret-project", name: "Secret", identityKeyHash: "a".repeat(64), resolution: "resolved", roots: ["/secret"] }));
    const input = { ...alias, aliasProjectId: "secret-project" };
    const preview = await sdk.previewProjectAlias(scoped, input);
    expect(preview.conflicts).toContain("Alias endpoints must be visible to the whole workspace");
    await expect(sdk.reviseIdentity({ ...admin, access: scoped }, preview.revision, { kind: "project-alias", input }, preview.previewToken)).rejects.toThrow(/whole workspace/);
    expect((await sdk.identities(admin.access)).projects.map(({ id }) => id)).not.toContain("secret-project");
  });
});
