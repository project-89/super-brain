import { randomUUID } from "node:crypto";
import type { FoldLogEntry } from "@_89/fold";
import { FoldSdk } from "@_89/fold-sdk";
import { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { PostgresSdkRegistry, type FoldSdkRegistry } from "../src/index.js";
import { apiEvent, apiRequest, MEMORY_A, startApi } from "./helpers.js";

// Project-scoped evidence must come from an event captured in that project.
const inProject = (event: ReturnType<typeof apiEvent>) => ({ ...event, capture: { ...event.capture, identity: { ...event.capture.identity, project: "project-a" } } });

async function exercise(registry: FoldSdkRegistry) {
  const api = await startApi({ sdks: registry });
  const path = "/v1/workspaces/workspace-1";
  const stamp = (id: string, t: number) => ({ id, t, worldDate: "2026-09-15" });
  try {
    for (const [index, id] of ["source-one", "source-two", "private-source"].entries()) {
      const result = await apiRequest(api.baseUrl, `${path}/events`, { method: "POST", token: "token-a",
        body: { event: inProject(apiEvent({ id, t: index + 1, kind: "workflow.observation", ...(id === "private-source" ? { creatorId: "user-a" } : {}) })) } });
      expect(result.status).toBe(201);
    }
    const input = { id: MEMORY_A, audience: "workspace", source: "workflow", projectIds: ["project-a"],
      summary: "Verify durable workflow state", content: { step: "verify" }, evidence: [{ eventId: "source-one", projectId: "project-a" }],
      confidence: 0.9, salience: 0.8, extractor: { kind: "rule", id: "test", version: "1" } };
    expect((await apiRequest(api.baseUrl, `${path}/memory-candidates`, { method: "POST", token: "token-a", body: { stamp: stamp("proposal", 10), input } })).status).toBe(201);
    // Turn references must match their cited event, so each late support reference cites its own event.
    for (let index = 0; index < 151; index += 1) {
      expect((await apiRequest(api.baseUrl, `${path}/events`, { method: "POST", token: "token-a",
        body: { event: inProject(apiEvent({ id: `source-two-${index}`, t: 4 + index / 100, kind: "workflow.observation" })) } })).status).toBe(201);
    }
    const support = { ...input, evidence: Array.from({ length: 151 }, (_, index) => ({ eventId: `source-two-${index}`, projectId: "project-a" })) };
    const added = await apiRequest(api.baseUrl, `${path}/memory-candidates/${MEMORY_A}/evidence`, { method: "POST", token: "token-a", body: { stamp: stamp("support", 20), input: support } });
    expect(added.status).toBe(200);
    expect(added.body.candidate.evidence).toHaveLength(152);
    const retried = await apiRequest(api.baseUrl, `${path}/memory-candidates/${MEMORY_A}/evidence`, { method: "POST", token: "token-a", body: { stamp: stamp("retry", 21), input: support } });
    expect(retried.status).toBe(200);
    expect(retried.body.event).toBeUndefined();
    const privateSupport = await apiRequest(api.baseUrl, `${path}/memory-candidates/${MEMORY_A}/evidence`, { method: "POST", token: "token-a", body: { stamp: stamp("private", 22), input: { ...input, evidence: [{ eventId: "private-source" }] } } });
    expect(privateSupport.status).toBeGreaterThanOrEqual(400);
    const variants = await apiRequest(api.baseUrl, `${path}/memory-candidates/${MEMORY_A}/evidence`, { method: "POST", token: "token-a", body: { stamp: stamp("variant", 23), input: { ...support, content: { step: "correction" } } } });
    expect(variants.status).toBe(409);
    const paged = await apiRequest(api.baseUrl, `${path}/memory-candidates?limit=1`, { token: "token-a" });
    expect(paged.body.candidates[0].candidate.evidence).toHaveLength(152);
    const accepted = await apiRequest(api.baseUrl, `${path}/memory-candidates/${MEMORY_A}/accept`, { method: "POST", token: "token-b",
      body: { stamp: stamp("accept", 30), memoryStamp: stamp("memory", 31), memoryId: "01890f47-7c00-7000-8000-000000000002" } });
    expect(accepted.status).toBe(201);
    expect(accepted.body.memory.evidence).toHaveLength(152);
    expect(accepted.body.decisionEvent.causedBy).toContain("support");
  } finally { await api.close(); }
}

describe("candidate evidence API", () => {
  it("reauthorizes non-memory sources for candidate support through a selection-aware registry", async () => {
    const entries: FoldLogEntry[] = [];
    const eventById = vi.fn(async (id: string) => entries.find(({ event }) => event.id === id));
    const registry: FoldSdkRegistry = { sdkFor: async (_tenant, selection) => new FoldSdk({
      read: async () => ({ entries: entries.filter(({ event }) => selection === undefined ||
        selection.kinds?.includes(event.kind) || selection.kindPrefixes?.some((prefix) => event.kind.startsWith(prefix))) }),
      append: async (entry) => { entries.push(entry); },
      appendMany: async (batch) => { entries.push(...batch); }, eventById,
    }) };
    await exercise(registry);
    // Memory writes validate cited sources at append time, so the API loads the complete authorized
    // view for them; indexed lookup is then unnecessary for sources already in that view.
  });

  it.skipIf(process.env.FOLD_TEST_DATABASE_URL === undefined)("includes support in the production PostgreSQL candidate cursor projection", async () => {
    const connectionString = process.env.FOLD_TEST_DATABASE_URL!;
    const schema = `candidate_api_${randomUUID().replaceAll("-", "")}`;
    const pool = new Pool({ connectionString });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const registry = new PostgresSdkRegistry({ connectionString, schema });
    try { await exercise(registry); }
    finally { await registry.close(); await pool.query(`DROP SCHEMA "${schema}" CASCADE`); await pool.end(); }
  });
});
