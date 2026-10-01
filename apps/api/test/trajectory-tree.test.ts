import { describe, expect, it, vi } from "vitest";
import { apiRequest, MemorySdkRegistry, startApi } from "./helpers.js";

describe("current trajectory tree read", () => {
  it("returns the validated current tree without full report analysis and preserves scope", async () => {
    const registry = new MemorySdkRegistry();
    const sdk = await registry.sdkFor({ organizationId: "local", workspaceId: "workspace-1" });
    const report = vi.spyOn(sdk, "trajectoryReport");
    const api = await startApi({ sdks: registry });
    const root = "/v1/workspaces/workspace-1/trajectory-tasks";
    const tree = { taskId: "task", rootNodeId: "root", nodes: [{ id: "root", kind: "observation", label: "Observed" }], edges: [] };
    try {
      expect((await apiRequest(api.baseUrl, root, { method: "POST", token: "token-a", body: { stamp: { id: "tree", t: 1, worldDate: "2026-09-15" }, spaceId: "space-a", tree } })).status).toBe(201);
      const current = await apiRequest(api.baseUrl, `${root}/task/tree`, { token: "token-a" });
      expect(current).toMatchObject({ status: 200, body: { record: { tree } } });
      expect(current.body).not.toHaveProperty("report");
      expect(report).not.toHaveBeenCalled();
      expect((await apiRequest(api.baseUrl, `${root}/task/tree`, { token: "token-b" })).status).toBe(404);
      expect((await apiRequest(api.baseUrl, `${root}/missing/tree`, { token: "token-a" })).status).toBe(404);
      expect((await apiRequest(api.baseUrl, `${root}/task/tree`, { method: "POST", token: "token-a", body: {} })).status).toBe(405);
      const full = await apiRequest(api.baseUrl, `${root}/task`, { token: "token-a" });
      expect(full.body.report.tree).toEqual(current.body.record.tree);
      const otherSdk = await registry.sdkFor({ organizationId: "other", workspaceId: "workspace-1" });
      expect(await otherSdk.trajectoryTree({ principalId: "user-a", organizationId: "other", workspaceId: "workspace-1", workspaceRole: "member", spaceRoles: { "space-a": "reader" } }, "task")).toBeUndefined();
    } finally { await api.close(); }
  });
});
