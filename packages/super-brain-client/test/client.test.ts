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
  it("sends a reviewed exact evaluation selection with original subject and canonical cancellation", async () => {
    const received: { url: string; init: RequestInit }[] = [];
    const api = client(async (url, init) => { received.push({url:String(url),init:init!}); return jsonResponse({eligible:[],excluded:[]}); });
    const reference = {kind:"memory" as const,memoryId:"synthetic",revision:0};
    const request = {selectionId:"selection",audience:"local-reviewed" as const,redactionVersion:"v1",expectedSubject:{organizationId:"local",workspaceId:"workspace/one",principalId:"synthetic"},references:[reference],reviewedReferences:[reference]};
    await api.selectEvaluationSources(request, {timeoutMs:1000});
    expect(received[0]?.url).toBe("https://brain.example/v1/workspaces/workspace%2Fone/evaluation-sources/selection");
    expect(JSON.parse(String(received[0]?.init.body))).toEqual(request);
    expect(received[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });
  it("resolves explicit event IDs without sending an oversized request URL", async () => {
    const ids = Array.from({ length: 100 }, (_, i) => `${i.toString().padStart(3, "0")}-${"x".repeat(100)}`);
    const urls: string[] = [];
    const api = client(async (input) => {
      const url = new URL(String(input)); urls.push(url.toString());
      return jsonResponse({ entries: url.searchParams.getAll("eventId").map((id) => ({ event: { id, at: { t: 1 } }, status: "canon" })) });
    });
    expect((await api.listEvents({ eventIds: ids })).map(({ event }) => event.id)).toEqual(ids);
    expect(urls.length).toBeGreaterThan(1);
    expect(urls.every((url) => url.length < 7000)).toBe(true);
  });

  it("preserves caller-owned command identities and propagates a real reasoning deadline", async () => {
    const requests: RequestInit[] = [];
    const fetchMock: typeof fetch = async (_url, init) => {
      requests.push(init!);
      return jsonResponse({ event: {}, memory: {}, candidate: {} });
    };
    const api = client(fetchMock);
    const stamp = { id: "durable-job", t: 1, worldDate: "2026-09-05" };
    const input = { evidence: [{ eventId: "source", relation: "supports" as const }], expectedRevision: 0 };
    await api.contributeMemoryEvidence("memory-a", input, { stamp });
    await api.contributeMemoryEvidence("memory-a", input, { stamp });
    expect(requests[0]?.body).toBe(requests[1]?.body);
    expect(JSON.parse(String(requests[0]?.body))).toEqual({ stamp, input });
    expect(() => api.recordMemory({ source: "test" }, undefined, { stamp })).toThrow("explicit memory ID");
    let aborted = false;
    const slow: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => { aborted = true; reject(init!.signal!.reason); }, { once: true });
    });
    await expect(client(slow).askReasoning({ question: "Slow question" }, { timeoutMs: 10 })).rejects.toMatchObject({ code: "timeout" });
    expect(aborted).toBe(true);
  });

  it("surfaces stream revocation as a terminal structured error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('event: stream-error\ndata: {"status":403,"code":"stream_access_revoked","message":"Revoked"}\n\n', { status: 200 })) as unknown as typeof fetch;
    const read = async () => { for await (const _event of client(fetchMock).eventStream()) { /* no event expected */ } };
    await expect(read()).rejects.toMatchObject({ status: 403, code: "stream_access_revoked" });
  });

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
      version: 2, memoryRevision: 0, recallId: "recall-a", signal: "judged", judgment: "helpful",
      taskId: "task-a",
    });
    const [url, init] = (fetchMock as any).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://brain.example/v1/workspaces/workspace%2Fone/memories/memory%2Fa/feedback");
    expect(JSON.parse(String(init.body))).toMatchObject({
      input: { version: 2, memoryRevision: 0, recallId: "recall-a", signal: "judged", judgment: "helpful", taskId: "task-a" },
    });
  });

  it("queues exact offered revisions without awaiting durable storage or retaining queries", async () => {
    const subject = { principalId: "user-a", organizationId: "org-a", workspaceId: "workspace/one" };
    const provenance = { version: 1, recallId: "recall-a", subject, observedAt: "2026-09-04", operation: "search", ranking: { id: "lexical", kind: "lexical" }, items: [{ memoryId: "memory-a", memoryRevision: 0, rank: 1 }] };
    const enqueue = vi.fn(() => new Promise<void>(() => {}));
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ memories: [], provenance, ranking: { id: "lexical", kind: "lexical", corpusSize: 0 } })) as unknown as typeof fetch;
    const api = new SuperBrainClient({ baseUrl: "https://brain.example", workspaceId: "workspace/one", token: "secret", fetch: fetchMock, telemetryOutbox: { enqueue, status: async () => ({ pending: 0, retry: 0, denied: 0, exhausted: 0, observedAt: "now" }) } });
    await api.rankMemories({ query: "secret query must never enter telemetry" });
    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue.mock.calls[0]).toEqual([expect.objectContaining({ subject, items: [expect.objectContaining({ memoryId: "memory-a", input: expect.objectContaining({ version: 2, signal: "offered", memoryRevision: 0, recallId: "recall-a" }) })] })]);
    expect(JSON.stringify(enqueue.mock.calls)).not.toContain("secret query");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("parses resumable SSE frames split across chunks", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(": connected\n\nevent: fold-event\ndata: {\"entry\":{\"event\":{\"id\":\"event-a\"},\"status\":\"canon\"},"));
        controller.enqueue(encoder.encode("\"cursor\":{\"version\":2,\"sequence\":\"10\"}}\n\n"));
        controller.close();
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
    const events = [];
    for await (const event of client(fetchMock).eventStream({
      after: { t: 5, eventId: "before" },
      kinds: ["memory.recorded"],
    })) events.push(event);
    expect(events).toEqual([{ entry: { event: { id: "event-a" }, status: "canon" }, cursor: { version: 2, sequence: "10" } }]);
    expect((fetchMock as any).mock.calls[0][0]).toContain("afterT=5&afterEventId=before&kind=memory.recorded");
  });

  it("commits a cursor only after the handler succeeds", async () => {
    const encoder = new TextEncoder();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ cursor: null }))
      .mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) { controller.enqueue(encoder.encode("event: fold-event\ndata: {\"entry\":{\"event\":{\"id\":\"event-a\"},\"status\":\"canon\"},\"cursor\":{\"version\":2,\"sequence\":\"10\"}}\n\n")); controller.close(); } }), { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({ cursor: { version: 2, sequence: "10" } })) as unknown as typeof fetch;
    const seen: string[] = [];
    await client(fetchMock).consumeEvents({ consumerId: "hermes-a", reconnect: false, replay: "all", onEvent(event) { seen.push(event.entry.event.id); } });
    expect(seen).toEqual(["event-a"]);
    expect(JSON.parse(String(((fetchMock as any).mock.calls[2][1] as RequestInit).body))).toEqual({ cursor: { version: 2, sequence: "10" } });
  });

  it("reconnects a terminated stream from the durable cursor", async () => {
    const encoder = new TextEncoder();
    const controller = new AbortController();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ cursor: null }))
      .mockRejectedValueOnce(new TypeError("terminated"))
      .mockResolvedValueOnce(new Response(new ReadableStream({ start(stream) {
        stream.enqueue(encoder.encode("event: fold-event\ndata: {\"entry\":{\"event\":{\"id\":\"event-b\"},\"status\":\"canon\"},\"cursor\":{\"version\":2,\"sequence\":\"11\"}}\n\n"));
        stream.close();
      } }), { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({ cursor: { version: 2, sequence: "11" } })) as unknown as typeof fetch;
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
      .mockResolvedValueOnce(jsonResponse({ cursor: { version: 2, sequence: "10" } }))
      .mockResolvedValueOnce(jsonResponse({
        error: {
          code: "rate_limited",
          message: "Wait",
          details: { retryAfterSeconds: 0.001 },
        },
      }, 429))
      .mockResolvedValueOnce(new Response(new ReadableStream({ start(stream) {
        stream.enqueue(encoder.encode("event: fold-event\ndata: {\"entry\":{\"event\":{\"id\":\"event-b\"},\"status\":\"canon\"},\"cursor\":{\"version\":2,\"sequence\":\"11\"}}\n\n"));
        stream.close();
      } }), { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({ cursor: { version: 2, sequence: "11" } })) as unknown as typeof fetch;
    await client(fetchMock).consumeEvents({
      consumerId: "worker-a",
      reconnectDelayMs: 0,
      signal: controller.signal,
      onEvent() { controller.abort(); },
    });
    expect((fetchMock as any).mock.calls[1][0]).toContain("afterSequence=10");
    expect((fetchMock as any).mock.calls[2][0]).toContain("afterSequence=10");
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
