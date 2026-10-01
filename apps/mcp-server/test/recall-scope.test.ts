import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const mocks = vi.hoisted(() => ({ registerTool: vi.fn(), identityPage: vi.fn(), rankMemories: vi.fn(), askReasoning: vi.fn() }));
vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({ McpServer: class { registerTool = mocks.registerTool; connect = vi.fn().mockResolvedValue(undefined); } }));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({ StdioServerTransport: class {} }));
vi.mock("@_89/super-brain-client", () => ({ SuperBrainClient: class { identityPage = mocks.identityPage; rankMemories = mocks.rankMemories; askReasoning = mocks.askReasoning; } }));

async function tools(defaults?: string) {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv("SUPER_BRAIN_URL", "http://localhost:3003");
  vi.stubEnv("SUPER_BRAIN_WORKSPACE", "workspace-a");
  vi.stubEnv("SUPER_BRAIN_TOKEN", "test-token");
  vi.stubEnv("SUPER_BRAIN_HARNESS", "hermes");
  vi.stubEnv("SUPER_BRAIN_PROJECT_IDS", defaults);
  vi.stubEnv("SUPER_BRAIN_CAPTURE_URL", undefined);
  mocks.identityPage.mockResolvedValue({ items: [{ id: "project-a" }], total: 1, scope: { workspaceId: "workspace-a" } });
  mocks.rankMemories.mockResolvedValue({ memories: [] });
  mocks.askReasoning.mockResolvedValue({ answer: "No answer", citations: [] });
  await import("../src/main.js");
  return (name: string) => {
    const registration = mocks.registerTool.mock.calls.find(([registered]) => registered === name)!;
    return { schema: z.object((registration[1] as { inputSchema: z.ZodRawShape }).inputSchema), invoke: registration[2] as (input: Record<string, unknown>) => Promise<{ content: { text: string }[] }> };
  };
}

describe("MCP recall tool scope enforcement", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("does not invoke retrieval or a model when scope is absent", async () => {
    const get = await tools();
    await expect(get("super_brain_search").invoke({ query: "deployment", limit: 8 })).rejects.toThrow("Project context is required");
    await expect(get("super_brain_context").invoke({ question: "What next?", limit: 5 })).rejects.toThrow("Project context is required");
    expect(mocks.rankMemories).not.toHaveBeenCalled();
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
    expect(mocks.rankMemories).toHaveBeenCalledWith({ query: "deployment", limit: 8, projectIds: ["project-a"] });
    expect(JSON.parse(result.content[0]!.text).retrievalScope).toEqual({ kind: "project", source: "explicit", projectIds: ["project-a"] });
  });
  it("checks configured scope before context on every invocation", async () => {
    const get = await tools('["project-a"]');
    const context = get("super_brain_context");
    await context.invoke(context.schema.parse({ question: "What next?" }));
    expect(mocks.askReasoning).toHaveBeenCalledWith({ question: "What next?", limit: 5, projectIds: ["project-a"] });
    mocks.identityPage.mockRejectedValueOnce(new Error("403 denied"));
    await expect(context.invoke(context.schema.parse({ question: "Again?" }))).rejects.toThrow("403 denied");
    expect(mocks.askReasoning).toHaveBeenCalledTimes(1);
    expect(mocks.identityPage).toHaveBeenCalledTimes(2);
  });
  it("permits only explicit broader discovery to omit project filters", async () => {
    const get = await tools('["project-a"]');
    const context = get("super_brain_context");
    const result = await context.invoke(context.schema.parse({ question: "Organization status?", broaderDiscovery: true }));
    expect(mocks.askReasoning).toHaveBeenCalledWith({ question: "Organization status?", limit: 5 });
    expect(mocks.identityPage).not.toHaveBeenCalled();
    expect(JSON.parse(result.content[0]!.text).retrievalScope).toEqual({ kind: "broader-discovery", source: "explicit" });
    await expect(context.invoke({ question: "Bad mode", projectIds: ["project-a"], broaderDiscovery: true })).rejects.toThrow("not both");
    expect(mocks.askReasoning).toHaveBeenCalledTimes(1);
  });
});
