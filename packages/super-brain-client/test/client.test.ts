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
  it("sends project-aware recall with bearer authentication", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ memories: [] })) as unknown as typeof fetch;
    await client(fetchMock).recallMemories({ projectIds: ["project-a"], limit: 5 });
    const [url, init] = (fetchMock as any).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://brain.example/v1/workspaces/workspace%2Fone/memories/recall");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer secret");
    expect(JSON.parse(String(init.body))).toEqual({ projectIds: ["project-a"], limit: 5 });
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

  it("returns stable API errors", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: { code: "denied", message: "No" } }, 403)) as unknown as typeof fetch;
    await expect(client(fetchMock).memoryCandidates()).rejects.toEqual(expect.objectContaining<Partial<SuperBrainApiError>>({ status: 403, code: "denied", message: "No" }));
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
