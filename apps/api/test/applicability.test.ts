import { describe, expect, it } from "vitest";
import type { FoldSdkRegistry } from "../src/index.js";
import { apiRequest, MemorySdkRegistry, startApi } from "./helpers.js";

const path = "/v1/workspaces/workspace-1";
const id = (index: number) => `01890f47-7c00-7000-8000-${String(index + 1).padStart(12, "0")}`;
const stamp = (index: number) => ({ id: `event-${index}`, t: 100 + index, worldDate: "2026-09-14" });
const pairs = [
  { applicability: "project", projectIds: ["a"] },
  { applicability: "general", projectIds: [] },
  { projectIds: [] },
  { applicability: "unresolved", projectIds: [] },
  { applicability: "project", projectIds: ["b"] },
];

describe("memory applicability HTTP contract", () => {
  it.each([false, true])("filters candidates before pagination with registry projection=%s", async (stored) => {
    const registry = new MemorySdkRegistry();
    const projected: FoldSdkRegistry = {
      sdkFor: registry.sdkFor.bind(registry),
      ...(stored ? { memoryCandidates: async (...args: Parameters<NonNullable<FoldSdkRegistry["memoryCandidates"]>>) => (await registry.sdkFor(args[0])).memoryCandidates(args[1]) } : {}),
    };
    const api = await startApi({ sdks: projected });
    const get = (url: string) => apiRequest(api.baseUrl, `${path}${url}`, { token: "token-a" });
    try {
      for (const [index, pair] of pairs.entries()) {
        const result = await apiRequest(api.baseUrl, `${path}/memory-candidates`, {
          method: "POST", token: "token-a", body: {
            stamp: stamp(index), input: { id: id(index), source: "test", summary: "Useful procedure", content: null, ...pair,
              evidence: [{ eventId: "source" }], confidence: 0.8, salience: 0.8, extractor: { kind: "rule", id: "test", version: "1" } },
          },
        });
        expect(result.status).toBe(201);
      }
      const first = await get("/memory-candidates?projectId=a&limit=1");
      expect(first.body).toMatchObject({ total: 2, candidates: [{ candidate: { id: id(1), applicability: "general" } }] });
      const second = await get(`/memory-candidates?projectId=a&limit=1&pageCursor=${encodeURIComponent(first.body.nextCursor)}`);
      expect(second.body.candidates.map((view: any) => view.candidate.id)).toEqual([id(0)]);
      expect(second.body.nextCursor).toBeUndefined();
      expect((await get("/memory-candidates")).body.total).toBe(5);
      expect((await get("/memory-candidates?projectId=a&offset=1&limit=1")).body.candidates[0].candidate.id).toBe(id(0));
    } finally { await api.close(); }
  });

  it("filters recall, ranking and explicit reasoning; supports auditable reclassification without changing ownership", async () => {
    const api = await startApi();
    const request = (suffix: string, method = "GET", body?: unknown, token = "token-a") => apiRequest(api.baseUrl, path + suffix, { method, token, ...(body === undefined ? {} : { body }) });
    try {
      for (const [index, pair] of pairs.entries()) {
        expect((await request("/memories", "POST", { stamp: stamp(index), input: { id: id(index), source: "test", summary: "Useful procedure", ...pair } })).status).toBe(201);
      }
      expect((await request("/memories")).body.memories).toHaveLength(5);
      const first = await request("/memories?projectId=a&limit=1");
      expect(first.body.memories.map((view: any) => view.memory.id)).toEqual([id(1)]);
      const second = await request(`/memories?projectId=a&limit=1&pageCursor=${encodeURIComponent(first.body.nextCursor)}`);
      expect(second.body.memories.map((view: any) => view.memory.id)).toEqual([id(0)]);
      const recalled = await request("/memories/recall", "POST", { projectIds: ["a"], candidates: pairs.map((_, index) => ({ memoryId: id(index), score: 1 })) });
      expect(recalled.body.memories.map((view: any) => view.memory.id)).toEqual([id(1), id(0)]);
      const ranked = await request("/memories/search", "POST", { projectIds: ["a"], query: "Useful procedure" });
      expect(ranked.status).toBe(200);
      expect(ranked.body.memories.map((view: any) => view.memory.id).sort()).toEqual([id(0), id(1)]);
      for (const index of [2, 3, 4]) {
        expect((await request("/reasoning/ask", "POST", { question: "Use evidence", projectIds: ["a"], memoryIds: [id(index)] })).status).toBe(404);
      }
      expect((await request("/reasoning/ask", "POST", { question: "Use evidence", projectIds: ["a"], memoryIds: [id(1)] })).status).toBe(200);
      expect((await request("/reasoning/ask", "POST", { question: "Use evidence", projectIds: ["a"], memoryIds: [id(1)] }, "token-b")).status).toBe(404);
      const changed = await request(`/memories/${id(2)}`, "PATCH", { stamp: stamp(20), patch: { applicability: "project", projectIds: [" a ", "a"] } });
      expect(changed).toMatchObject({ status: 200, body: { memory: { applicability: "project", projectIds: ["a"], revision: 1, creatorId: "user-a" } } });
      expect((await request(`/memories/${id(2)}`, "PATCH", { stamp: stamp(21), patch: { applicability: "general" } })).status).toBe(400);
      expect((await request(`/memories/${id(2)}`, "PATCH", { stamp: stamp(22), patch: { applicability: "general", projectIds: [] } })).status).toBe(200);
      expect((await request(`/memories/${id(2)}`, "PATCH", { stamp: stamp(23), patch: { applicability: "unresolved" } }, "token-b")).status).toBe(404);
    } finally { await api.close(); }
  });

  it("rejects unknown applicability and invalid project pairs on memory and candidate writes", async () => {
    const api = await startApi();
    try {
      let index = 0;
      for (const pair of [{ applicability: "bogus" }, { applicability: null }, { applicability: "project", projectIds: [] }, { applicability: "general", projectIds: ["a"] }, { applicability: "unresolved", projectIds: ["a"] }]) {
        for (const resource of ["memories", "memory-candidates"]) {
          const result = await apiRequest(api.baseUrl, `${path}/${resource}`, { method: "POST", token: "token-a", body: {
            stamp: stamp(index++), input: { id: id(0), source: "test", summary: "Test", content: null, ...pair,
              ...(resource === "memories" ? {} : { evidence: [{ eventId: "source" }], confidence: 0.8, salience: 0.8, extractor: { kind: "rule", id: "test", version: "1" } }) },
          } });
          expect(result.status).toBe(400);
        }
      }
    } finally { await api.close(); }
  });

  it("enforces the full recall filter contract on explicit reasoning evidence without changing requested order", async () => {
    const api = await startApi();
    const request = (suffix: string, body: unknown) => apiRequest(api.baseUrl, path + suffix, { method: "POST", token: "token-a", body });
    try {
      for (const index of [0, 1]) {
        expect((await request("/memories", { stamp: stamp(index), input: {
          id: id(index), source: "test", summary: "Useful evidence", applicability: "general", tags: ["checked"],
          ...(index === 0 ? { spaceId: "space-a" } : {}),
        } })).status).toBe(201);
      }
      for (const filters of [{ scope: { kind: "workspace" } }, { tags: ["absent"] }, { sources: ["other"] }, { from: 101 }, { to: 99 }]) {
        expect((await request("/reasoning/ask", { question: "Use evidence", memoryIds: [id(0)], ...filters })).status).toBe(404);
      }
      const result = await request("/reasoning/ask", {
        question: "Use evidence", memoryIds: [id(0), id(1)], projectIds: ["any"], tags: ["checked"], sources: ["test"], from: 100, to: 101, limit: 1,
      });
      expect(result.status).toBe(200);
      expect(result.body.evidence.map((item: any) => item.memoryId)).toEqual([id(0), id(1)]);
    } finally { await api.close(); }
  });
});
