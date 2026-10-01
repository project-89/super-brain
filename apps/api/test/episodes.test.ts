import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { makeTranscriptProjectEvent, makeTranscriptArtifactEvent, makeTranscriptRunEvent } from "@_89/fold-transcript";
import type { EpisodeWindowInput } from "@_89/fold-epistemic";
import { PostgresSdkRegistry } from "../src/index.js";
import { ReasoningProviderError } from "../src/reasoning.js";
import { access, apiRequest, MemorySdkRegistry, startApi, MEMORY_A } from "./helpers.js";

async function seed(registry: MemorySdkRegistry | PostgresSdkRegistry) {
  const tenant = { organizationId: "local", workspaceId: "workspace-1" }; const acl = access({ organizationId: "local" });
  const sdk = await registry.sdkFor(tenant);
  const author = { kind: "human" as const, id: "user-a" };
  const stamp = (id: string, t: number) => ({ id, t, worldDate: "2026-09-15" });
  await sdk.append(acl, makeTranscriptProjectEvent({ author: { kind: "ingest", id: "import" }, capture: { scope: { workspace: tenant.workspaceId }, identity: { source: "codex" } } }, stamp("project", 1), { id: "project-a", name: "Project A", identityKeyHash: "a".repeat(64), resolution: "resolved", roots: ["/project-a"] }));
  const transcriptContext = { author: { kind: "ingest" as const, id: "import" }, capture: { scope: { workspace: tenant.workspaceId }, identity: { source: "codex" } } };
  await sdk.append(acl, makeTranscriptArtifactEvent(transcriptContext, stamp("artifact-event", 2), { id: "artifact", source: "codex", sha256: "b".repeat(64), sourcePathHash: "c".repeat(64), byteLength: 100, mediaType: "application/jsonl", parser: { id: "test", version: "1" }, contentPolicy: "metadata-only", stored: false, redactionCount: 0 }));
  await sdk.append(acl, makeTranscriptRunEvent(transcriptContext, stamp("run-event", 3), { id: "run", nativeId: "native-run", source: "codex", artifactId: "artifact", projectId: "project-a", projectResolution: "resolved", counts: { records: 1, turns: 0, messages: 0, actions: 0, unknown: 1 }, segments: [] }));
  await sdk.recordMemory({ access: acl, author, capture: { scope: { workspace: acl.workspaceId }, identity: { principal: acl.principalId, workspace: acl.workspaceId } } }, stamp("evidence", 4), { id: MEMORY_A, source: "test", audience: "workspace", projectIds: ["project-a"], summary: "Test passed", content: { outcome: "pass" } });
  const prepared = await sdk.episodeSources(acl, ["evidence"], { projectId: "project-a", audience: "workspace" });
  const claim = { text: "Test passed", citations: [{ eventId: "evidence" }] };
  const input: EpisodeWindowInput = { schemaVersion: 1, windowId: "window", projectId: "project-a", audience: "workspace", sources: prepared.sources, trigger: "completion", producer: { id: "fixture", version: "1" },
    episodes: [{ episodeId: "episode", previousRevision: null, title: "Run tests", objective: claim, summary: claim, decisions: [], blockers: [], checks: [claim], openQuestions: [], memberEventIds: ["evidence"], grouping: { reason: claim, confidence: "medium", uncertainties: [] }, continuations: [] }], ungrouped: [] };
  return { sdk, acl, input, tenant };
}

describe("episode publication routes", () => {
  it("preserves safe provider failure diagnostics through HTTP without source text", async () => {
    const registry = new MemorySdkRegistry(); await seed(registry);
    const api = await startApi({ sdks: registry, reasoner: { descriptor: { id: "test", kind: "model" }, answer: vi.fn(), structured: async () => { throw new ReasoningProviderError("http_error", "provider private response must not leak", 400); } } });
    try {
      const result = await apiRequest(api.baseUrl, "/v1/workspaces/workspace-1/work-episodes/synthesize", { token: "token-a", method: "POST", body: { windowId: "diagnostic-window", sourceEventIds: ["evidence"], projectId: "project-a", audience: "workspace", trigger: "manual" } });
      expect(result).toMatchObject({ status: 502, body: { error: { code: "episode_output_invalid", details: { stage: "provider_transport", reason: "http_error", httpStatus: 400 } } } });
      expect(JSON.stringify(result.body)).not.toContain("private response");
    } finally { await api.close(); }
  });
  it("publishes, retries, paginates inspectable evidence and fails closed on source revision", async () => {
    const registry = new MemorySdkRegistry(); const { sdk, acl, input } = await seed(registry);
    const api = await startApi({ sdks: registry }); const base = "/v1/workspaces/workspace-1/work-episodes";
    try {
      const posted = await apiRequest(api.baseUrl, `${base}/windows`, { token: "token-a", method: "POST", body: input });
      expect(posted.status).toBe(201);
      expect((await apiRequest(api.baseUrl, base, { token: "token-a" })).body).toMatchObject({ total: 1, coverage: "authorized-current-only", items: [{ title: "Run tests", projectName: "Project A", status: "proposed" }] });
      expect((await apiRequest(api.baseUrl, `${base}/episode/sources`, { token: "token-a" })).body.items[0]).toMatchObject({ eventId: "evidence", quality: "memory-derived", event: { id: "evidence" }, memory: { summary: "Test passed" } });
      expect((await apiRequest(api.baseUrl, `${base}/episode/sources?eventId=unrelated`, { token: "token-a" })).status).toBe(404);
      expect((await apiRequest(api.baseUrl, `${base}/episode/sources?limit=2`, { token: "token-a" })).status).toBe(400);
      expect((await apiRequest(api.baseUrl, `${base}/episode/sources?eventId=evidence&revision=old`, { token: "token-a" })).status).toBe(409);
      const original = sdk.episodeSources.bind(sdk);
      const changed = vi.spyOn(sdk, "episodeSources").mockImplementation(async (...args) => { const result = await original(...args); return { ...result, sources: result.sources.map(source => ({ ...source, sha256: "f".repeat(64) })) }; });
      expect((await apiRequest(api.baseUrl, `${base}/episode/sources`, { token: "token-a" })).status).toBe(409);
      changed.mockRestore();
      expect((await apiRequest(api.baseUrl, "/v1/workspaces/workspace-1/work-episode-windows/window/sources", { token: "token-a" })).status).toBe(200);
      expect((await apiRequest(api.baseUrl, `${base}/episode/extraneous`, { token: "token-a" })).status).toBe(404);
      expect((await apiRequest(api.baseUrl, `${base}?limit=1001`, { token: "token-a" })).status).toBe(400);
      expect((await apiRequest(api.baseUrl, `${base}/windows`, { token: "token-a", method: "POST", body: { ...input, trigger: "manual" } })).status).toBe(409);
      await sdk.forgetMemory({ access: acl, author: { kind: "human", id: "user-a" }, capture: { scope: { workspace: acl.workspaceId }, identity: { principal: acl.principalId, workspace: acl.workspaceId } } }, { id: "forget", t: Date.now() + 1000, worldDate: "2026-09-15" }, MEMORY_A, "Source removed");
      expect((await apiRequest(api.baseUrl, `${base}/episode`, { token: "token-a" })).status).toBe(404);
      expect((await apiRequest(api.baseUrl, base, { token: "token-a" })).body.total).toBe(0);
    } finally { await api.close(); }
  });
});

