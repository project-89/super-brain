import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const telemetryRoot = join(mkdtempSync(join(tmpdir(), "mcp-telemetry-")), "state");

const mocks = vi.hoisted(() => ({ registerTool: vi.fn(), identityPage: vi.fn(), rankMemories: vi.fn(), askReasoning: vi.fn(), recallMemoryPacket: vi.fn() }));
vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({ McpServer: class { registerTool = mocks.registerTool; connect = vi.fn().mockResolvedValue(undefined); close = vi.fn().mockResolvedValue(undefined); } }));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({ StdioServerTransport: class {} }));
vi.mock("@_89/super-brain-client", () => ({
  SuperBrainApiError: class extends Error { code = "mock"; },
  SuperBrainClient: class { identityPage = mocks.identityPage; rankMemories = mocks.rankMemories; askReasoning = mocks.askReasoning; recallMemoryPacket = mocks.recallMemoryPacket; },
}));

const provenance = { version: 1, recallId: "recall", subject: { principalId: "p", organizationId: "o", workspaceId: "workspace-a" }, observedAt: "2026-01-01T00:00:00.000Z", operation: "search", ranking: { id: "r", kind: "lexical" }, items: [] };
const extra = () => ({ signal: new AbortController().signal });

async function tools(defaults?: string) {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv("SUPER_BRAIN_URL", "http://localhost:3003");
  vi.stubEnv("SUPER_BRAIN_WORKSPACE", "workspace-a");
  vi.stubEnv("SUPER_BRAIN_TOKEN", "test-token");
  vi.stubEnv("SUPER_BRAIN_HARNESS", "hermes");
  vi.stubEnv("SUPER_BRAIN_TELEMETRY_STATE_ROOT", telemetryRoot);
  vi.stubEnv("SUPER_BRAIN_PROJECT_IDS", defaults);
  vi.stubEnv("SUPER_BRAIN_CAPTURE_URL", undefined);
  mocks.identityPage.mockResolvedValue({ items: [{ id: "project-a" }], total: 1, scope: { workspaceId: "workspace-a" } });
  mocks.rankMemories.mockResolvedValue({ memories: [], provenance });
  mocks.recallMemoryPacket.mockResolvedValue({ memories: [], provenance });
  mocks.askReasoning.mockResolvedValue({ answer: "No answer", citations: [] });
  await import("../src/main.js");
  return (name: string) => {
    const registration = mocks.registerTool.mock.calls.find(([registered]) => registered === name)!;
    const invoke = registration[2] as (input: Record<string, unknown>, extra: { signal: AbortSignal }) => Promise<{ content: { text: string }[] }>;
    return { schema: z.object((registration[1] as { inputSchema: z.ZodRawShape }).inputSchema), invoke: (input: Record<string, unknown>) => invoke(input, extra()) };
  };
}

describe("MCP recall tool scope enforcement", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("does not invoke retrieval or a model when scope is absent", async () => {
    const get = await tools();
    await expect(get("super_brain_search").invoke({ query: "deployment", limit: 8 })).rejects.toThrow("Project context is required");
    await expect(get("super_brain_context").invoke({ limit: 5 })).rejects.toThrow("Project context is required");
    await expect(get("super_brain_ask").invoke({ question: "What next?", limit: 5 })).rejects.toThrow("Project context is required");
    expect(mocks.rankMemories).not.toHaveBeenCalled();
    expect(mocks.recallMemoryPacket).not.toHaveBeenCalled();
    expect(mocks.askReasoning).not.toHaveBeenCalled();
    expect(mocks.identityPage).not.toHaveBeenCalled();
  });
  it("offers bounded authorized project discovery with names, original IDs, canonical IDs, and cursors", async () => {
    const get = await tools();
    const discover = get("super_brain_projects");
    mocks.identityPage.mockResolvedValueOnce({ items: [{ id: "project-a", name: "Readable project", canonicalProjectId: "canonical-a" }], total: 101, nextCursor: "next", scope: { workspaceId: "workspace-a" } });
    const result = await discover.invoke(discover.schema.parse({ cursor: "previous", limit: 100 }));
    expect(mocks.identityPage).toHaveBeenCalledWith("projects", { limit: 100, cursor: "previous" });
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ items: [{ id: "project-a", name: "Readable project", canonicalProjectId: "canonical-a" }], nextCursor: "next" });
    expect(discover.schema.safeParse({ limit: 101 }).success).toBe(false);
    mocks.identityPage.mockRejectedValueOnce(new Error("403 denied"));
    await expect(discover.invoke(discover.schema.parse({}))).rejects.toThrow("403 denied");
    expect(mocks.rankMemories).not.toHaveBeenCalled();
  });
  it("requires nonempty tool arrays and passes verified explicit IDs without widening", async () => {
    const get = await tools();
    const search = get("super_brain_search");
    expect(search.schema.safeParse({ query: "deployment", projectIds: [] }).success).toBe(false);
    const result = await search.invoke(search.schema.parse({ query: "deployment", projectIds: ["project-a"] }));
    expect(mocks.identityPage).toHaveBeenCalledWith("projects", { limit: 100 });
    expect(mocks.rankMemories).toHaveBeenCalledWith({ query: "deployment", limit: 8, projectIds: ["project-a"] }, expect.anything());
    expect(JSON.parse(result.content[0]!.text).retrievalScope).toEqual({ kind: "project", source: "explicit", projectIds: ["project-a"] });
    await expect(search.invoke(search.schema.parse({ query: "deployment", projectIds: ["unknown"] }))).rejects.toThrow("unavailable");
    expect(mocks.rankMemories).toHaveBeenCalledTimes(1);
  });
  it("checks configured scope before reasoning on every invocation", async () => {
    const get = await tools('["project-a"]');
    const ask = get("super_brain_ask");
    await ask.invoke(ask.schema.parse({ question: "What next?" }));
    expect(mocks.askReasoning).toHaveBeenCalledWith({ question: "What next?", limit: 5, projectIds: ["project-a"] }, expect.anything());
    mocks.identityPage.mockRejectedValueOnce(new Error("403 denied"));
    await expect(ask.invoke(ask.schema.parse({ question: "Again?" }))).rejects.toThrow("403 denied");
    expect(mocks.askReasoning).toHaveBeenCalledTimes(1);
    expect(mocks.identityPage).toHaveBeenCalledTimes(2);
    const context = get("super_brain_context");
    const packet = await context.invoke(context.schema.parse({}));
    expect(mocks.recallMemoryPacket).toHaveBeenCalledWith({ limit: 5, projectIds: ["project-a"] }, expect.anything());
    expect(JSON.parse(packet.content[0]!.text).retrievalScope).toEqual({ kind: "project", source: "configured", projectIds: ["project-a"] });
  });
  it("permits only explicit broader discovery to omit project filters", async () => {
    const get = await tools('["project-a"]');
    const ask = get("super_brain_ask");
    const result = await ask.invoke(ask.schema.parse({ question: "Organization status?", broaderDiscovery: true }));
    expect(mocks.askReasoning).toHaveBeenCalledWith({ question: "Organization status?", limit: 5 }, expect.anything());
    expect(mocks.identityPage).not.toHaveBeenCalled();
    expect(JSON.parse(result.content[0]!.text).retrievalScope).toEqual({ kind: "broader-discovery", source: "explicit" });
    await expect(ask.invoke({ question: "Bad mode", limit: 5, projectIds: ["project-a"], broaderDiscovery: true })).rejects.toThrow("not both");
    expect(mocks.askReasoning).toHaveBeenCalledTimes(1);
  });
});
