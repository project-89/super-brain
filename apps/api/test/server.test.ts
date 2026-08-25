import type { MembershipResolver } from "../src/index.js";
import type { MemoryRanker } from "@_89/fold-sdk";
import { describe, expect, it } from "vitest";

import {
  MEMORY_A,
  apiEvent,
  apiRequest,
  identityDirectory,
  memoryRecordBody,
  startApi,
} from "./helpers.js";

const trajectoryTree = {
  taskId: "refresh-regression",
  rootNodeId: "observe",
  nodes: [
    { id: "observe", kind: "observation", label: "Observe 401" },
    { id: "expiry", kind: "decision", label: "Diagnose expiry" },
    { id: "network", kind: "decision", label: "Diagnose network" },
    { id: "patch", kind: "action", label: "Patch refresh" },
    { id: "retry", kind: "action", label: "Add retry" },
    { id: "pass", kind: "outcome", label: "Tests pass" },
    { id: "fail", kind: "outcome", label: "Tests fail" },
  ],
  edges: [
    { id: "e-expiry", sourceId: "observe", targetId: "expiry", label: "expiry" },
    { id: "e-network", sourceId: "observe", targetId: "network", label: "network" },
    { id: "e-patch", sourceId: "expiry", targetId: "patch", label: "patch" },
    { id: "e-retry", sourceId: "network", targetId: "retry", label: "retry" },
    { id: "e-pass", sourceId: "patch", targetId: "pass", label: "pass" },
    { id: "e-fail", sourceId: "retry", targetId: "fail", label: "fail" },
  ],
};

const MEMORY_B = "01890f47-7c00-7000-8000-000000000002";

function trajectoryInput(
  id: string,
  modelId: string,
  outcome: "success" | "failure",
  nodeIds: readonly string[],
) {
  const steps = nodeIds.map((nodeId, index) => ({
    id: `${id}-step-${index + 1}`,
    stepNumber: index + 1,
    role: index === nodeIds.length - 1 ? "model_output" : "decision",
    content: `Step at ${nodeId}`,
  }));
  return {
    id,
    taskId: trajectoryTree.taskId,
    model: { id: modelId },
    outcome,
    steps,
    assignments: Object.fromEntries(
      steps.map((step, index) => [
        step.id,
        {
          kind: "mapped",
          nodeId: nodeIds[index],
          method: { kind: "manual", id: "test-review" },
        },
      ]),
    ),
    reviewText: outcome === "success"
      ? "VERDICT: approve\nCONFIDENCE: 0.9"
      : "VERDICT: reject\nCONFIDENCE: 0.2",
  };
}

const fleetEpoch = Date.parse("2026-08-20T12:00:00.000Z");

function activityBody(
  sequence: number,
  offsetMs: number,
  signal: Readonly<Record<string, unknown>>,
) {
  return {
    stamp: {
      id: `fleet-event-${sequence}`,
      t: fleetEpoch + offsetMs,
      observedAt: new Date(fleetEpoch + offsetMs).toISOString(),
    },
    identity: {
      agent: "sim-agent-a",
      task: "api-fleet-test",
      repo: "super-brain",
      branch: "main",
      session: "sim-session-a",
      runtime: "simulation",
    },
    heartbeatWindowMs: 1_000,
    signal,
  };
}

