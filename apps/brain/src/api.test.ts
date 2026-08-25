import { afterEach, describe, expect, it, vi } from "vitest";

import { FoldApiClient } from "./api";
import type { TrajectoryImportBundle, TrajectoryTaskSummary } from "./types";

const client = new FoldApiClient({
  baseUrl: "/api",
  workspaceId: "workspace/one",
  token: "secret-token",
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const trajectoryBundle: TrajectoryImportBundle = {
  spaceId: "space-a",
  tree: {
    taskId: "task/one",
    rootNodeId: "start",
    nodes: [
      { id: "start", kind: "observation", label: "Start" },
      { id: "done", kind: "outcome", label: "Done" },
    ],
    edges: [{ id: "finish", sourceId: "start", targetId: "done", label: "finish" }],
  },
  trajectories: [{
    id: "run-a",
    taskId: "task/one",
    model: { id: "model-a" },
    outcome: "success",
    steps: [
      { id: "step-a", stepNumber: 1, role: "decision", content: "Start" },
      { id: "step-b", stepNumber: 2, role: "model_output", content: "Done" },
    ],
    assignments: {
      "step-a": { kind: "mapped", nodeId: "start", method: { kind: "manual", id: "review" } },
      "step-b": { kind: "mapped", nodeId: "done", method: { kind: "manual", id: "review" } },
    },
  }],
};

describe("Fold API client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("encodes workspace and repeated event filters with bearer auth", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ entries: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await client.listEvents({ includeDrafts: true, kinds: ["memory.recorded", "agent status"] });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "/api/v1/workspaces/workspace%2Fone/events?include=canon%2Bdraft&kind=memory.recorded&kind=agent+status",
    );
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer secret-token");
  });

  it("forms a server-scoped personal-memory create request", async () => {
    const memory = { id: "memory-id" };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ memory }, 201));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      client.createMemory({
        source: "conversation",
        summary: "Decision",
        content: { decision: "Ship the client" },
        tags: ["decision"],
        spaceId: "space-a",
      }),
    ).resolves.toEqual(memory);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      stamp: { id: expect.any(String), t: expect.any(Number), worldDate: expect.any(String) },
      input: {
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        source: "conversation",
        summary: "Decision",
        content: { decision: "Ship the client" },
        tags: ["decision"],
        spaceId: "space-a",
      },
    });
    expect(body).not.toHaveProperty("input.creatorId");
    expect(body).not.toHaveProperty("input.workspaceId");
  });

  it("loads reports with encoded task ids and imports server-scoped bundles", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ report: { taskId: "task/one" } }))
      .mockResolvedValueOnce(jsonResponse({}, 201))
      .mockResolvedValueOnce(jsonResponse({}, 201));
    vi.stubGlobal("fetch", fetchMock);

    await expect(client.trajectoryReport("task/one")).resolves.toMatchObject({ taskId: "task/one" });
    await expect(client.importTrajectoryBundle(trajectoryBundle, [])).resolves.toBe(1);

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/v1/workspaces/workspace%2Fone/trajectory-tasks/task%2Fone",
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "/api/v1/workspaces/workspace%2Fone/trajectory-tasks",
    );
    expect(fetchMock.mock.calls[2]?.[0]).toBe(
      "/api/v1/workspaces/workspace%2Fone/trajectories",
    );
    const treeBody = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body));
    const runBody = JSON.parse(String((fetchMock.mock.calls[2]?.[1] as RequestInit).body));
    expect(treeBody).toMatchObject({ spaceId: "space-a", tree: { taskId: "task/one" } });
    expect(runBody).toMatchObject({ spaceId: "space-a", input: { id: "run-a" } });
    expect(treeBody).not.toHaveProperty("capture");
    expect(runBody).not.toHaveProperty("capture");
  });

  it("rejects a conflicting local task tree before writing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const existing: TrajectoryTaskSummary = {
      taskId: trajectoryBundle.tree.taskId,
      tree: { ...trajectoryBundle.tree, rootNodeId: "done" },
      trajectoryCount: 0,
      successCount: 0,
      failureCount: 0,
      lastRecordedAt: 1,
    };

    await expect(client.importTrajectoryBundle(trajectoryBundle, [existing])).rejects.toMatchObject({
      status: 409,
      code: "trajectory_tree_mismatch",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("loads fleet state and emits a complete local simulation sequence", async () => {
    const fleet = {
      fleet: { rebuiltAt: "2026-08-20T12:00:00.000Z", sessions: [], recoveryActions: [] },
      simulationEnabled: true,
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(fleet))
      .mockResolvedValue(jsonResponse({}, 201));
    vi.stubGlobal("fetch", fetchMock);

    await expect(client.fleet()).resolves.toEqual(fleet);
    const sessionId = await client.simulateFleetScenario({
      scenario: "active",
      agentId: "sim-agent",
      taskId: "task-a",
      repo: "super-brain",
      branch: "main",
      spaceId: "space-a",
    });

    expect(sessionId).toMatch(/^sim-[0-9a-f-]{36}$/);
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/workspaces/workspace%2Fone/fleet");
    const simulationCalls = fetchMock.mock.calls.slice(1) as [string, RequestInit][];
    expect(simulationCalls.map(([url]) => url)).toEqual(
      Array.from({ length: 5 }, () => "/api/v1/workspaces/workspace%2Fone/activity-signals"),
    );
    const bodies = simulationCalls.map(([, init]) => JSON.parse(String(init.body)));
    expect(bodies.map(({ signal }) => signal.type)).toEqual([
      "session_started",
      "session_ready",
      "heartbeat",
      "tool_running",
      "heartbeat",
    ]);
    expect(bodies.every((body) => body.identity.session === sessionId)).toBe(true);
    expect(bodies[0]).toMatchObject({
      spaceId: "space-a",
      heartbeatWindowMs: 60_000,
      identity: { agent: "sim-agent", task: "task-a", runtime: "simulation" },
      stamp: { id: expect.any(String), t: expect.any(Number), observedAt: expect.any(String) },
    });
    expect(bodies[0]).not.toHaveProperty("sensor");
    expect(bodies[0]).not.toHaveProperty("capture");
  });

  it("maps stable API errors and network failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({ error: { code: "workspace_access_denied", message: "Workspace access denied" } }, 403),
      ),
    );
    await expect(client.projection()).rejects.toMatchObject({
      status: 403,
      code: "workspace_access_denied",
      message: "Workspace access denied",
    });

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(client.projection()).rejects.toMatchObject({
      status: 0,
      code: "network_error",
    });
  });
});
