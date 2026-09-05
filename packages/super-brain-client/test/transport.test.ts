import { describe, expect, it, vi } from "vitest";
import { SuperBrainClient, SuperBrainApiError } from "../src/index.js";
const reply = (data: unknown, status = 200, headers: Record<string,string> = {}) => new Response(JSON.stringify(data), { status, headers });
const base = { baseUrl: "https://example.test", organizationId: "org", workspaceId: "work" };
describe("canonical transport", () => {
  it("refreshes credentials per request and bounds token acquisition and response bodies", async () => {
    let token = "first"; const headers: string[] = [];
    const api = new SuperBrainClient({ ...base, token: () => token, fetch: async (_url, init) => { headers.push(new Headers(init?.headers).get("authorization")!); return reply({}); } });
    await api.identity(); token = "second"; await api.identity(); expect(headers).toEqual(["Bearer first", "Bearer second"]);
    const waitingToken = new SuperBrainClient({ ...base, token: () => new Promise(() => {}), fetch: vi.fn() });
    await expect(waitingToken.identity({ timeoutMs: 5 })).rejects.toMatchObject({ code: "timeout", retryable: true });
    const waitingBody = new SuperBrainClient({ ...base, token: "token", fetch: async () => new Response(new ReadableStream({ start() {} })) });
    await expect(waitingBody.identity({ timeoutMs: 5 })).rejects.toMatchObject({ code: "timeout" });
  });
  it("preserves cancellation, malformed response and HTTP retry classifications", async () => {
    const cancelled = new AbortController(); cancelled.abort();
    const api = new SuperBrainClient({ ...base, token: "token", fetch: vi.fn() });
    await expect(api.identity({ signal: cancelled.signal })).rejects.toMatchObject({ code: "aborted", retryable: false });
    const malformed = new SuperBrainClient({ ...base, token: "token", fetch: async () => new Response("<html>unavailable</html>") });
    await expect(malformed.identity()).rejects.toMatchObject({ code: "invalid_response" });
    const limited = new SuperBrainClient({ ...base, token: "token", fetch: async () => reply({ error: { code: "rate_limited", message: "Wait" } }, 429, { "retry-after": "2" }) });
    await expect(limited.identity()).rejects.toMatchObject({ status: 429, retryable: true, retryAfterMs: 2000 });
    expect(new SuperBrainApiError(403,"denied","Denied").terminal).toBe(true);
  });
  it("surfaces asynchronous queue failures without rejecting successful reads", async () => {
    const provenance = { version: 1, recallId: "r", subject: { organizationId: "org", workspaceId: "work", principalId: "u" }, observedAt: "now", operation: "recall", ranking: { id: "r", kind: "explicit" }, items: [{ memoryId: "m", memoryRevision: 0, rank: 1 }] };
    const api = new SuperBrainClient({ ...base, token: "token", fetch: async () => reply({ memories: [], provenance }), telemetryOutbox: { enqueue: async () => { throw new Error("disk full"); }, status: async () => ({ pending: 0, retry: 0, denied: 0, exhausted: 0, observedAt: "now" }) } });
    expect((await api.recallMemoryPacket()).provenance).toEqual(provenance);
    await new Promise((resolve) => setTimeout(resolve, 0)); expect((await api.telemetryStatus()).unavailable).toBe("disk full");
  });
  it("retains correction revision and stable batch identity across retries", async () => {
    const bodies: unknown[] = [];
    const api = new SuperBrainClient({ ...base, token: "token", fetch: async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return reply({}); } });
    const stamp = { id: "command", t: 100, worldDate: "2026-09-04" };
    await api.reviseMemory("m", { summary: "correction" }, undefined, { stamp, expectedRevision: 0 });
    expect(bodies[0]).toMatchObject({ stamp, expectedRevision: 0 });
    const subject = { principalId: "u", organizationId: "org", workspaceId: "work" };
    const items = [{ stamp, memoryId: "m", input: { version: 2 as const, memoryRevision: 0, recallId: "r", signal: "used" as const } }];
    await api.recordMemoryFeedbackBatch(items,{stamp,expectedSubject:subject}); await api.recordMemoryFeedbackBatch(items,{stamp,expectedSubject:subject});
    expect(bodies[1]).toEqual(bodies[2]);
  });
  it("uses the browser fetch receiver for empty same-origin URLs and event streams", async () => {
    const requests: string[] = [];
    vi.stubGlobal("fetch", async function(this: unknown, url: string) {
      expect(this).toBe(globalThis); requests.push(url);
      return url.includes("event-stream") ? new Response(": connected\n\n") : reply({});
    });
    try {
      const api = new SuperBrainClient({ baseUrl: "", workspaceId: "w", token: "token" });
      await api.identity(); for await (const _event of api.eventStream()) { /* empty */ }
      expect(requests).toEqual(["/v1/workspaces/w/identity", "/v1/workspaces/w/event-stream"]);
    } finally { vi.unstubAllGlobals(); }
  });
  it("does not invoke a pre-aborted token supplier or leak its late rejection", async () => {
    const controller = new AbortController(); controller.abort();
    const supplier = vi.fn(async () => { throw new Error("must not run"); });
    const api = new SuperBrainClient({ ...base, token: supplier, fetch: vi.fn() });
    await expect(api.identity({ signal: controller.signal })).rejects.toMatchObject({ code: "aborted" }); expect(supplier).not.toHaveBeenCalled();
    const during = new AbortController();
    const raced = new SuperBrainClient({ ...base, token: () => { during.abort(); return Promise.reject(new Error("late supplier failure")); }, fetch: vi.fn() });
    await expect(raced.identity({ signal: during.signal })).rejects.toMatchObject({ code: "aborted" }); await new Promise((resolve) => setTimeout(resolve, 0));
  });
  it("avoids stamp collisions across isolated module instances at a frozen clock", async () => {
    vi.resetModules(); const first = await import("../src/index.js");
    vi.resetModules(); const second = await import("../src/index.js");
    const a = first.nextEventStamp(123456789), b = second.nextEventStamp(123456789);
    expect(a.id).not.toBe(b.id); expect(a.t).toBe(b.t);
    expect(first.nextEventStamp(123456789).id).not.toBe(a.id);
  });

  it("clears a client enqueue diagnostic after adapter repair and a durable successful enqueue",async()=>{
    let failed=true;const provenance={version:1,recallId:"r",subject:{organizationId:"org",workspaceId:"work",principalId:"u"},observedAt:"now",operation:"recall",ranking:{id:"r",kind:"explicit"},items:[{memoryId:"m",memoryRevision:0,rank:1}]};
    const api=new SuperBrainClient({...base,token:"token",fetch:async()=>reply({memories:[],provenance}),telemetryOutbox:{enqueue:async()=>{if(failed)throw new Error("disk full");},retryTerminal:async()=>{failed=false;return 0;},status:async()=>({pending:failed?0:1,retry:0,denied:0,exhausted:0,observedAt:"now"})}});
    await api.recallMemoryPacket();await new Promise((resolve)=>setTimeout(resolve,0));expect((await api.telemetryStatus()).unavailable).toBe("disk full");
    await api.repairTelemetry("retry");await api.recallMemoryPacket();await new Promise((resolve)=>setTimeout(resolve,0));expect(await api.telemetryStatus()).toMatchObject({pending:1});expect((await api.telemetryStatus()).unavailable).toBeUndefined();
  });

});
