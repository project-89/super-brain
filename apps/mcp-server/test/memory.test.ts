import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const telemetryRoot = join(mkdtempSync(join(tmpdir(), "mcp-telemetry-")), "state");

const mocks = vi.hoisted(() => ({ registerTool: vi.fn(), proposeMemoryCandidate: vi.fn().mockResolvedValue({}) }));

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: class {
    registerTool = mocks.registerTool;
    connect = vi.fn().mockResolvedValue(undefined);
    close = vi.fn().mockResolvedValue(undefined);
  },
}));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({ StdioServerTransport: class {} }));
vi.mock("@_89/super-brain-client", () => ({
  SuperBrainApiError: class extends Error { code = "mock"; },
  SuperBrainClient: class { proposeMemoryCandidate = mocks.proposeMemoryCandidate; },
}));

const stamp = { id: "proposal-stamp", t: 1_760_000_000_000, worldDate: "2025-10-09" };
const extra = () => ({ signal: new AbortController().signal });

describe("MCP memory applicability contract", () => {
  beforeAll(async () => {
    vi.stubEnv("SUPER_BRAIN_URL", "http://localhost:3003");
    vi.stubEnv("SUPER_BRAIN_WORKSPACE", "workspace-a");
    vi.stubEnv("SUPER_BRAIN_TOKEN", "test-token");
    vi.stubEnv("SUPER_BRAIN_HARNESS", "hermes");
    vi.stubEnv("SUPER_BRAIN_TELEMETRY_STATE_ROOT", telemetryRoot);
    await import("../src/main.js");
  });
  afterAll(() => vi.unstubAllEnvs());

  function proposalTool() {
    const registration = mocks.registerTool.mock.calls.find(([name]) => name === "super_brain_propose_memory")!;
    return {
      config: registration[1] as { description: string; inputSchema: z.ZodRawShape },
      invoke: registration[2] as (input: Record<string, unknown>, extra: { signal: AbortSignal }) => Promise<{ content: { text: string }[] }>,
    };
  }
  const base = { stamp, summary: "Tool procedure", content: "Verify the result", evidenceEventIds: ["event-a"], confidence: 0.8, salience: 0.7 };

  it("preserves explicit general intent and describes its authorization boundary", async () => {
    const { config, invoke } = proposalTool();
    expect(config.description).toContain("authorized workspace");
    expect(config.description).toContain("not general");
    const input = z.object(config.inputSchema).parse({ ...base, applicability: "general" });
    await invoke(input, extra());
    expect(mocks.proposeMemoryCandidate).toHaveBeenLastCalledWith(expect.objectContaining({ applicability: { kind: "global" }, projectIds: [] }), undefined, expect.anything());
  });

  it("does not silently label unassigned legacy proposals as general", async () => {
    const { config, invoke } = proposalTool();
    const input = z.object(config.inputSchema).parse({ ...base, summary: "Observation", content: "Needs review" });
    await invoke(input, extra());
    expect(mocks.proposeMemoryCandidate.mock.calls.at(-1)?.[0]).toMatchObject({ applicability: { kind: "unresolved" }, projectIds: [] });
    expect(z.object(config.inputSchema).safeParse({ ...input, applicability: "organization" }).success).toBe(false);
  });

  it("rejects applicability that contradicts the supplied project IDs without proposing", async () => {
    const { config, invoke } = proposalTool();
    const calls = mocks.proposeMemoryCandidate.mock.calls.length;
    const general = await invoke(z.object(config.inputSchema).parse({ ...base, applicability: "general", projectIds: ["project-a"] }), extra());
    expect(JSON.parse(general.content[0]!.text)).toMatchObject({ recorded: false });
    const project = await invoke(z.object(config.inputSchema).parse({ ...base, applicability: "project" }), extra());
    expect(JSON.parse(project.content[0]!.text)).toMatchObject({ recorded: false });
    expect(mocks.proposeMemoryCandidate.mock.calls.length).toBe(calls);
    await invoke(z.object(config.inputSchema).parse({ ...base, applicability: "project", projectIds: ["project-a"] }), extra());
    expect(mocks.proposeMemoryCandidate.mock.calls.at(-1)?.[0]).toMatchObject({ applicability: { kind: "projects", projectIds: ["project-a"] } });
  });
});
