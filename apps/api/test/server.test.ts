import {
  FixedWindowRateLimiter,
  StaticIdentityDirectory,
  createApiServer,
  type MembershipResolver,
} from "../src/index.js";
import type { MemoryRanker } from "@_89/fold-sdk";
import type { TranscriptImportBundle } from "@_89/fold-transcript";
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

const transcriptProject = {
  id: "project-a",
  name: "Project A",
  identityKeyHash: "a".repeat(64),
  resolution: "resolved" as const,
  roots: ["/workspace/project-a"],
};

const transcriptArtifact = {
  id: "artifact-a",
  source: "codex" as const,
  sha256: "b".repeat(64),
  sourcePathHash: "c".repeat(64),
  byteLength: 100,
  mediaType: "application/x-ndjson",
  parser: { id: "codex-jsonl", version: "1" },
  contentPolicy: "metadata-only" as const,
  stored: false,
  redactionCount: 0,
};

const transcriptRun = {
  id: "codex:run-a",
  nativeId: "run-a",
  source: "codex" as const,
  artifactId: transcriptArtifact.id,
  projectId: transcriptProject.id,
  projectResolution: "resolved" as const,
  startedAt: "2026-08-20T12:00:00.000Z",
  endedAt: "2026-08-20T12:05:00.000Z",
  cwd: "/workspace/project-a",
  counts: { records: 5, turns: 1, messages: 2, actions: 1, unknown: 0 },
  segments: [{
    id: "codex:run-a:segment:0",
    ordinal: 0,
    projectId: transcriptProject.id,
    resolution: "resolved" as const,
    cwd: "/workspace/project-a",
    startedAt: "2026-08-20T12:00:00.000Z",
  }],
};

const transcriptBundle: TranscriptImportBundle = {
  projects: [transcriptProject],
  artifact: transcriptArtifact,
  run: transcriptRun,
  chunks: [{
    runId: transcriptRun.id,
    sequence: 0,
    turns: [{
      id: "codex:run-a:turn:0",
      ordinal: 0,
      messageCount: 2,
      actionCount: 1,
      roles: ["user", "assistant"],
    }],
    actions: [{
      id: "codex:run-a:action:0",
      ordinal: 0,
      turnId: "codex:run-a:turn:0",
      kind: "tool-call",
      name: "exec_command",
      status: "completed",
    }],
  }],
};

