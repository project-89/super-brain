import { afterEach, describe, expect, it, vi } from "vitest";

import { FoldApiClient } from "./api";
import type { TrajectoryImportBundle, TrajectoryTaskSummary } from "./types";

const client = new FoldApiClient({
  baseUrl: "/api",
  organizationId: "organization/one",
  workspaceId: "workspace/one",
  token: "secret-token",
  captureBaseUrl: "/capture",
  captureOperatorToken: "capture-secret",
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

    await client.listEvents({
      includeDrafts: true,
      kinds: ["memory.recorded", "agent status"],
      limit: 200,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "/api/v1/organizations/organization%2Fone/workspaces/workspace%2Fone/events?order=desc&include=canon%2Bdraft&kind=memory.recorded&kind=agent+status&limit=200",
    );
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer secret-token");
  });

  it("requests a paged projection section for the state inspector", async () => {
    const response = {
      entries: [],
      state: {
        values: [], nodes: [], edges: [], redirects: [], diagnostics: [],
        appliedEvents: [], appliedChanges: [], appliedEventCount: 0, appliedChangeCount: 0,
      },
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(response));
    vi.stubGlobal("fetch", fetchMock);

    await client.projection(true);

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/v1/organizations/organization%2Fone/workspaces/workspace%2Fone/projection?compact=true&section=nodes&limit=100&include=canon%2Bdraft",
    );
  });

  it("forms a server-scoped personal-memory create request", async () => {
    const memory = { id: "memory-id" };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ memory }, 201));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      client.createMemory({
        audience: "personal",
        projectIds: ["project-a"],
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

  it("submits ranked recall filters without client-authored candidates", async () => {
    const result = {
      memories: [],
      ranking: { id: "local-bm25-v1", kind: "lexical", corpusSize: 3 },
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(result));
    vi.stubGlobal("fetch", fetchMock);

    await expect(client.rankMemories({
      query: "refresh token",
      scope: { kind: "space", spaceId: "space/a" },
      sources: ["conversation"],
      limit: 25,
    })).resolves.toEqual(result);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/organizations/organization%2Fone/workspaces/workspace%2Fone/memories/search");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      query: "refresh token",
      scope: { kind: "space", spaceId: "space/a" },
      sources: ["conversation"],
      limit: 25,
    });
    expect(String(init.body)).not.toContain("candidates");
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
      "/api/v1/organizations/organization%2Fone/workspaces/workspace%2Fone/trajectory-tasks/task%2Fone?",
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "/api/v1/organizations/organization%2Fone/workspaces/workspace%2Fone/trajectory-tasks",
    );
    expect(fetchMock.mock.calls[2]?.[0]).toBe(
      "/api/v1/organizations/organization%2Fone/workspaces/workspace%2Fone/trajectories",
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
      unknownCount: 0,
      lastRecordedAt: 1,
    };

    await expect(client.importTrajectoryBundle(trajectoryBundle, [existing])).rejects.toMatchObject({
      status: 409,
      code: "trajectory_tree_mismatch",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("loads real fleet state and encoded transcript history queries", async () => {
    const fleet = {
      fleet: { rebuiltAt: "2026-08-20T12:00:00.000Z", sessions: [], recoveryActions: [] },
    };
    const projects = [{ project: { id: "project/a", name: "Project A" }, runCount: 1 }];
    const runs = [{ id: "codex:run/a", source: "codex", nativeId: "run/a" }];
    const detail = { run: runs[0], artifact: { id: "artifact-a" }, projects: [], chunks: [] };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(fleet))
      .mockResolvedValueOnce(jsonResponse({ projects }))
      .mockResolvedValueOnce(jsonResponse({ runs }))
      .mockResolvedValueOnce(jsonResponse(detail));
    vi.stubGlobal("fetch", fetchMock);

    await expect(client.fleet()).resolves.toEqual(fleet);
    await expect(client.listTranscriptProjects()).resolves.toEqual(projects);
    await expect(client.listTranscriptRuns({ projectId: "project/a", source: "codex" })).resolves.toEqual(runs);
    await expect(client.transcriptRun("codex:run/a")).resolves.toEqual(detail);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/organizations/organization%2Fone/workspaces/workspace%2Fone/fleet");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/v1/organizations/organization%2Fone/workspaces/workspace%2Fone/transcript-projects");
    expect(fetchMock.mock.calls[2]?.[0]).toBe(
      "/api/v1/organizations/organization%2Fone/workspaces/workspace%2Fone/transcript-runs?projectId=project%2Fa&source=codex",
    );
    expect(fetchMock.mock.calls[3]?.[0]).toBe(
      "/api/v1/organizations/organization%2Fone/workspaces/workspace%2Fone/transcript-runs/codex%3Arun%2Fa",
    );
  });

  it("loads steering and emits server-authored lifecycle commands", async () => {
    const steering = { actors: [], steeringEnabled: true };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(steering))
      .mockImplementation(async () => jsonResponse({}, 201));
    vi.stubGlobal("fetch", fetchMock);

    await expect(client.steering()).resolves.toEqual(steering);
    await client.surfaceSteeringCandidate({
      actorId: "agent/one",
      sourceDriveId: "delivery",
      satisfierKind: "task",
      satisfierRef: "verify-release",
      aim: "Verify the release",
      trigger: { kind: "coincidence", note: "trajectory divergence" },
    });
    await client.commitSteeringCandidate("agent/one", "candidate-a");
    await client.recordSteeringAction("agent/one", "intention-a");
    await client.endSteeringIntention("agent/one", "intention-a", { kind: "satisfied" });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/organizations/organization%2Fone/workspaces/workspace%2Fone/steering");
    const mutations = fetchMock.mock.calls.slice(1) as [string, RequestInit][];
    expect(mutations.every(([url]) => url === "/api/v1/organizations/organization%2Fone/workspaces/workspace%2Fone/steering/agent%2Fone")).toBe(true);
    const bodies = mutations.map(([, init]) => JSON.parse(String(init.body)));
    expect(bodies.map(({ action }) => action)).toEqual(["surface", "commit", "acted", "end"]);
    expect(bodies[0]).toMatchObject({
      stamp: { id: expect.any(String), t: expect.any(Number) },
      candidate: {
        id: expect.stringMatching(/^candidate-[0-9a-f-]{36}$/),
        sourceDriveId: "delivery",
        satisfier: { kind: "task", ref: "verify-release" },
        aim: "Verify the release",
        trigger: { kind: "coincidence", note: "trajectory divergence" },
      },
    });
    expect(bodies[0]).not.toHaveProperty("author");
    expect(bodies[1].intentionId).toMatch(/^intention-[0-9a-f-]{36}$/);
  });

  it("asks for provider-labeled reasoning without writing an event", async () => {
    const result = {
      answer: "Relevant evidence: Rotate the token.",
      citations: ["memory-a"],
      provider: { id: "local-evidence-v1", kind: "extractive" },
      ranking: { id: "local-bm25-v1", kind: "lexical", corpusSize: 1 },
      evidence: [{ memoryId: "memory-a", source: "conversation", summary: "Rotate the token", score: 1 }],
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(result));
    vi.stubGlobal("fetch", fetchMock);

    await expect(client.askReasoning("How did refresh recover?", "agent-a")).resolves.toEqual(result);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/organizations/organization%2Fone/workspaces/workspace%2Fone/reasoning/ask");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      question: "How did refresh recover?",
      actorId: "agent-a",
      limit: 5,
    });
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

