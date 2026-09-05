import { describe, expect, it } from "vitest";
import { StaticIdentityDirectory } from "../src/index.js";
import { apiEvent, apiRequest, startApi } from "./helpers.js";

const path = "/v1/workspaces/workspace-1";
const stamp = (id: string, t: number) => ({ id, t, worldDate: "2026-09-05" });
const task = { version: 1, taskId: "task-a", taskVersion: "spec-v1", goal: "Preserve authenticated outcomes", acceptanceCriteria: [{ id: "regression", description: "Synthetic delivery round trip passes" }], inputs: [{ artifactId: "private-input", kind: "input" }] };
const attempt = { version: 1, attemptId: "attempt-a", taskId: task.taskId, taskVersion: task.taskVersion, conditionId: "baseline", startRevision: { fingerprintStatus: "available", revisionId: "public-before" } };
const directory = () => new StaticIdentityDirectory({
  human: { principalId: "human", taskEvidenceAuthority: { kind: "human" }, workspaces: { "workspace-1": { role: "admin", spaces: { "space-a": "writer", "space-b": "writer" } } } },
  machine: { principalId: "machine", author: { kind: "agent", id: "agent" }, workspaces: { "workspace-1": { role: "member" } } },
  integration: { principalId: "ci-reporter", taskEvidenceAuthority: { kind: "integration", integrationId: "synthetic-ci" }, capabilities: ["task-outcomes:write", "trajectories:read"], workspaces: { "workspace-1": { role: "member" } } },
  reader: { principalId: "space-reader", taskEvidenceAuthority: { kind: "human" }, workspaces: { "workspace-1": { role: "member", spaces: { "space-a": "reader" } } } },
});

