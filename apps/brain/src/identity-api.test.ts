import { afterEach, describe, expect, it, vi } from "vitest";
import { FoldApiClient } from "./api";
import type { ProjectAliasInput, ProjectAliasPreview } from "./identity-types";

const client = new FoldApiClient({ baseUrl: "/api", organizationId: "org/one", workspaceId: "workspace/one", token: "private-token", captureBaseUrl: "/capture", captureOperatorToken: "" });
const scope = { workspaceId: "workspace/one", visibility: "workspace" as const };
const input: ProjectAliasInput = { aliasProjectId: "project/old", canonicalProjectId: "project/new", active: true, reason: "Reviewed repository and run evidence", evidenceEventIds: ["event-one"] };
const preview: ProjectAliasPreview = { revision: "revision-one", previewToken: "bound-preview", scope, conflicts: [], affected: { projectIds: ["project/old", "project/new"], runs: 3, memories: 4, candidates: 5 }, beforeCanonicalProjectId: "project/old", afterCanonicalProjectId: "project/new" };

describe("identity administration API client", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("pages authorized identity lists and preserves server permission/scope metadata", async () => {
    const page = { items: [], total: 101, nextCursor: "next", revision: "revision-one", scope, canManage: false };
    const fetchMock = vi.fn().mockResolvedValue(Response.json(page));
    vi.stubGlobal("fetch", fetchMock);
    expect(await client.identityEntities({ kind: "person", active: true, cursor: "cursor+one" })).toEqual(page);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/organizations/org%2Fone/workspaces/workspace%2Fone/identities/entities?limit=100&pageCursor=cursor%2Bone&kind=person&active=true");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer private-token");
    expect(init.method ?? "GET").toBe("GET");
  });
  it("uses separate paginated endpoints for aliases, attributions, projects, and history", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => Response.json({ items: [], total: 0, revision: null, scope, canManage: true }));
    vi.stubGlobal("fetch", fetchMock);
    await client.projectAliases({ cursor: "next", active: false });
    await client.identityAttributions({ cursor: "next", active: true });
    await client.identityProjects("next");
    await client.identityHistory("next");
    expect(fetchMock.mock.calls.map((call) => String(call[0]).split("/identities/")[1])).toEqual([
      "aliases?limit=100&pageCursor=next&active=false", "attributions?limit=100&pageCursor=next&active=true",
      "projects?limit=100&pageCursor=next", "history?limit=100&pageCursor=next",
    ]);
  });
  it("does not apply during preview and submits the exact reviewed revision/token/input on apply", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json(preview)).mockResolvedValueOnce(Response.json({ revision: "revision-two" }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await client.previewProjectAlias(input)).toEqual(preview);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toContain("/identities/alias-preview");
    expect(JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string)).toEqual({ input });
    await client.saveProjectAlias(input, preview);
    expect(fetchMock.mock.calls[1]?.[0]).toContain("/identities/aliases");
    expect(JSON.parse((fetchMock.mock.calls[1]?.[1] as RequestInit).body as string)).toEqual({ expectedRevision: "revision-one", previewToken: "bound-preview", input });
  });
  it("preserves revocation targets and review evidence for append-only writes", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => Response.json({ revision: "new" }));
    vi.stubGlobal("fetch", fetchMock);
    const entity = { id: "person-one", kind: "person" as const, label: "Andrew", active: true, reason: "Operator verified", evidenceEventIds: [] };
    const attribution = { entityId: "source-one", personId: "person-one", active: false, reason: "Source reassigned", evidenceEventIds: ["event-two"] };
    await client.saveIdentityEntity(entity, null);
    await client.saveIdentityAttribution(attribution, "old");
    await client.saveProjectAlias({ ...input, active: false }, preview);
    expect(fetchMock.mock.calls.map((call) => JSON.parse((call[1] as RequestInit).body as string))).toEqual([
      { expectedRevision: null, input: entity }, { expectedRevision: "old", input: attribution },
      { expectedRevision: "revision-one", previewToken: "bound-preview", input: { ...input, active: false } },
    ]);
  });
  it("surfaces denied access and stale previews instead of reporting success", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ error: { code: "forbidden", message: "Administrator access required" } }, { status: 403 }))
      .mockResolvedValueOnce(Response.json({ error: { code: "identity_revision_conflict", message: "Identity state changed; preview again" } }, { status: 409 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(client.identityEntities()).rejects.toMatchObject({ status: 403, code: "forbidden" });
    await expect(client.saveProjectAlias(input, preview)).rejects.toMatchObject({ status: 409, code: "identity_revision_conflict" });
  });
});
