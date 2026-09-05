import { describe, expect, it } from "vitest";
import { MEMORY_A, apiEvent, apiRequest, startApi } from "./helpers.js";
const path = "/v1/workspaces/workspace-1";
const stamp = (id: string, t: number) => ({ id, t, worldDate: "2026-09-05" });

describe("memory validity HTTP contract", () => {
  it("derives identity, accepts attributed shared corrections, and returns exact reasoning revisions", async () => {
    const api = await startApi();
    try {
      expect(await apiRequest(api.baseUrl, `${path}/identity`, { token: "token-a" })).toMatchObject({ status: 200, body: { principalId: "user-a", workspaceId: "workspace-1" } });
      expect((await apiRequest(api.baseUrl, `${path}/memories`, { token: "token-b", method: "POST", body: { stamp: stamp("shared", 10), input: { id: MEMORY_A, source: "review", audience: "workspace", applicability: { kind: "global" }, summary: "Store events in Postgres" } } })).status).toBe(201);
      const corrected = await apiRequest(api.baseUrl, `${path}/memories/${MEMORY_A}`, { token: "token-a", method: "PATCH", body: { stamp: stamp("correction", 11), patch: { summary: "Use durable PostgreSQL commands" } } });
      expect(corrected).toMatchObject({ status: 200, body: { memory: { creatorId: "user-b", revision: 1 }, event: { capture: { identity: { principal: "user-a" } } } } });
      const request = { question: "Which event store?", memoryRefs: [{ memoryId: MEMORY_A, revision: 1 }] };
      expect(await apiRequest(api.baseUrl, `${path}/reasoning/ask`, { token: "token-a", method: "POST", body: request })).toMatchObject({ status: 200, body: { citationRefs: request.memoryRefs } });
      expect((await apiRequest(api.baseUrl, `${path}/reasoning/ask`, { token: "token-a", method: "POST", body: { ...request, memoryRefs: [{ memoryId: MEMORY_A, revision: 0 }] } })).status).toBe(409);
      expect((await apiRequest(api.baseUrl, `${path}/memories`, { token: "token-a" })).body.memories).toHaveLength(1);
    } finally { await api.close(); }
  });

  it("validates support relation, bounded exact evidence pages, and immutable retry bodies", async () => {
    const api = await startApi();
    try {
      await apiRequest(api.baseUrl, `${path}/events`, { token: "token-a", method: "POST", body: { event: apiEvent({ id: "check", t: 1 }) } });
      await apiRequest(api.baseUrl, `${path}/events`, { token: "token-b", method: "POST", body: { event: apiEvent({ id: "private-check", t: 1.5, principalId: "user-b", creatorId: "user-b" }) } });
      const resolved = await apiRequest(api.baseUrl, `${path}/events?eventId=check&eventId=private-check&eventId=missing`, { token: "token-a" });
      expect(resolved.body.entries.map(({ event }: { event: { id: string } }) => event.id)).toEqual(["check"]);
      await apiRequest(api.baseUrl, `${path}/memories`, { token: "token-b", method: "POST", body: { stamp: stamp("record", 2), input: { id: MEMORY_A, source: "review", audience: "workspace", applicability: { kind: "global" } } } });
      const body = { stamp: stamp("opposition", 3), input: { evidence: [{ eventId: "check", relation: "opposes" }], expectedRevision: 0 } };
      const first = await apiRequest(api.baseUrl, `${path}/memories/${MEMORY_A}/evidence`, { token: "token-a", method: "POST", body });
      expect(first).toMatchObject({ status: 201, body: { memory: { revision: 1, creatorId: "user-b", currentness: { status: "needs-review" } } } });
      expect((await apiRequest(api.baseUrl, `${path}/memories/${MEMORY_A}/evidence`, { token: "token-a", method: "POST", body })).body).toEqual(first.body);
      expect((await apiRequest(api.baseUrl, `${path}/memories/${MEMORY_A}/evidence`, { token: "token-a", method: "POST", body: { ...body, input: { evidence: [{ eventId: "check", relation: "supports" }] } } })).status).toBe(409);
      expect(await apiRequest(api.baseUrl, `${path}/memories/${MEMORY_A}/evidence?revision=0`, { token: "token-a" })).toMatchObject({ status: 200, body: { revision: 0, evidence: [], total: 0 } });
      expect((await apiRequest(api.baseUrl, `${path}/memories`, { token: "token-a" })).body.memories).toEqual([]);
      expect((await apiRequest(api.baseUrl, `${path}/memories?includeNeedsReview=true`, { token: "token-a" })).body.memories).toHaveLength(1);
      expect((await apiRequest(api.baseUrl, `${path}/memories/${MEMORY_A}/evidence`, { token: "token-a", method: "POST", body: { stamp: stamp("oversized", 4), input: { evidence: Array.from({ length: 101 }, () => ({ eventId: "check" })) } } })).status).toBe(400);
    } finally { await api.close(); }
  });
});
