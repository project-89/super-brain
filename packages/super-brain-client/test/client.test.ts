import { describe, expect, it, vi } from "vitest";

import { SuperBrainApiError, SuperBrainClient } from "../src/index.js";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

const ingestionStatus = (sequence: string | null = "0") => ({
  cursor: sequence === null ? null : { kind: "ingestion", sequence }, legacyCursor: null,
  migrationRequired: false, headCursor: { kind: "ingestion", sequence: "11" },
});

function eventStreamResponse(...sequences: string[]): Response {
  return new Response(sequences.map(sequence => `event: fold-event\ndata: ${JSON.stringify({ entry: { event: { id: `event-${sequence}` }, status: "canon" }, cursor: { kind: "ingestion", sequence } })}\n\n`).join(""));
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
  it("uses typed episode synthesis, publication, detail and cursor routes", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse({})); const api = client(fetchMock);
    const request = { windowId: "window", parentWindowId: "parent", sourceEventIds: ["source"], projectId: null, audience: "workspace" as const, trigger: "manual" as const };
    await api.synthesizeEpisodeWindow(request);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual(request);
    expect(fetchMock.mock.calls[0]![0]).toContain("work-episodes/synthesize");
    await api.publishEpisodeWindow({ schemaVersion: 1, windowId: "window", projectId: null, audience: "workspace", sources: [{ eventId: "source", sha256: "a".repeat(64) }], producer: { id: "coverage", version: "1" }, trigger: "manual", episodes: [], ungrouped: [{ eventId: "source", reason: "Metadata only" }] });
    expect(fetchMock.mock.calls[1]![0]).toContain("work-episodes/windows");
    await api.workEpisode("episode/a"); expect(fetchMock.mock.calls[2]![0]).toContain("work-episodes/episode%2Fa");
    await api.episodePage({ episodeId: "episode/a", detail: "sources", cursor: "next" });
    expect(fetchMock.mock.calls[3]![0]).toContain("work-episodes/episode%2Fa/sources?limit=1&pageCursor=next");
    expect(() => api.episodePage({ episodeId: "episode/a", detail: "sources", limit: 2 })).toThrow(/one complete/);
  });
  it("bounds ordinary JSON requests and cleans up timers and external cancellation listeners", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
        if (init!.signal!.aborted) reject(init!.signal!.reason);
        else init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
      });
      const api = client(fetchMock);
      const timedOut = expect(api.memoryById("memory-a")).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(30_000); await timedOut;
      expect(vi.getTimerCount()).toBe(0);
      const external = new AbortController(); const remove = vi.spyOn(external.signal, "removeEventListener");
      const cancelled = expect(api["request"]("/test", { signal: external.signal })).rejects.toThrow("cancelled");
      external.abort(new Error("cancelled")); await cancelled;
      expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
      expect(vi.getTimerCount()).toBe(0);
      await client(async () => jsonResponse({}))["request"]("/test");
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("loads one authorized canonical event with a deadline and only treats 404 as unavailable", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ entry: { event: { id: "source" }, status: "canon" } }))
      .mockResolvedValueOnce(jsonResponse({ error: { code: "event_unavailable", message: "Missing" } }, 404))
      .mockResolvedValueOnce(jsonResponse({ error: { code: "denied", message: "Denied" } }, 403));
    const api = client(fetchMock);
    expect(await api.eventById("source/id")).toEqual({ id: "source" });
    expect(fetchMock.mock.calls[0]![0]).toContain("events/source%2Fid");
    expect(fetchMock.mock.calls[0]![1].signal).toBeInstanceOf(AbortSignal);
    expect(await api.eventById("missing")).toBeUndefined();
    await expect(api.eventById("denied")).rejects.toMatchObject({ status: 403 });
  });

  it("sends reviewed identity inputs and alias preview revision tokens unchanged", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse({})); const api = client(fetchMock);
    const input = { aliasProjectId: "local", canonicalProjectId: "remote", active: true, reason: "Reviewed", evidenceEventIds: [] };
    await api.previewProjectAlias(input); await api.reviseProjectAlias("revision", "preview", input);
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1].body))).toEqual({ expectedRevision: "revision", previewToken: "preview", input });
    await api.identityPage("entities", { kind: "person", cursor: "next", limit: 20 });
    expect(fetchMock.mock.calls[2]![0]).toContain("identities/entities?limit=20&pageCursor=next&kind=person");
  });

  it("bounds reasoning requests without sending timeout settings to the API", async () => {
    const fetchMock: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true }));
    await expect(client(fetchMock).askReasoning({ question: "Question" }, { requestTimeoutMs: 5 })).rejects.toThrow(/timed out/i);
    await expect(client(fetchMock).askReasoning({ question: "Question" }, { requestTimeoutMs: 0 })).rejects.toThrow(/positive integer/);
  });

  it("propagates applicability on memory, revision, and candidate requests without inventing legacy values", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse({}));
    const api = client(fetchMock);
    await api.recordMemory({ source: "test", applicability: "general" });
    await api.reviseMemory("memory-a", { applicability: "project", projectIds: ["project-a"] });
    const candidate = { source: "test", summary: "Test", content: null, evidence: [{ eventId: "source" }], confidence: 0.8, salience: 0.8, extractor: { kind: "rule" as const, id: "test", version: "1" } };
    await api.proposeMemoryCandidate({ ...candidate, applicability: "unresolved" });
    await api.proposeMemoryCandidates([{ ...candidate, applicability: "general" }, candidate]);
    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init.body)));
    expect(bodies[0].input.applicability).toBe("general");
    expect(bodies[1].patch).toEqual({ applicability: "project", projectIds: ["project-a"] });
    expect(bodies[2].input.applicability).toBe("unresolved");
    expect(bodies[3].proposals[0].input.applicability).toBe("general");
    expect(bodies[3].proposals[1].input).not.toHaveProperty("applicability");
  });

  it("sends candidate support as a scoped immutable input with a bounded request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ candidate: { id: "target" } }));
    const input = { id: "incoming", source: "test", audience: "workspace" as const, applicability: "project" as const,
      projectIds: ["project-a"], summary: "Same meaning", content: { fact: true }, evidence: [{ eventId: "source", turnId: "later" }],
      confidence: 0.9, salience: 0.8, extractor: { kind: "rule" as const, id: "test", version: "1" } };
    expect(await client(fetchMock).addMemoryCandidateEvidence("target/id", input)).toEqual({ candidate: { id: "target" } });
    expect(fetchMock.mock.calls[0]![0]).toContain("memory-candidates/target%2Fid/evidence");
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).input).toEqual(input);
    expect(fetchMock.mock.calls[0]![1].signal).toBeInstanceOf(AbortSignal);
  });

  it("reads every catalog page with bounded requests and rejects repeated cursors", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ runs: [{ id: "run-a" }], nextCursor: "next+page" }))
      .mockResolvedValueOnce(jsonResponse({ runs: [{ id: "run-b" }] }));
    await expect(client(fetchMock).transcriptRuns()).resolves.toEqual([{ id: "run-a" }, { id: "run-b" }]);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://brain.example/v1/workspaces/workspace%2Fone/transcript-runs?limit=100&pageCursor=next%2Bpage");
    expect(fetchMock.mock.calls[0]?.[1].signal).toBeInstanceOf(AbortSignal);
    fetchMock.mockImplementation(async () => jsonResponse({ runs: [], nextCursor: "same" }));
    await expect(client(fetchMock).transcriptRuns()).rejects.toThrow(/invalid cursor/);
  });

  it("aborts stalled transcript catalog requests", async () => {
    const fetchMock: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true }));
    await expect(client(fetchMock).transcriptRuns({ requestTimeoutMs: 10 })).rejects.toThrow(/timed out/i);
  });

  it("pages indexed event metadata and preserves canonical ascending order and filters", async () => {
    const entry = (id: string, t: number) => ({ event: { id, at: { t } }, status: "canon" });
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ entries: [entry("new", 3), entry("a", 2)], nextCursor: "next+page" }))
      .mockResolvedValueOnce(jsonResponse({ entries: [entry("b", 2), entry("old", 1)] }));
    const entries = await client(fetchMock).listEvents({ kinds: ["transcript.run-imported"], include: "canon" });
    expect(entries.map(({ event }) => event.id)).toEqual(["old", "a", "b", "new"]);
    expect(fetchMock.mock.calls[0]![0]).toContain("events?order=desc&limit=100&kind=transcript.run-imported&include=canon");
    expect(fetchMock.mock.calls[1]![0]).toContain("&pageCursor=next%2Bpage");
    fetchMock.mockReset().mockResolvedValueOnce(jsonResponse({ entries: [entry("a", 2)], nextCursor: "next" }))
      .mockResolvedValueOnce(jsonResponse({ entries: [entry("z", 2), entry("old", 1)], nextCursor: "unused" }));
    expect((await client(fetchMock).listEvents({ limit: 1 })).map(({ event }) => event.id)).toEqual(["z"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed event pagination rather than looping or returning incomplete data", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse({ entries: [], nextCursor: "same" }));
    await expect(client(fetchMock).listEvents()).rejects.toThrow(/invalid cursor/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockReset().mockResolvedValue(jsonResponse({}));
    await expect(client(fetchMock).listEvents()).rejects.toThrow(/invalid response/);
    await expect(client(fetchMock).listEvents({ limit: 0 })).rejects.toThrow(/positive integer/);
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
      "https://brain.example/v1/organizations/organization%2Fone/workspaces/workspace%2Fone/events?order=desc&limit=100",
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
        controller.enqueue(encoder.encode("\"cursor\":{\"kind\":\"ingestion\",\"sequence\":\"10\"}}\n\n"));
        controller.close();
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
    const events = [];
    for await (const event of client(fetchMock).eventStream({
      after: { kind: "ingestion", sequence: "5" },
      kinds: ["memory.recorded"],
    })) events.push(event);
    expect(events).toEqual([{ entry: { event: { id: "event-a" }, status: "canon" }, cursor: { kind: "ingestion", sequence: "10" } }]);
    expect((fetchMock as any).mock.calls[0][0]).toContain("order=ingestion&afterSequence=5&kind=memory.recorded");
  });

  it("commits a cursor only after the handler succeeds", async () => {
    const encoder = new TextEncoder();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(ingestionStatus()))
      .mockResolvedValueOnce(eventStreamResponse("10"))
      .mockResolvedValueOnce(jsonResponse({ cursor: { t: 10, eventId: "event-a" } })) as unknown as typeof fetch;
    const seen: string[] = [];
    await client(fetchMock).consumeEvents({ consumerId: "hermes-a", reconnect: false, replay: "all", onEvent(event) { seen.push(event.entry.event.id); } });
    expect(seen).toEqual(["event-10"]);
    expect(JSON.parse(String(((fetchMock as any).mock.calls[2][1] as RequestInit).body))).toEqual({ cursor: { kind: "ingestion", sequence: "10" } });
  });

  it("requires an explicit legacy replay migration and preserves precision in the command", async () => {
    const legacy = { t: 9000, eventId: "old-high-water" };
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ ...ingestionStatus(null), legacyCursor: legacy, migrationRequired: true }))
      .mockResolvedValueOnce(jsonResponse({ ...ingestionStatus("0"), legacyCursor: legacy }));
    const api = client(fetchMock);
    await expect(api.consumeEvents({ consumerId: "worker", reconnect: false, onEvent() { throw new Error("must not run"); } })).rejects.toMatchObject({ code: "ingestion_cursor_migration_required" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await api.migrateConsumerCursor("worker", { kinds: ["terminal.observation"] })).toMatchObject({ legacyCursor: legacy, cursor: { sequence: "0" } });
    expect(fetchMock.mock.calls[1]![0]).toContain("consumers/worker?order=ingestion&kind=terminal.observation");
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1].body))).toEqual({ migration: "replay-all" });
    const big = client(vi.fn().mockResolvedValue(eventStreamResponse("9007199254740993")));
    for await (const event of big.eventStream()) expect(event.cursor.sequence).toBe("9007199254740993");
  });

  it("sends an explicit expected cursor and reason for an audited replay reset", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(ingestionStatus("0")));
    const cursor = { kind: "ingestion" as const, sequence: "105440" };
    await client(fetchMock).resetConsumerCursor("worker", cursor, "Repair numeric ingestion order", { kinds: ["terminal.observation"] });
    expect(fetchMock.mock.calls[0]![0]).toContain("consumers/worker?order=ingestion&kind=terminal.observation");
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1].body))).toEqual({ reset: { expectedCursor: cursor, reason: "Repair numeric ingestion order" } });
  });

  it("batches checkpoints but flushes only successful callbacks on failure", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(ingestionStatus("0")))
      .mockResolvedValueOnce(eventStreamResponse("1", "2", "3", "4"))
      .mockResolvedValueOnce(jsonResponse({}));
    await expect(client(fetchMock).consumeEvents({ consumerId: "batch", checkpointEvery: 100, reconnect: false,
      onEvent(event) { if (event.cursor.sequence === "3") throw new Error("durable spool full"); },
    })).rejects.toThrow("durable spool full");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(fetchMock.mock.calls[2]![1].body))).toEqual({ cursor: { kind: "ingestion", sequence: "2" } });
  });

  it("checkpoints a bounded batch and its final partial batch before returning", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(ingestionStatus("0")))
      .mockResolvedValueOnce(eventStreamResponse("1", "2", "3"))
      .mockImplementation(async () => jsonResponse({}));
    await client(fetchMock).consumeEvents({ consumerId: "batch", checkpointEvery: 2, reconnect: false, onEvent() {} });
    expect(fetchMock.mock.calls.slice(2).map(([, init]) => JSON.parse(String(init.body)).cursor.sequence)).toEqual(["2", "3"]);
    await expect(client(fetchMock).consumeEvents({ consumerId: "batch", checkpointEvery: 101, onEvent() {} })).rejects.toThrow(/checkpointEvery/);
  });

  it("pins a fresh tail before a disconnect instead of skipping to a later tail on reconnect", async () => {
    const abort = new AbortController();
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(ingestionStatus(null)))
      .mockResolvedValueOnce(jsonResponse({}))
      .mockRejectedValueOnce(new TypeError("disconnected before first event"))
      .mockResolvedValueOnce(eventStreamResponse("12"))
      .mockResolvedValueOnce(jsonResponse({}));
    await client(fetchMock).consumeEvents({ consumerId: "fresh", reconnectDelayMs: 0, signal: abort.signal, onEvent() { abort.abort(); } });
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1].body)).cursor).toEqual({ kind: "ingestion", sequence: "11" });
    expect(fetchMock.mock.calls[2]![0]).toContain("afterSequence=11");
    expect(fetchMock.mock.calls[3]![0]).toContain("afterSequence=11");
  });

  it("persists explicit fresh replay intent before a first callback failure", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(ingestionStatus(null)))
      .mockResolvedValueOnce(jsonResponse({})).mockResolvedValueOnce(eventStreamResponse("1"));
    await expect(client(fetchMock).consumeEvents({ consumerId: "new-replay", replay: "all", reconnect: false,
      onEvent() { throw new Error("enqueue failed"); },
    })).rejects.toThrow("enqueue failed");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1].body))).toEqual({ cursor: { kind: "ingestion", sequence: "0" } });
    expect(fetchMock.mock.calls[2]![0]).toContain("afterSequence=0");
  });

  it("does not initialize a consumer after cancellation", async () => {
    const abort = new AbortController();
    const fetchMock = vi.fn(async () => { abort.abort(); return jsonResponse(ingestionStatus(null)); });
    await client(fetchMock).consumeEvents({ consumerId: "cancelled", signal: abort.signal, onEvent() {} });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await client(fetchMock).consumeEvents({ consumerId: "cancelled", signal: abort.signal, onEvent() {} });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("flushes idle batches without racing a slow callback or clearing a newer pending event", async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    let finishFirst!: () => void;
    let finishSecond!: () => void;
    const api = client(async () => jsonResponse(ingestionStatus("0")));
    const commits: string[] = [];
    vi.spyOn(api, "commitIngestionCursor").mockImplementation(async (_id, cursor) => {
      commits.push(cursor.sequence);
      if (cursor.sequence === "1") await new Promise<void>(resolve => { finishFirst = resolve; });
    });
    vi.spyOn(api, "eventStream").mockImplementation(async function* (options) {
      yield { entry: { event: { id: "one" }, status: "canon" } as any, cursor: { kind: "ingestion", sequence: "1" } };
      yield { entry: { event: { id: "two" }, status: "canon" } as any, cursor: { kind: "ingestion", sequence: "2" } };
      await new Promise<void>((_resolve, reject) => options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true }));
    });
    const run = api.consumeEvents({ consumerId: "idle", checkpointEvery: 100, signal: abort.signal,
      async onEvent(event) { if (event.cursor.sequence === "2") await new Promise<void>(resolve => { finishSecond = resolve; }); },
    });
    try {
      await vi.advanceTimersByTimeAsync(1_000);
      expect(commits).toEqual(["1"]);
      finishSecond();
      await vi.advanceTimersByTimeAsync(1);
      finishFirst();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(commits).toEqual(["1", "2"]);
      abort.abort(); await run;
      expect(vi.getTimerCount()).toBe(0);
    } finally { abort.abort(); vi.useRealTimers(); }
  });

  it("stops and reports a failed idle checkpoint rather than silently advancing", async () => {
    vi.useFakeTimers();
    const api = client(async () => jsonResponse(ingestionStatus("0")));
    const commits = vi.spyOn(api, "commitIngestionCursor").mockRejectedValue(new SuperBrainApiError(403, "denied", "Denied"));
    vi.spyOn(api, "eventStream").mockImplementation(async function* (options) {
      yield { entry: { event: { id: "one" }, status: "canon" } as any, cursor: { kind: "ingestion", sequence: "1" } };
      await new Promise<void>((_resolve, reject) => options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true }));
    });
    const result = expect(api.consumeEvents({ consumerId: "idle", checkpointEvery: 100, onEvent() {} })).rejects.toMatchObject({ status: 403 });
    try { await vi.advanceTimersByTimeAsync(1_000); await result; expect(commits).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0); }
    finally { vi.useRealTimers(); }
  });

  it("reconnects a terminated stream from the durable cursor", async () => {
    const encoder = new TextEncoder();
    const controller = new AbortController();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(ingestionStatus()))
      .mockRejectedValueOnce(new TypeError("terminated"))
      .mockResolvedValueOnce(new Response(new ReadableStream({ start(stream) {
        stream.enqueue(encoder.encode("event: fold-event\ndata: {\"entry\":{\"event\":{\"id\":\"event-b\"},\"status\":\"canon\"},\"cursor\":{\"kind\":\"ingestion\",\"sequence\":\"11\"}}\n\n"));
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
      .mockResolvedValueOnce(jsonResponse(ingestionStatus("10")))
      .mockResolvedValueOnce(jsonResponse({
        error: {
          code: "rate_limited",
          message: "Wait",
          details: { retryAfterSeconds: 0.001 },
        },
      }, 429))
      .mockResolvedValueOnce(new Response(new ReadableStream({ start(stream) {
        stream.enqueue(encoder.encode("event: fold-event\ndata: {\"entry\":{\"event\":{\"id\":\"event-b\"},\"status\":\"canon\"},\"cursor\":{\"kind\":\"ingestion\",\"sequence\":\"11\"}}\n\n"));
        stream.close();
      } }), { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({ cursor: { t: 11, eventId: "event-b" } })) as unknown as typeof fetch;
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
