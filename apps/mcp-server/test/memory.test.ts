import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const mocks = vi.hoisted(() => ({ registerTool: vi.fn(), proposeMemoryCandidate: vi.fn().mockResolvedValue({}) }));

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: class {
    registerTool = mocks.registerTool;
    connect = vi.fn().mockResolvedValue(undefined);
  },
}));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({ StdioServerTransport: class {} }));
vi.mock("@_89/super-brain-client", () => ({
  SuperBrainClient: class { proposeMemoryCandidate = mocks.proposeMemoryCandidate; },
}));

describe("MCP memory applicability contract", () => {
  beforeAll(async () => {
    vi.stubEnv("SUPER_BRAIN_URL", "http://localhost:3003");
    vi.stubEnv("SUPER_BRAIN_WORKSPACE", "workspace-a");
    vi.stubEnv("SUPER_BRAIN_TOKEN", "test-token");
    vi.stubEnv("SUPER_BRAIN_HARNESS", "hermes");
    await import("../src/main.js");
  });
  afterAll(() => vi.unstubAllEnvs());

  function proposalTool() {
    const registration = mocks.registerTool.mock.calls.find(([name]) => name === "super_brain_propose_memory")!;
    return {
      config: registration[1] as { description: string; inputSchema: z.ZodRawShape },
      invoke: registration[2] as (input: Record<string, unknown>) => Promise<unknown>,
    };
  }

  it("preserves explicit general intent and describes its authorization boundary", async () => {
    const { config, invoke } = proposalTool();
    expect(config.description).toContain("authorized workspace");
    expect(config.description).toContain("not general");
    const input = z.object(config.inputSchema).parse({ summary: "Tool procedure", content: "Verify the result", evidenceEventIds: ["event-a"], applicability: "general" });
    await invoke(input);
    expect(mocks.proposeMemoryCandidate).toHaveBeenLastCalledWith(expect.objectContaining({ applicability: "general", projectIds: [] }));
  });

  it("does not silently label unassigned legacy proposals as general", async () => {
    const { config, invoke } = proposalTool();
    const input = z.object(config.inputSchema).parse({ summary: "Observation", content: "Needs review", evidenceEventIds: ["event-a"] });
    await invoke(input);
    expect(mocks.proposeMemoryCandidate.mock.calls.at(-1)?.[0]).not.toHaveProperty("applicability");
    expect(z.object(config.inputSchema).safeParse({ ...input, applicability: "organization" }).success).toBe(false);
  });
});