describe("canonical adapter guarantees", () => {
  afterEach(() => vi.unstubAllGlobals());
  const settings = { baseUrl: "/api", organizationId: "local", workspaceId: "workspace", token: "stale-token", captureBaseUrl: "/capture", captureOperatorToken: "operator-private" };
  it("obtains the current session token for every request and never attaches operator credentials", async () => {
    let token: string | undefined = "fresh-one";
    const api = new FoldApiClient({ ...settings, tokenSupplier: async () => token });
    const fetchMock = vi.fn(async () => jsonResponse({ memories: [], total: 0 })); vi.stubGlobal("fetch", fetchMock);
    await api.recallMemoryPage({ includeNeedsReview: true }); token = "fresh-two"; await api.recallMemoryPage();
    expect(fetchMock.mock.calls.map((call) => new Headers((call as unknown as [string, RequestInit])[1].headers).get("authorization"))).toEqual(["Bearer fresh-one", "Bearer fresh-two"]);
    expect(fetchMock.mock.calls.every((call) => new Headers((call as unknown as [string, RequestInit])[1].headers).get("x-super-brain-operator-token") === null)).toBe(true);
    token = undefined; await expect(api.recallMemoryPage()).rejects.toMatchObject({ code: "token_unavailable" }); expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("cancels during response body consumption without converting abort into invalid JSON", async () => {
    const abort = new AbortController(); const api = new FoldApiClient(settings, abort.signal);
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"items":')); } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream)));
    const request = api.listEventsPage(); await Promise.resolve(); abort.abort();
    await expect(request).rejects.toMatchObject({ code: "aborted" });
  });
  it("retains the command stamp, UUID and displayed revision across a lost mutation acknowledgement", async () => {
    const api = new FoldApiClient(settings); const bodies: unknown[] = []; let attempts = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => { bodies.push(JSON.parse(String(init.body))); if (attempts++ === 0) throw new TypeError("lost acknowledgement"); return jsonResponse({ memory: { id: "memory" } }); }));
    const draft = { audience: "workspace" as const, projectIds: [], source: "review", summary: "Correction", content: "new fact", tags: [], applicability: { kind: "global" as const }, expectedRevision: 0 };
    await expect(api.reviseMemory("memory", draft)).rejects.toMatchObject({ code: "network_error" }); await api.reviseMemory("memory", draft);
    expect(bodies[1]).toEqual(bodies[0]); expect(bodies[0]).toMatchObject({ expectedRevision: 0, patch: { content: "new fact", applicability: { kind: "global" } } });
    attempts = 0; bodies.length = 0; await expect(api.createMemory(draft)).rejects.toMatchObject({ code: "network_error" }); await api.createMemory(draft); expect(bodies[1]).toEqual(bodies[0]); expect(bodies[0]).toMatchObject({ input: { id: expect.stringMatching(/^[0-9a-f-]{36}$/) } });
  });
  it("records judgment against the exact presented revision and ranking identity", async () => {
    const api = new FoldApiClient(settings);
    const provenance = { version: 1, recallId: "recall-stable", subject: { organizationId: "local", workspaceId: "workspace", principalId: "person" }, observedAt: new Date().toISOString(), operation: "search", ranking: { id: "lexical", kind: "lexical" }, items: [{ memoryId: "memory", memoryRevision: 0, rank: 1 }] };
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ memories: [], ranking: { id: "lexical", kind: "lexical", corpusSize: 1 }, provenance })).mockResolvedValueOnce(jsonResponse({})); vi.stubGlobal("fetch", fetchMock);
    const read = await api.rankMemories({ query: "test" }); await api.recordMemoryFeedback({ id: "memory", revision: 0 }, "helpful", read.provenance);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1].body))).toMatchObject({ expectedSubject: provenance.subject, items: [{ memoryId: "memory", input: { version: 2, memoryRevision: 0, recallId: "recall-stable", signal: "judged", judgment: "helpful", rank: 1 } }] });
  });
});

it("can open connection settings before credentials exist without creating a transport with a stale token", async () => {
  const api = new FoldApiClient({ baseUrl: "/api", organizationId: "local", workspaceId: "workspace", token: "", captureBaseUrl: "/capture", captureOperatorToken: "" });
  await expect(api.identity()).rejects.toMatchObject({ code: "token_unavailable" });
});