describe("Fold HTTP API", () => {
  it("configures bounded HTTP connection lifetimes", () => {
    const directory = identityDirectory();
    const server = createApiServer({
      authenticator: directory,
      memberships: directory,
      sdks: { async sdkFor() { throw new Error("not used"); } },
    });
    expect(server.requestTimeout).toBe(60_000);
    expect(server.headersTimeout).toBe(10_000);
    expect(server.keepAliveTimeout).toBe(5_000);
    expect(server.maxRequestsPerSocket).toBe(1_000);
  });

  it("enforces exact-origin CORS and answers valid preflight requests", async () => {
    const api = await startApi({ corsOrigins: ["https://brain.example"] });
    try {
      const allowed = await fetch(`${api.baseUrl}/health`, {
        headers: { origin: "https://brain.example" },
      });
      expect(allowed.status).toBe(200);
      expect(allowed.headers.get("access-control-allow-origin")).toBe("https://brain.example");
      expect(allowed.headers.get("vary")).toBe("Origin");

      const preflight = await fetch(`${api.baseUrl}/v1/workspaces/workspace-1/events`, {
        method: "OPTIONS",
        headers: {
          origin: "https://brain.example",
          "access-control-request-method": "GET",
          "access-control-request-headers": "authorization",
        },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-methods")).toContain("GET");
      expect(preflight.headers.get("access-control-allow-headers")).toContain("authorization");

      const denied = await fetch(`${api.baseUrl}/health`, {
        headers: { origin: "https://hostile.example" },
      });
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({ error: { code: "origin_denied" } });
    } finally {
      await api.close();
    }
  });

  it("rate limits application routes while keeping health observable", async () => {
    const api = await startApi({ rateLimiter: new FixedWindowRateLimiter(1) });
    try {
      expect((await apiRequest(api.baseUrl, "/health")).status).toBe(200);
      expect((await apiRequest(api.baseUrl, "/health")).status).toBe(200);
      expect(
        (await apiRequest(api.baseUrl, "/v1/workspaces/workspace-1/events")).status,
      ).toBe(401);
      const limited = await apiRequest(api.baseUrl, "/v1/workspaces/workspace-1/events");
      expect(limited).toMatchObject({
        status: 429,
        body: { error: { code: "rate_limited" } },
      });
      expect(limited.body.error.details.retryAfterSeconds).toBeGreaterThan(0);
      expect(limited.headers.get("ratelimit-remaining")).toBe("0");
      expect(limited.headers.get("retry-after")).toBe(
        limited.body.error.details.retryAfterSeconds.toString(),
      );
    } finally {
      await api.close();
    }
  });

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

  it("enforces credential capabilities independently from workspace role", async () => {
    const directory = new StaticIdentityDirectory({
      "read-token": {
        principalId: "reader-a",
        capabilities: ["memories:read"],
        workspaces: { "workspace-1": { role: "owner" } },
      },
    });
    const api = await startApi({ authenticator: directory, memberships: directory });
    try {
      expect((await apiRequest(api.baseUrl, "/v1/workspaces/workspace-1/memories", { token: "read-token" })).status)
        .toBe(200);
      expect(await apiRequest(api.baseUrl, "/v1/workspaces/workspace-1/events", { token: "read-token" }))
        .toMatchObject({ status: 403, body: { error: { code: "credential_scope_denied" } } });
      expect(await apiRequest(api.baseUrl, "/v1/workspaces/workspace-1/memories", {
        method: "POST",
        token: "read-token",
        body: memoryRecordBody(),
      })).toMatchObject({ status: 403, body: { error: { code: "credential_scope_denied" } } });
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
      expect(all.body.total).toBe(2);

      const bounded = await apiRequest(
        api.baseUrl,
        "/v1/workspaces/workspace-1/events?include=canon%2Bdraft&limit=1",
        { token: "token-a" },
      );
      expect(bounded.body).toMatchObject({ total: 2 });
      expect(bounded.body.entries.map((entry: any) => entry.event.id)).toEqual(["event-b"]);

      const invalidLimit = await apiRequest(
        api.baseUrl,
        "/v1/workspaces/workspace-1/events?limit=0",
        { token: "token-a" },
      );
      expect(invalidLimit).toMatchObject({
        status: 400,
        body: { error: { code: "invalid_query" } },
      });

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

  it("streams filtered events after a resumable exclusive cursor", async () => {
    const api = await startApi({ eventStreamPollMs: 10 });
    const controller = new AbortController();
    try {
      await apiRequest(api.baseUrl, "/v1/workspaces/workspace-1/events", {
        method: "POST",
        token: "token-a",
        body: { event: apiEvent({ id: "event-a", t: 1, kind: "alpha" }) },
      });
      const response = await fetch(
        `${api.baseUrl}/v1/workspaces/workspace-1/event-stream?afterT=1&afterEventId=event-a&kind=alpha`,
        {
          headers: { authorization: "Bearer token-a" },
          signal: controller.signal,
        },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");

      await apiRequest(api.baseUrl, "/v1/workspaces/workspace-1/events", {
        method: "POST",
        token: "token-a",
        body: { event: apiEvent({ id: "event-b", t: 2, kind: "alpha" }) },
      });
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let received = "";
      while (!received.includes('"eventId":"event-b"')) {
        const chunk = await reader.read();
        if (chunk.done) break;
        received += decoder.decode(chunk.value, { stream: true });
      }
      expect(received).not.toContain('"eventId":"event-a"');
      expect(received).toContain('"eventId":"event-b"');
      expect(received).toContain('"id":"event-b"');
    } finally {
      controller.abort();
      await api.close();
    }
  });

  it("persists consumer cursors separately for each principal", async () => {
    const api = await startApi();
    try {
      const path = "/v1/workspaces/workspace-1/consumers/hermes-main";
      expect((await apiRequest(api.baseUrl, path, { token: "token-a" })).body.cursor).toBeNull();
      const committed = await apiRequest(api.baseUrl, path, {
        method: "POST",
        token: "token-a",
        body: { cursor: { t: 12, eventId: "event-12" } },
      });
      expect(committed.body.cursor).toEqual({ t: 12, eventId: "event-12" });
      expect((await apiRequest(api.baseUrl, path, { token: "token-a" })).body.cursor)
        .toEqual({ t: 12, eventId: "event-12" });
      expect((await apiRequest(api.baseUrl, path, { token: "token-b" })).body.cursor).toBeNull();

      const backward = await apiRequest(api.baseUrl, path, {
        method: "POST",
        token: "token-a",
        body: { cursor: { t: 11, eventId: "event-11" } },
      });
      expect(backward).toMatchObject({ status: 409, body: { error: { code: "fold_conflict" } } });
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

  it("reserves intention and transcript records to their dedicated routes", async () => {
    const api = await startApi();
    try {
      const base = apiEvent({ id: "event-a", t: 1 });
      const response = await apiRequest(api.baseUrl, "/v1/workspaces/workspace-1/events", {
        method: "POST",
        token: "token-a",
        body: {
          event: {
            ...base,
            kind: "intention.surfaced",
            capture: { scope: { workspace: "workspace-1" }, identity: { actor: "agent-a" } },
            changes: [{
              verb: "create",
              subject: "urn:fold-record:event-a",
              nodeKind: "x.fold.intention-event",
              after: {
                actorId: "agent-a",
                atMs: 1,
                eventType: "surfaced",
                candidate: {
                  id: "candidate-a",
                  sourceDriveId: "delivery",
                  satisfier: { kind: "task", ref: "verify" },
                  aim: "Verify release",
                  surfacedAtMs: 1,
                  trigger: { kind: "threshold" },
                },
              },
              provenance: { basis: "authored" },
            }],
          },
        },
      });
      expect(response).toMatchObject({
        status: 400,
        body: { error: { code: "reserved_event_route" } },
      });

      const transcript = await apiRequest(api.baseUrl, "/v1/workspaces/workspace-1/events", {
        method: "POST",
        token: "token-a",
        body: { event: apiEvent({ id: "event-b", t: 2, kind: "transcript.run-imported" }) },
      });
      expect(transcript).toMatchObject({
        status: 400,
        body: { error: { code: "reserved_event_route" } },
      });
    } finally {
      await api.close();
    }
  });

  it("accepts exact event retries without creating duplicates", async () => {
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
      expect(duplicate).toMatchObject({ status: 201, body: { entry: { event: { id: "event-a" } } } });
      expect((await apiRequest(api.baseUrl, "/v1/workspaces/workspace-1/events", {
        token: "token-a",
      })).body.entries).toHaveLength(1);
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

      const feedback = await apiRequest(
        api.baseUrl,
        `/v1/workspaces/workspace-1/memories/${MEMORY_A}/feedback`,
        {
          method: "POST",
          token: "token-a",
          body: {
            stamp: { id: "event-feedback", t: 115, worldDate: "2026-08-17" },
            input: { signal: "helpful", query: "Which memory helped?", taskId: "task-a" },
          },
        },
      );
      expect(feedback).toMatchObject({
        status: 201,
        body: { feedback: { memoryId: MEMORY_A, signal: "helpful", actorId: "user-a", taskId: "task-a" } },
      });

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

  it("reviews workspace memory candidates and exposes accepted project memory", async () => {
    const api = await startApi();
    try {
      const proposed = await apiRequest(api.baseUrl, "/v1/workspaces/workspace-1/memory-candidates", {
        method: "POST",
        token: "token-a",
        body: {
          stamp: { id: "candidate-event", t: 100, worldDate: "2026-08-17" },
          input: {
            id: MEMORY_A,
            audience: "workspace",
            projectIds: ["project-a"],
            source: "transcript",
            summary: "Use Postgres for canonical events",
            content: { decision: "postgres" },
            tags: ["architecture", "decision"],
            evidence: [{ eventId: "transcript-chunk-1", runId: "run-a", projectId: "project-a" }],
            confidence: 0.92,
            salience: 0.84,
            extractor: { kind: "rule", id: "durable-decision", version: "1" },
          },
        },
      });
      expect(proposed).toMatchObject({ status: 201, body: { candidate: { audience: "workspace", proposerId: "user-a" } } });

      const denied = await apiRequest(
        api.baseUrl,
        `/v1/workspaces/workspace-1/memory-candidates/${MEMORY_A}/accept`,
        {
          method: "POST",
          token: "token-a",
          body: {
            stamp: { id: "denied-event", t: 101, worldDate: "2026-08-17" },
            memoryStamp: { id: "denied-memory-event", t: 102, worldDate: "2026-08-17" },
            memoryId: MEMORY_B,
          },
        },
      );
      expect(denied).toMatchObject({ status: 403, body: { error: { code: "shared_memory_review_access_denied" } } });

      const accepted = await apiRequest(
        api.baseUrl,
        `/v1/workspaces/workspace-1/memory-candidates/${MEMORY_A}/accept`,
        {
          method: "POST",
          token: "token-b",
          body: {
            stamp: { id: "accept-event", t: 103, worldDate: "2026-08-17" },
            memoryStamp: { id: "memory-event", t: 104, worldDate: "2026-08-17" },
            memoryId: MEMORY_B,
          },
        },
      );
      expect(accepted).toMatchObject({
        status: 201,
        body: { memory: { id: MEMORY_B, audience: "workspace", projectIds: ["project-a"] } },
      });

      const recalled = await apiRequest(
        api.baseUrl,
        "/v1/workspaces/workspace-1/memories?projectId=project-a",
        { token: "token-a" },
      );
      expect(recalled.body.memories).toEqual([
        expect.objectContaining({ memory: expect.objectContaining({ id: MEMORY_B }) }),
      ]);
      const candidates = await apiRequest(
        api.baseUrl,
        "/v1/workspaces/workspace-1/memory-candidates?status=accepted&projectId=project-a",
        { token: "token-a" },
      );
      expect(candidates.body.candidates).toEqual([
        expect.objectContaining({ status: "accepted", candidate: expect.objectContaining({ id: MEMORY_A }) }),
      ]);
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

  it("answers pull reasoning with provider and evidence provenance", async () => {
    const api = await startApi();
    try {
      await apiRequest(api.baseUrl, "/v1/workspaces/workspace-1/memories", {
        method: "POST",
        token: "token-a",
        body: memoryRecordBody({
          input: {
            id: MEMORY_A,
            source: "conversation",
            summary: "Rotate the access token before retrying",
            content: { outcome: "refresh succeeded" },
            tags: ["authentication"],
          },
        }),
      });

      const response = await apiRequest(
        api.baseUrl,
        "/v1/workspaces/workspace-1/reasoning/ask",
        {
          method: "POST",
          token: "token-a",
          body: { question: "How did the access token refresh recover?", limit: 5 },
        },
      );
      expect(response).toMatchObject({
        status: 200,
        body: {
          answer: "Relevant evidence: Rotate the access token before retrying.",
          citations: [MEMORY_A],
          provider: { id: "local-evidence-v1", kind: "extractive" },
          ranking: { id: "local-bm25-v1", kind: "lexical", corpusSize: 1 },
          evidence: [{ memoryId: MEMORY_A, source: "conversation", score: 1 }],
        },
      });

      const entries = await apiRequest(
        api.baseUrl,
        "/v1/workspaces/workspace-1/events",
        { token: "token-a" },
      );
      expect(entries.body.entries.map((entry: any) => entry.event.kind)).toEqual(["memory.recorded"]);
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
          captureIdentity: { agent: "codex", session: "session-a", repo: "project-a" },
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
              identity: {
                agent: "codex",
                session: "session-a",
                repo: "project-a",
                principal: "user-a",
                workspace: "workspace-1",
              },
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
            captureIdentity: { agent: "codex", session: `session-${index}`, repo: "project-a" },
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
      expect(duplicate).toMatchObject({
        status: 201,
        body: { event: { id: "trajectory-tree-event" }, record: { tree: trajectoryTree } },
      });
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

  it("does not expose a simulated activity mutation route", async () => {
    const api = await startApi();
    try {
      const response = await apiRequest(
        api.baseUrl,
        "/v1/workspaces/workspace-1/activity-signals",
        {
          method: "POST",
          token: "token-b",
          body: {},
        },
      );
      expect(response).toMatchObject({ status: 404, body: { error: { code: "not_found" } } });
    } finally {
      await api.close();
    }
  });

  it("imports transcript metadata owner-only and exposes project and run history", async () => {
    const api = await startApi();
    try {
      const denied = await apiRequest(
        api.baseUrl,
        "/v1/workspaces/workspace-1/transcript-imports",
        {
          method: "POST",
          token: "token-a",
          body: transcriptBundle,
        },
      );
      expect(denied).toMatchObject({
        status: 403,
        body: { error: { code: "transcript_import_access_denied" } },
      });

      const imported = await apiRequest(
        api.baseUrl,
        "/v1/workspaces/workspace-1/transcript-imports",
        { method: "POST", token: "token-b", body: transcriptBundle },
      );
      expect(imported).toMatchObject({
        status: 201,
        body: { imported: true, eventCount: 4, run: { id: transcriptRun.id } },
      });

      const retried = await apiRequest(
        api.baseUrl,
        "/v1/workspaces/workspace-1/transcript-imports",
        { method: "POST", token: "token-b", body: transcriptBundle },
      );
      expect(retried).toMatchObject({
        status: 200,
        body: { imported: false, eventCount: 0 },
      });

      const projects = await apiRequest(
        api.baseUrl,
        "/v1/workspaces/workspace-1/transcript-projects",
        { token: "token-a" },
      );
      expect(projects).toMatchObject({
        status: 200,
        body: { projects: [{ project: { id: transcriptProject.id }, runCount: 1 }] },
      });

      const project = await apiRequest(
        api.baseUrl,
        `/v1/workspaces/workspace-1/transcript-projects/${transcriptProject.id}`,
        { token: "token-a" },
      );
      expect(project).toMatchObject({
        status: 200,
        body: { project: { id: transcriptProject.id }, runs: [{ id: transcriptRun.id }] },
      });

      const runs = await apiRequest(
        api.baseUrl,
        `/v1/workspaces/workspace-1/transcript-runs?projectId=${transcriptProject.id}&source=codex`,
        { token: "token-a" },
      );
      expect(runs).toMatchObject({
        status: 200,
        body: { runs: [{ id: transcriptRun.id, nativeId: transcriptRun.nativeId }] },
      });

      const detail = await apiRequest(
        api.baseUrl,
        `/v1/workspaces/workspace-1/transcript-runs/${encodeURIComponent(transcriptRun.id)}`,
        { token: "token-a" },
      );
      expect(detail).toMatchObject({
        status: 200,
        body: {
          run: { id: transcriptRun.id },
          artifact: { id: transcriptArtifact.id, contentPolicy: "metadata-only" },
          projects: [{ id: transcriptProject.id }],
          chunks: [{ runId: transcriptRun.id, sequence: 0 }],
        },
      });
    } finally {
      await api.close();
    }
  });

  it("records owner-only human steering and rebuilds actor intentions", async () => {
    const api = await startApi();
    try {
      const denied = await apiRequest(
        api.baseUrl,
        "/v1/workspaces/workspace-1/steering/agent-a",
        {
          method: "POST",
          token: "token-a",
          body: {
            action: "surface",
            stamp: { id: "steer-event-a", t: 300, worldDate: "2026-08-21" },
            candidate: {
              id: "candidate-a",
              sourceDriveId: "delivery",
              satisfier: { kind: "task", ref: "verify-ranked-recall" },
              aim: "Verify ranked recall before rollout",
              trigger: { kind: "threshold" },
            },
          },
        },
      );
      expect(denied).toMatchObject({
        status: 403,
        body: { error: { code: "steering_access_denied" } },
      });

      const surfaced = await apiRequest(
        api.baseUrl,
        "/v1/workspaces/workspace-1/steering/agent-a",
        {
          method: "POST",
          token: "token-b",
          body: {
            action: "surface",
            stamp: { id: "steer-event-a", t: 300, worldDate: "2026-08-21" },
            candidate: {
              id: "candidate-a",
              sourceDriveId: "delivery",
              satisfier: { kind: "task", ref: "verify-ranked-recall" },
              aim: "Verify ranked recall before rollout",
              trigger: { kind: "threshold" },
            },
          },
        },
      );
      expect(surfaced).toMatchObject({
        status: 201,
        body: {
          event: {
            kind: "intention.surfaced",
            author: { kind: "human", id: "user-b" },
            capture: {
              scope: { workspace: "workspace-1" },
              identity: { actor: "agent-a" },
            },
          },
          steering: { actorId: "agent-a", pendingCandidates: [{ id: "candidate-a" }] },
        },
      });

      const committed = await apiRequest(
        api.baseUrl,
        "/v1/workspaces/workspace-1/steering/agent-a",
        {
          method: "POST",
          token: "token-b",
          body: {
            action: "commit",
            stamp: { id: "steer-event-b", t: 301, worldDate: "2026-08-21" },
            candidateId: "candidate-a",
            intentionId: "intention-a",
          },
        },
      );
      expect(committed).toMatchObject({
        status: 201,
        body: { steering: { pendingCandidates: [], intentions: [{ id: "intention-a" }] } },
      });

      const memberRead = await apiRequest(
        api.baseUrl,
        "/v1/workspaces/workspace-1/steering",
        { token: "token-a" },
      );
      expect(memberRead).toMatchObject({
        status: 200,
        body: {
          steeringEnabled: false,
          actors: [{ actorId: "agent-a", intentions: [{ id: "intention-a" }] }],
        },
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