describe("task evidence authority and immutable attempt HTTP contracts", () => {
  it("revalidates explicit authority and does not grant it through default human-looking author metadata", async () => {
    const identity = directory(); const machine = await identity.authenticate("machine");
    expect(machine?.taskEvidenceAuthority).toBeUndefined();
    expect(await identity.resolveAccess({ ...machine!, taskEvidenceAuthority: { kind: "human", principalId: machine!.principalId } }, "local", "workspace-1")).toBeUndefined();
    const human = await identity.authenticate("human");
    expect(await identity.resolveAccess(human!, "local", "workspace-1")).toBeDefined();
    expect(await identity.resolveAccess({ ...human!, taskEvidenceAuthority: { kind: "integration", integrationId: "synthetic-ci" } }, "local", "workspace-1")).toBeUndefined();
  });
  it("accepts an authenticated external delivery exactly once without requiring a preexisting source event", async () => {
    const identity = directory(); const api = await startApi({ authenticator: identity, memberships: identity });
    const post = (resource: string, token: string, body: unknown) => apiRequest(api.baseUrl, `${path}/${resource}`, { method: "POST", token, body });
    try {
      expect((await post("trajectory-tasks/task-a/manifests", "human", { stamp: stamp("task", 1), input: task })).status).toBe(201);
      expect((await post("trajectory-tasks/task-a/attempts", "human", { stamp: stamp("attempt", 2), input: attempt })).status).toBe(201);
      const input = { version: 1, id: "ci-observation", taskId: task.taskId, attemptId: attempt.attemptId, revisionId: "public-before", kind: "ci", result: "success", observedAt: "2026-09-05T00:00:00Z", source: { providerId: "synthetic-ci", deliveryId: "delivery-1", externalId: "check-22" } };
      const body = { stamp: stamp("delivery", 3), input };
      expect((await post("trajectory-tasks/task-a/outcomes", "machine", body)).status).toBe(403);
      const delivered = await post("trajectory-tasks/task-a/outcomes", "integration", body);
      expect(delivered).toMatchObject({ status: 201, body: { record: { actorId: "ci-reporter", authority: { kind: "integration", integrationId: "synthetic-ci" }, input } } });
      expect((await post("trajectory-tasks/task-a/outcomes", "integration", body)).body).toEqual(delivered.body);
      expect((await post("trajectory-tasks/task-a/outcomes", "integration", { ...body, stamp: stamp("changed-stamp", 4), input: { ...input, result: "failure" } })).status).toBe(409);
      expect((await post("trajectory-tasks/task-a/outcomes", "integration", { stamp: stamp("other-provider", 4), input: { ...input, id: "other", source: { providerId: "forged-provider", deliveryId: "delivery-2" } } })).status).toBe(409);
      expect((await post("trajectory-tasks/task-a/outcomes", "integration", { stamp: stamp("bad-revision", 5), input: { ...input, id: "other", revisionId: "unrelated", source: { providerId: "synthetic-ci", deliveryId: "delivery-3" } } })).status).toBe(409);
      expect((await post("trajectory-tasks/task-a/manifests", "integration", { stamp: stamp("no-write", 6), input: task })).status).toBe(403);
      const report = await apiRequest(api.baseUrl, `${path}/trajectory-tasks/task-a/evidence?limit=1`, { token: "integration" });
      expect(report).toMatchObject({ status: 200, body: { total: 3, evidenceAvailability: "reference-only" } });
      expect(report.body.items).toHaveLength(1);
      const second = await apiRequest(api.baseUrl, `${path}/trajectory-tasks/task-a/evidence?limit=2&pageCursor=${report.body.nextCursor}`, { token: "integration" });
      expect(second.body.items.map((item: { kind: string }) => item.kind)).toEqual(["evidence", "task"]);
    } finally { await api.close(); }
  });

  it("keeps task-version and attempt identities immutable across spaces for readers who see both", async () => {
    const identity = directory(); const api = await startApi({ authenticator: identity, memberships: identity });
    const post = (resource: string, body: unknown) => apiRequest(api.baseUrl, `${path}/${resource}`, { method: "POST", token: "human", body });
    try {
      expect((await post("trajectory-tasks/task-a/manifests", { stamp: stamp("space-a-task", 1), input: task, spaceId: "space-a" })).status).toBe(201);
      expect((await post("trajectory-tasks/task-a/attempts", { stamp: stamp("space-a-attempt", 2), input: attempt, spaceId: "space-a" })).status).toBe(201);
      expect((await post("trajectory-tasks/task-a/manifests", { stamp: stamp("space-b-collision", 3), input: { ...task, goal: "A different private task" }, spaceId: "space-b" })).status).toBe(403);
      const otherTask = { ...task, taskVersion: "spec-v2", inputs: [] };
      expect((await post("trajectory-tasks/task-a/manifests", { stamp: stamp("space-b-task", 3), input: otherTask, spaceId: "space-b" })).status).toBe(201);
      expect((await post("trajectory-tasks/task-a/attempts", { stamp: stamp("space-b-attempt-collision", 4), input: { ...attempt, taskVersion: "spec-v2" }, spaceId: "space-b" })).status).toBe(403);
      expect((await post("trajectory-tasks/task-a/attempts", { stamp: stamp("space-b-attempt", 4), input: { ...attempt, attemptId: "attempt-b", taskVersion: "spec-v2" }, spaceId: "space-b" })).status).toBe(201);
      const report = await apiRequest(api.baseUrl, `${path}/trajectory-tasks/task-a/evidence`, { token: "human" });
      expect(report.status).toBe(200); expect(report.body.total).toBe(4);
      expect(report.body.items.filter((item: { kind: string }) => item.kind === "task").map((item: { task: { taskVersion: string } }) => item.task.taskVersion)).toEqual(["spec-v1", "spec-v2"]);
    } finally { await api.close(); }
  });

  it("binds human interventions to scope and revision, rejects machine approvals, and keeps original task inputs immutable", async () => {
    const identity = directory(); const api = await startApi({ authenticator: identity, memberships: identity });
    const post = (resource: string, token: string, body: unknown) => apiRequest(api.baseUrl, `${path}/${resource}`, { method: "POST", token, body });
    try {
      const spaceId = "space-a";
      expect((await post("trajectory-tasks/task-a/manifests", "human", { stamp: stamp("task", 1), input: task, spaceId })).status).toBe(201);
      expect((await post("trajectory-tasks/task-a/attempts", "human", { stamp: stamp("attempt", 2), input: attempt, spaceId })).status).toBe(201);
      expect((await post("trajectory-tasks/task-a/manifests", "human", { stamp: stamp("task-change", 3), input: { ...task, inputs: [] }, spaceId })).status).toBe(409);
      expect((await post("trajectory-tasks/task-a/attempts", "human", { stamp: stamp("attempt-change", 3), input: { ...attempt, startRevision: { fingerprintStatus: "unavailable" } }, spaceId })).status).toBe(409);
      const baseEvent = apiEvent({ id: "correction-source", t: 3, principalId: "human" });
      const event = { ...baseEvent, capture: { ...baseEvent.capture, scope: { ...baseEvent.capture.scope, space: spaceId } } };
      expect((await post("events", "human", { event })).status).toBe(201);
      const input = { version: 1, id: "correction", taskId: task.taskId, attemptId: attempt.attemptId, revisionId: "public-before", kind: "correction", observedAt: "2026-09-05T00:00:00Z", sourceEventId: event.id };
      expect((await post("trajectory-tasks/task-a/interventions", "reader", { stamp: stamp("reader-correction", 4), input, spaceId })).status).toBe(403);
      const accepted = await post("trajectory-tasks/task-a/interventions", "human", { stamp: stamp("correction", 4), input, spaceId });
      expect(accepted).toMatchObject({ status: 201, body: { record: { authority: { kind: "human", principalId: "human" } } } });
      expect((await post("trajectory-tasks/task-a/interventions", "human", { stamp: stamp("broaden", 5), input: { ...input, id: "broaden" } })).status).toBe(403);
      expect((await post("events", "human", { event: accepted.body.event })).status).toBe(400);
      const machineAcceptance = { version: 1, id: "approve", taskId: task.taskId, attemptId: attempt.attemptId, revisionId: "public-before", kind: "acceptance", result: "success", observedAt: input.observedAt, sourceEventId: event.id, acceptance: { version: 1, taskId: task.taskId, attemptId: attempt.attemptId, revisionId: "public-before", verdict: "success", eventId: event.id, artifactId: "approval" } };
      expect((await post("trajectory-tasks/task-a/outcomes", "integration", { stamp: stamp("machine-approval", 6), input: machineAcceptance })).status).toBe(403);
      expect((await post("trajectory-tasks/task-a/outcomes", "human", { stamp: stamp("unrelated-source", 6), input: machineAcceptance, spaceId })).status).toBe(409);
      const approvalBody = { stamp: stamp("human-approval", 6), input: { ...input, id: "human-approval", kind: "approval", artifact: { artifactId: "approval", kind: "outcome" } }, spaceId };
      const approval = await post("trajectory-tasks/task-a/interventions", "human", approvalBody);
      expect(approval.status).toBe(201);
      expect((await post("trajectory-tasks/task-a/interventions", "human", approvalBody)).body).toEqual(approval.body);
      const outcomeBody = { stamp: stamp("accepted-outcome", 7), input: { ...machineAcceptance, sourceEventId: approval.body.event.id, acceptance: { ...machineAcceptance.acceptance, eventId: approval.body.event.id } }, spaceId };
      expect((await post("trajectory-tasks/task-a/outcomes", "human", outcomeBody)).status).toBe(201);
      expect((await post("trajectory-tasks/task-a/outcomes", "human", outcomeBody)).status).toBe(201);
    } finally { await api.close(); }
  });
});
