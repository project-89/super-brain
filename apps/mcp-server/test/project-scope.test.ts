import { describe, expect, it, vi } from "vitest";
import { configuredProjectIds, resolveRetrievalScope } from "../src/project-scope.js";

const workspaceId = "workspace-a";
const page = (ids: readonly string[], nextCursor?: string) => ({ items: ids.map((id) => ({ id })), scope: { workspaceId }, ...(nextCursor === undefined ? {} : { nextCursor }) });

describe("MCP project context boundary", () => {
  it("requires valid explicit configuration instead of guessing project names or roots", () => {
    expect(configuredProjectIds(undefined)).toBeUndefined();
    expect(configuredProjectIds('["project-a", "project-a", " project-b "]')).toEqual(["project-a", "project-b"]);
    for (const input of ["", "project-a", "[]", '[""]', "{}", "[123]", JSON.stringify(Array.from({ length: 21 }, (_, index) => `p-${index}`))]) expect(() => configuredProjectIds(input)).toThrow("SUPER_BRAIN_PROJECT_IDS");
  });
  it("fails missing or empty project context before querying any catalog", async () => {
    const loadProjectPage = vi.fn();
    await expect(resolveRetrievalScope({}, { workspaceId, loadProjectPage })).rejects.toThrow("Project context is required");
    await expect(resolveRetrievalScope({ projectIds: [] }, { workspaceId, loadProjectPage })).rejects.toThrow();
    expect(loadProjectPage).not.toHaveBeenCalled();
  });
  it("verifies all requested IDs across pages and preserves explicit originals", async () => {
    const loadProjectPage = vi.fn().mockResolvedValueOnce(page(["project-a"], "next")).mockResolvedValueOnce(page(["project-b"]));
    expect(await resolveRetrievalScope({ projectIds: ["project-a", "project-b"] }, { workspaceId, loadProjectPage })).toEqual({ kind: "project", source: "explicit", projectIds: ["project-a", "project-b"] });
    expect(loadProjectPage.mock.calls).toEqual([[undefined], ["next"]]);
  });
  it("checks configured defaults every call and stops when IDs become unavailable", async () => {
    const loadProjectPage = vi.fn().mockResolvedValueOnce(page(["project-a"])).mockResolvedValueOnce(page([]));
    const options = { workspaceId, defaultProjectIds: ["project-a"], loadProjectPage };
    expect(await resolveRetrievalScope({}, options)).toEqual({ kind: "project", source: "configured", projectIds: ["project-a"] });
    await expect(resolveRetrievalScope({}, options)).rejects.toThrow("unavailable");
    expect(loadProjectPage).toHaveBeenCalledTimes(2);
  });
  it("allows deliberate broader discovery to override defaults but rejects ambiguous explicit modes", async () => {
    const loadProjectPage = vi.fn();
    expect(await resolveRetrievalScope({ broaderDiscovery: true }, { workspaceId, defaultProjectIds: ["project-a"], loadProjectPage })).toEqual({ kind: "broader-discovery", source: "explicit" });
    await expect(resolveRetrievalScope({ broaderDiscovery: true, projectIds: ["project-a"] }, { workspaceId, loadProjectPage })).rejects.toThrow("not both");
    expect(loadProjectPage).not.toHaveBeenCalled();
  });
  it("fails closed for unavailable projects, denied catalog access, and mismatched scope", async () => {
    await expect(resolveRetrievalScope({ projectIds: ["unknown"] }, { workspaceId, loadProjectPage: async () => page(["visible"]) })).rejects.toThrow("unavailable");
    const denied = new Error("403 denied");
    await expect(resolveRetrievalScope({ projectIds: ["unknown"] }, { workspaceId, loadProjectPage: async () => { throw denied; } })).rejects.toBe(denied);
    await expect(resolveRetrievalScope({ projectIds: ["project-a"] }, { workspaceId, loadProjectPage: async () => ({ ...page(["project-a"]), scope: { workspaceId: "other-workspace" } }) })).rejects.toThrow("invalid workspace");
  });
  it("rejects repeated or empty cursors instead of accepting a partial catalog", async () => {
    const loadProjectPage = vi.fn().mockResolvedValue(page([], "repeat"));
    await expect(resolveRetrievalScope({ projectIds: ["project-a"] }, { workspaceId, loadProjectPage })).rejects.toThrow("invalid cursor");
    expect(loadProjectPage).toHaveBeenCalledTimes(2);
    await expect(resolveRetrievalScope({ projectIds: ["project-a"] }, { workspaceId, loadProjectPage: async () => page([], "") })).rejects.toThrow("invalid cursor");
  });
});