describe("Fold HTTP API", () => {
  it("serves public health and fails closed on authentication and membership", async () => {
    const api = await startApi();
    try {
      expect(await apiRequest(api.baseUrl, "/health")).toMatchObject({
        status: 200,
        body: { status: "ok" },
      });
      const missing = await apiRequest(api.baseUrl, "/v1/workspaces/workspace-1/events");
      expect(missing.status).toBe(401);
      expect(missing.headers.get("www-authenticate")).toBe("Bearer");
      expect(
        (await apiRequest(api.baseUrl, "/v1/workspaces/workspace-1/events", { token: "wrong" }))
          .status,
      ).toBe(401);
      expect(
        (await apiRequest(api.baseUrl, "/v1/workspaces/workspace-2/events", { token: "token-a" }))
          .status,
      ).toBe(403);
    } finally {
      await api.close();
    }
  });

  it("appends, filters, and projects authenticated Fold events", async () => {
    const api = await startApi();
    try {
      const first = await apiRequest(api.baseUrl, "/v1/workspaces/workspace-1/events", {
        method: "POST",
        token: "token-a",
        body: { event: apiEvent({ id: "event-a", t: 1, kind: "alpha", subject: "visible" }) },
      });
      expect(first.status).toBe(201);
      const draft = await apiRequest(api.baseUrl, "/v1/workspaces/workspace-1/events", {
        method: "POST",
        token: "token-a",
        body: {
          event: apiEvent({ id: "event-b", t: 2, kind: "beta", subject: "draft" }),
          status: "draft",
        },
      });
      expect(draft.status).toBe(201);

      const canonical = await apiRequest(api.baseUrl, "/v1/workspaces/workspace-1/events?kind=alpha", {
        token: "token-a",
      });
      expect(canonical.body.entries.map((entry: any) => entry.event.id)).toEqual(["event-a"]);
      const all = await apiRequest(
        api.baseUrl,
        "/v1/workspaces/workspace-1/events?include=canon%2Bdraft",
        { token: "token-a" },
      );
      expect(all.body.entries.map((entry: any) => entry.event.id)).toEqual(["event-a", "event-b"]);

      const projection = await apiRequest(
        api.baseUrl,
        "/v1/workspaces/workspace-1/projection",
        { token: "token-a" },
      );
      expect(projection.status).toBe(200);
      expect(projection.body.state.nodes.map(([id]: [string]) => id)).toEqual(["visible"]);
    } finally {
      await api.close();
    }
  });

  it("binds generic event authorship to the bearer credential", async () => {
    const api = await startApi();
    try {
      const spoofed = await apiRequest(api.baseUrl, "/v1/workspaces/workspace-1/events", {
        method: "POST",
        token: "token-a",
        body: { event: apiEvent({ id: "event-a", t: 1, principalId: "user-b" }) },
      });
      expect(spoofed).toMatchObject({
        status: 403,
        body: { error: { code: "author_mismatch" } },
      });
      const wrongScope = await apiRequest(api.baseUrl, "/v1/workspaces/workspace-1/events", {
        method: "POST",
        token: "token-a",
        body: { event: apiEvent({ id: "event-b", t: 2, workspaceId: "workspace-2" }) },
      });
      expect(wrongScope).toMatchObject({ status: 403, body: { error: { code: "access_denied" } } });
    } finally {
      await api.close();
    }
  });

  it("returns a stable conflict for duplicate events", async () => {
    const api = await startApi();
    try {
      const body = { event: apiEvent({ id: "event-a", t: 1 }) };
      expect(
        (await apiRequest(api.baseUrl, "/v1/workspaces/workspace-1/events", {
          method: "POST",
          token: "token-a",
          body,
        })).status,
      ).toBe(201);
      const duplicate = await apiRequest(api.baseUrl, "/v1/workspaces/workspace-1/events", {
        method: "POST",
        token: "token-a",
        body,
      });
      expect(duplicate).toMatchObject({ status: 409, body: { error: { code: "fold_conflict" } } });
    } finally {
      await api.close();
    }
  });

  it("records, revises, recalls, and forgets memory with server-derived identity", async () => {
    const api = await startApi();
    try {
      const created = await apiRequest(api.baseUrl, "/v1/workspaces/workspace-1/memories", {
        method: "POST",
        token: "token-a",
        body: memoryRecordBody(),
      });
      expect(created).toMatchObject({
        status: 201,
        body: {
          event: {
            author: { kind: "human", id: "user-a" },
            capture: { scope: { workspace: "workspace-1", creator: "user-a" } },
          },
          memory: { id: MEMORY_A, creatorId: "user-a" },
        },
      });

      const revised = await apiRequest(
        api.baseUrl,
        `/v1/workspaces/workspace-1/memories/${MEMORY_A}`,
        {
          method: "PATCH",
          token: "token-a",
          body: {
            stamp: { id: "event-b", t: 110, worldDate: "2026-08-17" },
            patch: { summary: "Reviewed", tags: ["reviewed", "decision"] },
          },
        },
      );
      expect(revised.body.memory).toMatchObject({ summary: "Reviewed", revision: 1 });

      const recalled = await apiRequest(
        api.baseUrl,
        "/v1/workspaces/workspace-1/memories/recall",
        {
          method: "POST",
          token: "token-a",
          body: { tags: ["reviewed"], candidates: [{ memoryId: MEMORY_A, score: 0.8 }] },
        },
      );
      expect(recalled.body.memories).toHaveLength(1);
      expect(recalled.body.memories[0]).toMatchObject({ score: 0.8, memory: { id: MEMORY_A } });

      const forgotten = await apiRequest(
        api.baseUrl,
        `/v1/workspaces/workspace-1/memories/${MEMORY_A}`,
        {
          method: "DELETE",
          token: "token-a",
          body: {
            stamp: { id: "event-c", t: 120, worldDate: "2026-08-17" },
            reason: "user request",
          },
        },
      );
      expect(forgotten.body.forgotten).toMatchObject({ memoryId: MEMORY_A, reason: "user request" });
      expect(
        (await apiRequest(api.baseUrl, `/v1/workspaces/workspace-1/memories/${MEMORY_A}`, {
          token: "token-a",
        })).status,
      ).toBe(404);
    } finally {
      await api.close();
    }
  });

  it("does not reveal another creator's memory through event or memory routes", async () => {
    const api = await startApi();
    try {
      await apiRequest(api.baseUrl, "/v1/workspaces/workspace-1/memories", {
        method: "POST",
        token: "token-a",
        body: memoryRecordBody(),
      });
      const raw = await apiRequest(api.baseUrl, "/v1/workspaces/workspace-1/events", {
        token: "token-b",
      });
      expect(raw.body.entries).toEqual([]);
      const memory = await apiRequest(
        api.baseUrl,
        `/v1/workspaces/workspace-1/memories/${MEMORY_A}`,
        { token: "token-b" },
      );
      expect(memory).toMatchObject({
        status: 404,
        body: { error: { code: "memory_unavailable", message: "Personal memory is unavailable" } },
      });
    } finally {
      await api.close();
    }
  });

  it("ranks an authorized corpus and filters malicious provider candidates", async () => {
    const seen: string[] = [];
    const memoryRanker: MemoryRanker = {
      descriptor: { id: "host-semantic-test", kind: "semantic" },
      async rank({ documents }) {
        seen.push(...documents.map(({ memoryId }) => memoryId));
        return [
          { memoryId: MEMORY_B, score: 0.99 },
          { memoryId: MEMORY_A, score: 0.8 },
        ];
      },
    };
    const api = await startApi({ memoryRanker });
    try {
      await apiRequest(api.baseUrl, "/v1/workspaces/workspace-1/memories", {
        method: "POST",
        token: "token-a",
        body: memoryRecordBody({
          input: { id: MEMORY_A, source: "conversation", summary: "Refresh token" },
        }),
      });
      await apiRequest(api.baseUrl, "/v1/workspaces/workspace-1/memories", {
        method: "POST",
        token: "token-b",
        body: {
          stamp: { id: "event-b", t: 101, worldDate: "2026-08-17" },
          input: { id: MEMORY_B, source: "conversation", summary: "Owner private" },
        },
      });

      const response = await apiRequest(
        api.baseUrl,
        "/v1/workspaces/workspace-1/memories/search",
        { method: "POST", token: "token-a", body: { query: "refresh token", limit: 10 } },
      );
      expect(seen).toEqual([MEMORY_A]);
      expect(response).toMatchObject({
        status: 200,
        body: {
          memories: [{ memory: { id: MEMORY_A }, score: 0.8 }],
          ranking: { id: "host-semantic-test", kind: "semantic", corpusSize: 1 },
        },
      });
    } finally {
      await api.close();
    }
  });

  it("applies changed space membership on every read", async () => {
    const directory = identityDirectory();
    let spaces: Record<string, "reader"> = { "space-a": "reader" };
    const memberships: MembershipResolver = {
      async resolveAccess(subject, workspaceId) {
        if (subject.principalId !== "user-a" || workspaceId !== "workspace-1") return undefined;
        return {
          principalId: subject.principalId,
          workspaceId,
          workspaceRole: "member",
          spaceRoles: { ...spaces },
        };
      },
    };
    const api = await startApi({ authenticator: directory, memberships });
    try {
      const body = memoryRecordBody({
        input: {
          id: MEMORY_A,
          spaceId: "space-a",
          source: "conversation",
          content: { fact: true },
        },
      });
      expect(
        (await apiRequest(api.baseUrl, "/v1/workspaces/workspace-1/memories", {
          method: "POST",
          token: "token-a",
          body,
        })).status,
      ).toBe(201);
      spaces = {};
      const raw = await apiRequest(api.baseUrl, "/v1/workspaces/workspace-1/events", {
        token: "token-a",
      });
      const recalled = await apiRequest(api.baseUrl, "/v1/workspaces/workspace-1/memories", {
        token: "token-a",
      });
      expect(raw.body.entries).toEqual([]);
      expect(recalled.body.memories).toEqual([]);
    } finally {
      await api.close();
    }
  });

  it("records scoped trajectory evidence and returns JSON-safe analysis", async () => {
    const api = await startApi();
    try {
      const tree = await apiRequest(api.baseUrl, "/v1/workspaces/workspace-1/trajectory-tasks", {
        method: "POST",
        token: "token-a",
        body: {
          stamp: { id: "trajectory-tree-event", t: 200, worldDate: "2026-08-19" },
          spaceId: "space-a",
          tree: trajectoryTree,
        },
      });
      expect(tree).toMatchObject({
        status: 201,
        body: {
          event: {
            author: { kind: "human", id: "user-a" },
            capture: {
              scope: { workspace: "workspace-1", space: "space-a" },
              identity: { principal: "user-a", workspace: "workspace-1" },
            },
          },
          record: { recordType: "tree", actorId: "user-a" },
        },
      });

      for (const [index, input] of [
        trajectoryInput("run-a", "model-a", "success", ["observe", "expiry", "patch", "pass"]),
        trajectoryInput("run-b", "model-b", "failure", ["observe", "network", "retry", "fail"]),
      ].entries()) {
        const recorded = await apiRequest(api.baseUrl, "/v1/workspaces/workspace-1/trajectories", {
          method: "POST",
          token: "token-a",
          body: {
            stamp: { id: `trajectory-run-event-${index}`, t: 201 + index, worldDate: "2026-08-19" },
            spaceId: "space-a",
            input,
          },
        });
        expect(recorded.status).toBe(201);
      }

      const tasks = await apiRequest(
        api.baseUrl,
        "/v1/workspaces/workspace-1/trajectory-tasks",
        { token: "token-a" },
      );
      expect(tasks.body.tasks).toEqual([
        expect.objectContaining({
          taskId: "refresh-regression",
          trajectoryCount: 2,
          successCount: 1,
          failureCount: 1,
        }),
      ]);

      const report = await apiRequest(
        api.baseUrl,
        "/v1/workspaces/workspace-1/trajectory-tasks/refresh-regression",
        { token: "token-a" },
      );
      expect(report).toMatchObject({
        status: 200,
        body: {
          report: {
            analysis: {
              traceCount: 2,
              routeEligibleTraceCount: 2,
              coverage: { total: 8, mapped: 8, mappedRatio: 1 },
            },
            divergences: [
              { trajectoryId: "run-a", divergence: { kind: "aligned" } },
              { trajectoryId: "run-b", divergence: { kind: "divergent" } },
            ],
          },
        },
      });
      expect(Array.isArray(report.body.report.analysis.edgeOutcomes)).toBe(true);
      expect(report.body.report.analysis.edgeOutcomes).toHaveLength(6);

      const duplicate = await apiRequest(
        api.baseUrl,
        "/v1/workspaces/workspace-1/trajectory-tasks",
        {
          method: "POST",
          token: "token-a",
          body: {
            stamp: { id: "duplicate-tree", t: 203, worldDate: "2026-08-19" },
            spaceId: "space-a",
            tree: trajectoryTree,
          },
        },
      );
      expect(duplicate).toMatchObject({ status: 409, body: { error: { code: "fold_conflict" } } });
    } finally {
      await api.close();
    }
  });

  it("does not reveal unavailable trajectory tasks", async () => {
    const api = await startApi();
    try {
      const missing = await apiRequest(
        api.baseUrl,
        "/v1/workspaces/workspace-1/trajectory-tasks/missing-task",
        { token: "token-a" },
      );
      expect(missing).toMatchObject({
        status: 404,
        body: { error: { code: "trajectory_task_unavailable" } },
      });
    } finally {
      await api.close();
    }
  });

  it("keeps local activity simulation disabled by default", async () => {
    const api = await startApi();
    try {
      const response = await apiRequest(
        api.baseUrl,
        "/v1/workspaces/workspace-1/activity-signals",
        {
          method: "POST",
          token: "token-b",
          body: activityBody(1, 0, { type: "session_started" }),
        },
      );
      expect(response).toMatchObject({ status: 404, body: { error: { code: "not_found" } } });
    } finally {
      await api.close();
    }
  });

  it("records owner-only simulated signals and rebuilds fleet state", async () => {
    const api = await startApi({ enableSimulation: true });
    try {
      const denied = await apiRequest(
        api.baseUrl,
        "/v1/workspaces/workspace-1/activity-signals",
        {
          method: "POST",
          token: "token-a",
          body: activityBody(1, 0, { type: "session_started" }),
        },
      );
      expect(denied).toMatchObject({
        status: 403,
        body: { error: { code: "simulation_access_denied" } },
      });

      for (const [index, item] of [
        { offset: 0, signal: { type: "session_started" } },
        { offset: 400, signal: { type: "heartbeat" } },
        { offset: 500, signal: { type: "tool_running", toolName: "vitest" } },
      ].entries()) {
        const recorded = await apiRequest(
          api.baseUrl,
          "/v1/workspaces/workspace-1/activity-signals",
          {
            method: "POST",
            token: "token-b",
            body: activityBody(index + 1, item.offset, item.signal),
          },
        );
        expect(recorded.status).toBe(201);
        if (index === 0) {
          expect(recorded.body.event).toMatchObject({
            author: { kind: "sensor", id: "urn:sensor:terminal:sim-session-a" },
            capture: {
              scope: { workspace: "workspace-1" },
              identity: { principal: "user-b", workspace: "workspace-1" },
            },
          });
        }
      }

      const fleet = await apiRequest(
        api.baseUrl,
        `/v1/workspaces/workspace-1/fleet?nowMs=${fleetEpoch + 900}&orphanAfterMs=2000`,
        { token: "token-b" },
      );
      expect(fleet).toMatchObject({
        status: 200,
        body: {
          simulationEnabled: true,
          fleet: {
            sessions: [{
              sessionId: "sim-session-a",
              agentId: "sim-agent-a",
              status: "busy",
              availability: "available",
              freshness: "current",
              orphaned: false,
            }],
            recoveryActions: [],
          },
        },
      });

      const memberView = await apiRequest(
        api.baseUrl,
        `/v1/workspaces/workspace-1/fleet?nowMs=${fleetEpoch + 900}`,
        { token: "token-a" },
      );
      expect(memberView.body).toMatchObject({
        simulationEnabled: false,
        fleet: { sessions: [{ sessionId: "sim-session-a" }] },
      });
    } finally {
      await api.close();
    }
  });

  it("returns bounded validation errors without internal details", async () => {
    const api = await startApi({ maxBodyBytes: 80 });
    try {
      const wrongType = await apiRequest(api.baseUrl, "/v1/workspaces/workspace-1/events", {
        method: "POST",
        token: "token-a",
        rawBody: "{}",
        contentType: "text/plain",
      });
      expect(wrongType.status).toBe(415);
      const malformed = await apiRequest(api.baseUrl, "/v1/workspaces/workspace-1/events", {
        method: "POST",
        token: "token-a",
        rawBody: "{",
      });
      expect(malformed.status).toBe(400);
      const oversized = await apiRequest(api.baseUrl, "/v1/workspaces/workspace-1/events", {
        method: "POST",
        token: "token-a",
        body: { value: "x".repeat(100) },
      });
      expect(oversized.status).toBe(413);
      const cursor = await apiRequest(
        api.baseUrl,
        "/v1/workspaces/workspace-1/events?cursorT=1",
        { token: "token-a" },
      );
      expect(cursor.status).toBe(400);
      const wrongMethod = await apiRequest(
        api.baseUrl,
        `/v1/workspaces/workspace-1/memories/${MEMORY_A}`,
        { method: "POST", token: "token-a", body: {} },
      );
      expect(wrongMethod.status).toBe(405);
      expect(JSON.stringify(wrongMethod.body)).not.toContain("/Users/");
    } finally {
      await api.close();
    }
  });
});