const connectionString = process.env.FOLD_TEST_DATABASE_URL;
(connectionString === undefined ? describe.skip : describe)("episode publication PostgreSQL concurrency", () => {
  it("serializes independent writers and validates source/CAS under the append lock", async () => {
    const schema = `episodes_${randomUUID().replaceAll("-", "")}`; const pool = new Pool({ connectionString });
    const first = new PostgresSdkRegistry({ connectionString: connectionString!, schema });
    const second = new PostgresSdkRegistry({ connectionString: connectionString!, schema });
    try {
      const { sdk, acl, input, tenant } = await seed(first);
      const initial = await sdk.publishEpisodeWindow({ access: acl, author: { kind: "human", id: "user-a" } }, input);
      const api = await startApi({ sdks: first });
      try {
        for (const route of ["work-episodes", "work-episode-windows", "work-episodes/episode", "work-episodes/episode/sources"]) {
          const result = await apiRequest(api.baseUrl, `/v1/workspaces/workspace-1/${route}`, { token: "token-a" });
          expect(result.status, JSON.stringify(result.body)).toBe(200);
        }
      } finally { await api.close(); }
      const other = await second.sdkFor(tenant, { kinds: ["work.episode-window-recorded", "transcript.project-recorded", "transcript.run-imported", "memory.recorded", "memory.revised", "memory.forgotten"] });
      const updated = { ...input, windowId: "update-a", episodes: [{ ...input.episodes[0]!, previousRevision: initial.revision }] };
      const outcomes = await Promise.allSettled([sdk.publishEpisodeWindow({ access: acl, author: { kind: "human", id: "user-a" } }, updated), other.publishEpisodeWindow({ access: acl, author: { kind: "human", id: "user-a" } }, { ...updated, windowId: "update-b" })]);
      expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
      expect(outcomes.filter(result => result.status === "rejected")).toHaveLength(1);
      expect(await other.episodeHistory(acl, "episode")).toHaveLength(2);
      expect(await other.workEpisodes({ ...acl, workspaceId: "other" })).toEqual([]);
      const privateId = "01890f47-7c02-7000-8000-000000000003";
      await sdk.recordMemory({ access: acl, author: { kind: "human", id: "user-a" }, capture: { scope: { workspace: acl.workspaceId, creator: acl.principalId }, identity: { principal: acl.principalId, workspace: acl.workspaceId } } }, { id: "private-evidence", t: Date.now() + 1000, worldDate: "2026-09-15" }, { id: privateId, source: "test", projectIds: ["project-a"], summary: "Private task" });
      const personal = { projectId: "project-a", audience: "personal" as const };
      const prepared = await sdk.episodeSources(acl, ["private-evidence"], personal);
      const claim = { text: "Private task", citations: [{ eventId: "private-evidence" }] };
      await sdk.publishEpisodeWindow({ access: acl, author: { kind: "agent", id: "separate-author" } }, { ...input, ...personal, windowId: "private-window", sources: prepared.sources, episodes: [{ ...input.episodes[0]!, episodeId: "private-episode", objective: claim, summary: claim, checks: [], grouping: { reason: claim, confidence: "low", uncertainties: [] }, memberEventIds: ["private-evidence"] }] });
      const outsider = { access: { ...acl, principalId: "user-b" }, author: { kind: "human" as const, id: "user-b" } };
      await expect(other.publishEpisodeWindow(outsider, { ...input, windowId: "collision", episodes: [{ ...input.episodes[0]!, episodeId: "private-episode" }] })).rejects.toThrow(/identity conflicts/);
      await expect(other.publishEpisodeWindow(outsider, { ...input, windowId: "private-window", episodes: [{ ...input.episodes[0]!, episodeId: "new-episode" }] })).rejects.toThrow(/identity conflicts/);
      expect(await sdk.workEpisodes(acl)).toHaveLength(2);
    } finally { await first.close(); await second.close(); await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await pool.end(); }
  });
});
