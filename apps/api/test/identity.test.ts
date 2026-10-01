import { describe, expect, it } from "vitest";
import { makeIdentityEvent, makeTranscriptProjectEvent } from "@_89/fold-transcript";
import { apiRequest, MemorySdkRegistry, startApi } from "./helpers.js";
const path = "/v1/workspaces/workspace-1";
const review = { reason: "Reviewed source records", active: true, evidenceEventIds: [] };
describe("identity administration HTTP", () => {
  it("paginates separate identities, reviews attribution revisions, rejects members and generic ingress", async () => {
    const api = await startApi();
    const request = (suffix: string, body?: unknown, token = "token-b") => apiRequest(api.baseUrl, path + suffix, { method: body === undefined ? "GET" : "POST", token, ...(body === undefined ? {} : { body }) });
    try {
      const person = { id: "andrew", kind: "person", label: "Andrew", ...review };
      expect((await request("/identities/entities", { expectedRevision: null, input: person }, "token-a")).status).toBe(403);
      const created = await request("/identities/entities", { expectedRevision: null, input: person });
      expect(created.status).toBe(201); let revision = created.body.revision;
      expect((await request("/identities/entities", { expectedRevision: null, input: { ...person, id: "jake" } })).status).toBe(409);
      const account = await request("/identities/entities", { expectedRevision: revision, input: { id: "andrew-account", kind: "account", label: "Andrew coding account", source: { provider: "codex", externalId: "123" }, ...review } });
      expect(account.status).toBe(201); revision = account.body.revision;
      const attributed = await request("/identities/attributions", { expectedRevision: revision, input: { entityId: "andrew-account", personId: "andrew", ...review } });
      expect(attributed.status).toBe(201); revision = attributed.body.revision;
      const page = await request("/identities/entities?limit=1");
      expect(page.body).toMatchObject({ total: 2, items: [{ id: "andrew-account" }], canManage: true });
      const next = await request(`/identities/entities?limit=1&pageCursor=${encodeURIComponent(page.body.nextCursor)}`);
      expect(next.body.items.map((item: any) => item.id)).toEqual(["andrew"]);
      const people = await request("/identities/entities?kind=person&active=true", undefined, "token-a");
      expect(people.body).toMatchObject({ total: 1, canManage: false, items: [{ label: "Andrew" }] });
      expect((await request("/identities/attributions")).body.items[0]).toMatchObject({ entityLabel: "Andrew coding account", personLabel: "Andrew" });
      expect((await request("/identities/attributions", { expectedRevision: revision, input: { entityId: "andrew-account", personId: "andrew", ...review, active: false } })).status).toBe(201);
      expect((await request("/identities/history")).body.total).toBe(4);
      const forged = makeIdentityEvent({ workspaceId: "workspace-1", principalId: "user-a", author: { kind: "human", id: "user-a" } }, { t: Date.now(), worldDate: "2026-09-15" }, null, { kind: "entity", input: { ...person, kind: "person" } });
      expect((await request("/events", { event: forged }, "token-a")).status).toBe(400);
      const snapshot = await request("/identities");
      expect(snapshot.body.counts).toEqual({ entities: 2, attributions: 1, aliases: 0, projects: 0 });
    } finally { await api.close(); }
  });
  it("requires a current authorized preview for alias decisions and preserves original records", async () => {
    const registry = new MemorySdkRegistry(); const sdk = await registry.sdkFor({ organizationId: "local", workspaceId: "workspace-1" });
    const access = { organizationId: "local", workspaceId: "workspace-1", principalId: "user-b", workspaceRole: "owner" as const, spaceRoles: {} };
    for (const [index, id] of ["local", "remote"].entries()) await sdk.append(access, makeTranscriptProjectEvent({ author: { kind: "ingest", id: "seed" }, capture: { scope: { workspace: "workspace-1" }, identity: { source: "codex" } } }, { id: `project-${id}`, t: index + 1, worldDate: "2026-09-15" }, { id, name: id === "local" ? "Local checkout" : "Remote repository", roots: [`/${id}`], identityKeyHash: String(index).repeat(64), resolution: "resolved" }));
    const api = await startApi({ sdks: registry });
    const request = (suffix: string, body?: unknown) => apiRequest(api.baseUrl, path + suffix, { method: body === undefined ? "GET" : "POST", token: "token-b", ...(body === undefined ? {} : { body }) });
    const input = { aliasProjectId: "local", canonicalProjectId: "remote", ...review };
    try {
      const preview = await request("/identities/alias-preview", { input });
      expect(preview.body).toMatchObject({ revision: null, conflicts: [], affected: { projectIds: ["local", "remote"], runs: 0, memories: 0, candidates: 0 }, scope: { workspaceId: "workspace-1" } });
      expect((await request("/identities/aliases", { expectedRevision: null, previewToken: "0".repeat(64), input })).status).toBe(409);
      const applied = await request("/identities/aliases", { expectedRevision: null, previewToken: preview.body.previewToken, input });
      expect(applied.status).toBe(201);
      expect((await request("/identities/aliases")).body.items[0]).toMatchObject({ aliasProjectName: "Local checkout", canonicalProjectName: "Remote repository" });
      expect((await request("/identities/projects?limit=1")).body).toMatchObject({ total: 2, items: [{ id: "local", canonicalProjectId: "remote" }] });
      const reverse = await request("/identities/alias-preview", { input: { ...input, aliasProjectId: "remote", canonicalProjectId: "local" } });
      expect(reverse.body.conflicts).toContain("Project alias cycle");
      const entry = await apiRequest(api.baseUrl, `${path}/events/${encodeURIComponent(applied.body.event.id)}`, { token: "token-a" });
      expect(entry).toMatchObject({ status: 200, body: { entry: { status: "canon", event: { id: applied.body.event.id } } } });
      expect((await apiRequest(api.baseUrl, `${path}/events/missing`, { token: "token-a" })).status).toBe(404);
    } finally { await api.close(); }
  });
});
