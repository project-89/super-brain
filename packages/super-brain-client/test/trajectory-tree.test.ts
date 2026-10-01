import { describe, expect, it, vi } from "vitest";
import { SuperBrainClient } from "../src/index.js";

describe("current trajectory tree client", () => {
  it("requests only the scoped tree route and treats only 404 as absent", async () => {
    const record = { tree: { taskId: "task/a" } };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ record }))
      .mockResolvedValueOnce(Response.json({ error: { code: "trajectory_task_unavailable", message: "Absent" } }, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ error: { code: "access_denied", message: "Denied" } }, { status: 403 }));
    const client = new SuperBrainClient({ baseUrl: "http://test", organizationId: "org", workspaceId: "workspace", token: "fixture", fetch: fetcher });
    expect(await client.trajectoryTree("task/a")).toEqual(record);
    expect(fetcher.mock.calls[0]![0]).toBe("http://test/v1/organizations/org/workspaces/workspace/trajectory-tasks/task%2Fa/tree");
    expect(await client.trajectoryTree("missing")).toBeUndefined();
    await expect(client.trajectoryTree("denied")).rejects.toMatchObject({ status: 403 });
  });
});
