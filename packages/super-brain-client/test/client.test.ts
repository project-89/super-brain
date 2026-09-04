import { describe, expect, it, vi } from "vitest";

import { SuperBrainApiError, SuperBrainClient } from "../src/index.js";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function client(fetchMock: typeof fetch) {
  return new SuperBrainClient({
    baseUrl: "https://brain.example/",
    workspaceId: "workspace/one",
    token: "secret",
    fetch: fetchMock,
  });
}

describe("SuperBrainClient", () => {
  it("uses an organization-qualified route when organization scope is configured", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ entries: [] })) as unknown as typeof fetch;
    const scoped = new SuperBrainClient({
      baseUrl: "https://brain.example",
      organizationId: "organization/one",
      workspaceId: "workspace/one",
      token: "secret",
      fetch: fetchMock,
    });
    await scoped.listEvents();
    expect((fetchMock as any).mock.calls[0][0]).toBe(
      "https://brain.example/v1/organizations/organization%2Fone/workspaces/workspace%2Fone/events",
    );
  });

  it("sends project-aware recall with bearer authentication", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ memories: [] })) as unknown as typeof fetch;
    await client(fetchMock).recallMemories({ projectIds: ["project-a"], limit: 5 });
    const [url, init] = (fetchMock as any).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://brain.example/v1/workspaces/workspace%2Fone/memories/recall");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer secret");
    expect(JSON.parse(String(init.body))).toEqual({ projectIds: ["project-a"], limit: 5 });
  });

  it("records auditable memory feedback through the dedicated route", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ event: {}, feedback: { signal: "helpful" } })) as unknown as typeof fetch;
    await client(fetchMock).recordMemoryFeedback("memory/a", {
      signal: "helpful",
      query: "Which store is canonical?",
      taskId: "task-a",
    });
    const [url, init] = (fetchMock as any).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://brain.example/v1/workspaces/workspace%2Fone/memories/memory%2Fa/feedback");
    expect(JSON.parse(String(init.body))).toMatchObject({
      input: { signal: "helpful", query: "Which store is canonical?", taskId: "task-a" },
    });
  });

  it("records recalled telemetry for every ranked memory when harness context is configured", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        memories: [{ memory: { id: "memory-a" }, score: 0.9 }, { memory: { id: "memory-b" }, score: 0.8 }],
        ranking: { id: "lexical", kind: "lexical", corpusSize: 2 },
      }))
      .mockResolvedValue(jsonResponse({ event: {}, feedback: { signal: "recalled" } })) as unknown as typeof fetch;
    const api = new SuperBrainClient({
      baseUrl: "https://brain.example",
      workspaceId: "workspace/one",
      token: "secret",
      fetch: fetchMock,
      recallTelemetry: { sessionId: "session-a", taskId: "task-a", detail: "test-harness" },
    });
    await api.rankMemories({ query: "Which store is canonical?" });
    expect((fetchMock as any).mock.calls).toHaveLength(3);
    expect((fetchMock as any).mock.calls.slice(1).map(([url]: [string]) => url)).toEqual([
      expect.stringContaining("/memories/memory-a/feedback"),
      expect.stringContaining("/memories/memory-b/feedback"),
    ]);
    expect(JSON.parse(String(((fetchMock as any).mock.calls[1][1] as RequestInit).body))).toMatchObject({
      input: {
        signal: "recalled",
        query: "Which store is canonical?",
        sessionId: "session-a",
        taskId: "task-a",
        detail: "test-harness",
      },
    });
  });

  it("parses resumable SSE frames split across chunks", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(": connected\n\nevent: fold-event\ndata: {\"entry\":{\"event\":{\"id\":\"event-a\"},\"status\":\"canon\"},"));
        controller.enqueue(encoder.encode("\"cursor\":{\"t\":10,\"eventId\":\"event-a\"}}\n\n"));
        controller.close();
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
    const events = [];
    for await (const event of client(fetchMock).eventStream({
      after: { t: 5, eventId: "before" },
      kinds: ["memory.recorded"],
    })) events.push(event);
    expect(events).toEqual([{ entry: { event: { id: "event-a" }, status: "canon" }, cursor: { t: 10, eventId: "event-a" } }]);
    expect((fetchMock as any).mock.calls[0][0]).toContain("afterT=5&afterEventId=before&kind=memory.recorded");
  });

  it("commits a cursor only after the handler succeeds", async () => {
    const encoder = new TextEncoder();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ cursor: null }))
      .mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) { controller.enqueue(encoder.encode("event: fold-event\ndata: {\"entry\":{\"event\":{\"id\":\"event-a\"},\"status\":\"canon\"},\"cursor\":{\"t\":10,\"eventId\":\"event-a\"}}\n\n")); controller.close(); } }), { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({ cursor: { t: 10, eventId: "event-a" } })) as unknown as typeof fetch;
    const seen: string[] = [];
    await client(fetchMock).consumeEvents({ consumerId: "hermes-a", reconnect: false, replay: "all", onEvent(event) { seen.push(event.entry.event.id); } });
    expect(seen).toEqual(["event-a"]);
    expect(JSON.parse(String(((fetchMock as any).mock.calls[2][1] as RequestInit).body))).toEqual({ cursor: { t: 10, eventId: "event-a" } });
  });

  it("reconnects a terminated stream from the durable cursor", async () => {
    const encoder = new TextEncoder();
    const controller = new AbortController();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ cursor: null }))
      .mockRejectedValueOnce(new TypeError("terminated"))
      .mockResolvedValueOnce(new Response(new ReadableStream({ start(stream) {
        stream.enqueue(encoder.encode("event: fold-event\ndata: {\"entry\":{\"event\":{\"id\":\"event-b\"},\"status\":\"canon\"},\"cursor\":{\"t\":11,\"eventId\":\"event-b\"}}\n\n"));
        stream.close();
      } }), { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({ cursor: { t: 11, eventId: "event-b" } })) as unknown as typeof fetch;
    await client(fetchMock).consumeEvents({
      consumerId: "hermes-b",
      replay: "all",
      reconnectDelayMs: 0,
      signal: controller.signal,
      onEvent() { controller.abort(); },
    });
    expect((fetchMock as any).mock.calls).toHaveLength(4);
  });

  it("retries a rate-limited stream from the durable cursor", async () => {
    const encoder = new TextEncoder();
    const controller = new AbortController();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ cursor: { t: 10, eventId: "event-a" } }))
      .mockResolvedValueOnce(jsonResponse({
        error: {
          code: "rate_limited",
          message: "Wait",
          details: { retryAfterSeconds: 0.001 },
        },
      }, 429))
      .mockResolvedValueOnce(new Response(new ReadableStream({ start(stream) {
        stream.enqueue(encoder.encode("event: fold-event\ndata: {\"entry\":{\"event\":{\"id\":\"event-b\"},\"status\":\"canon\"},\"cursor\":{\"t\":11,\"eventId\":\"event-b\"}}\n\n"));
        stream.close();
      } }), { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({ cursor: { t: 11, eventId: "event-b" } })) as unknown as typeof fetch;
    await client(fetchMock).consumeEvents({
      consumerId: "worker-a",
      reconnectDelayMs: 0,
      signal: controller.signal,
      onEvent() { controller.abort(); },
    });
    expect((fetchMock as any).mock.calls[1][0]).toContain("afterT=10&afterEventId=event-a");
    expect((fetchMock as any).mock.calls[2][0]).toContain("afterT=10&afterEventId=event-a");
  });

  it("returns stable API errors", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: { code: "denied", message: "No" } }, 403)) as unknown as typeof fetch;
    await expect(client(fetchMock).memoryCandidates()).rejects.toEqual(expect.objectContaining<Partial<SuperBrainApiError>>({ status: 403, code: "denied", message: "No" }));
  });

  it("records trajectory trees and runs through server-derived identity routes", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ event: {}, record: { recordType: "tree" } }))
      .mockResolvedValueOnce(jsonResponse({ event: {}, record: { recordType: "trajectory" } })) as unknown as typeof fetch;
    const api = client(fetchMock);
    const stamp = { id: "event-a", t: 1, worldDate: "2026-09-02" };
    const tree = {
      taskId: "task-a",
      rootNodeId: "observe",
      nodes: [
        { id: "observe", kind: "observation" as const, label: "Observe" },
        { id: "done", kind: "outcome" as const, label: "Done" },
      ],
      edges: [{ id: "next", sourceId: "observe", targetId: "done", label: "next" }],
    };
    await api.recordTrajectoryTree(stamp, tree);
    await api.recordTrajectory(stamp, {
      id: "run-a",
      taskId: "task-a",
      model: { id: "codex" },
      outcome: "unknown",
      steps: [
        { id: "step-a", stepNumber: 1, role: "decision", content: "Observe" },
        { id: "step-b", stepNumber: 2, role: "model_output", content: "Done" },
      ],
      assignments: {
        "step-a": { kind: "mapped", nodeId: "observe", method: { kind: "rule", id: "capture" } },
        "step-b": { kind: "mapped", nodeId: "done", method: { kind: "rule", id: "capture" } },
      },
    });
    expect((fetchMock as any).mock.calls.map((call: [string]) => call[0])).toEqual([
      "https://brain.example/v1/workspaces/workspace%2Fone/trajectory-tasks",
      "https://brain.example/v1/workspaces/workspace%2Fone/trajectories",
    ]);
  });

  it("batches trusted candidate promotions with ordered event stamps", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ accepted: [] })) as unknown as typeof fetch;
    await client(fetchMock).acceptMemoryCandidates(["candidate-a", "candidate-b"]);
    const [url, init] = (fetchMock as any).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(url).toBe("https://brain.example/v1/workspaces/workspace%2Fone/memory-candidate-promotions");
    expect(body).toMatchObject({
      audience: "workspace",
      acceptances: [{ candidateId: "candidate-a" }, { candidateId: "candidate-b" }],
    });
    expect(body.acceptances[0].stamp.t).toBeLessThanOrEqual(body.acceptances[0].memoryStamp.t);
    expect(body.acceptances[0].memoryStamp.t).toBeLessThanOrEqual(body.acceptances[1].stamp.t);
  });
});
