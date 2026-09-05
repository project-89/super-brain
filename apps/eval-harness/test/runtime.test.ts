import { describe, expect, it } from "vitest";
import { DEFAULT_RUNTIMES, FIXED_SYSTEM_PROMPT, parseRuntimeOutput, runtimeArguments } from "../src/runtime.js";
import { assessCodexIsolation } from "../src/preflight.js";

describe("provider isolation and source observations", () => {
  it("keeps explicit integration controls and rejects an unsupported mock destination", () => {
    const codex = runtimeArguments(DEFAULT_RUNTIMES[0]!, "/tmp/synthetic");
    expect(codex).toEqual(expect.arrayContaining(["--ignore-user-config", "--ephemeral", "read-only", 'web_search="disabled"', "project_doc_max_bytes=0", "hooks", "plugins", "apps", "shell_tool", "skill_search", "skills.max_context_tokens=1"]));
    const claude = runtimeArguments(DEFAULT_RUNTIMES[1]!, "/tmp/synthetic");
    expect(claude).toEqual(expect.arrayContaining(["--safe-mode", "--tools", "", "--strict-mcp-config", "--no-session-persistence", "--disable-slash-commands"]));
    expect(() => runtimeArguments(DEFAULT_RUNTIMES[1]!, "/tmp/synthetic", "http://127.0.0.1/mock")).toThrow(/unsupported/);
  });
  it("detects nested file tools and host context even when top-level tools are empty", () => {
    const message = { type: "message", role: "developer", content: [{ text: FIXED_SYSTEM_PROMPT }] };
    const stub = { type: "function", name: "request_user_input", description: "This tool is only available in Plan mode." };
    const request = { input: [message, { type: "additional_tools", tools: [{ type: "namespace", name: "functions", tools: [stub] }] }], tools: [] };
    expect(assessCodexIsolation({ input: request.input }).approvedShape).toBe(true);
    expect(assessCodexIsolation({ input: [message] }).approvedShape).toBe(false);
    expect(assessCodexIsolation(request)).toMatchObject({ approvedShape: true, advertisedTools: ["request_user_input"] });
    expect(assessCodexIsolation({ ...request, input: [...request.input, { type: "additional_tools", tools: [{ type: "custom", name: "apply_patch" }] }] }).approvedShape).toBe(false);
    expect(assessCodexIsolation({ ...request, input: [...request.input, { type: "additional_tools", tools: [{ type: "web_search" }] }] }).approvedShape).toBe(false);
    expect(assessCodexIsolation({ ...request, input: [...request.input, { type: "unrecognized_context", text: "opaque context" }] }).approvedShape).toBe(false);
    expect(assessCodexIsolation({ ...request, instructions: "/Users/private/.codex/skills" }).approvedShape).toBe(false);
  });
  it("retains observed identifiers and usage without inventing missing values or accepting tool use", () => {
    const code = { code: "export function reduceDelivery(s){return {...s}}", summary: "Public implementation summary" };
    const parsed = parseRuntimeOutput(DEFAULT_RUNTIMES[1]!, [
      { type: "system", subtype: "init", model: "claude-observed-version", tools: [], mcp_servers: [], plugins: [] },
      { type: "result", subtype: "success", is_error: false, result: JSON.stringify(code), usage: { input_tokens: 12, output_tokens: 8, speculative_total: 20 } },
    ].map((value) => JSON.stringify(value)).join("\n"));
    expect(parsed).toMatchObject({ observedModel: "claude-observed-version", output: code, usage: { input_tokens: 12, output_tokens: 8 }, protocolIssues: [] });
    const diagnostic = (message: string) => JSON.stringify({ type: "item.completed", item: { type: "error", message } });
    expect(parseRuntimeOutput(DEFAULT_RUNTIMES[0]!, diagnostic("Exceeded skills context budget. All skill descriptions were removed and 5 additional skills were not included in the model-visible skills list."), JSON.stringify(code)).protocolIssues).toEqual([]);
    expect(parseRuntimeOutput(DEFAULT_RUNTIMES[0]!, diagnostic("Unexpected runtime error"), JSON.stringify(code)).protocolIssues).toContain("provider-reported-failure");
    const missing = parseRuntimeOutput(DEFAULT_RUNTIMES[0]!, JSON.stringify({ type: "turn.completed" }));
    expect(missing).not.toHaveProperty("observedModel"); expect(missing).not.toHaveProperty("usage");
    expect(parseRuntimeOutput(DEFAULT_RUNTIMES[0]!, JSON.stringify({ type: "item.completed", item: { type: "function_call", name: "request_user_input" } }), JSON.stringify(code)).protocolIssues).toContain("unexpected-tool-use");
    expect(parseRuntimeOutput(DEFAULT_RUNTIMES[0]!, "", JSON.stringify({ ...code, extra: true })).output).toBeUndefined();
    expect(parseRuntimeOutput(DEFAULT_RUNTIMES[0]!, "malformed").protocolIssues).toContain("malformed-runtime-json");
  });
  it("fails closed when a Claude result lacks exactly one explicit empty tool initialization", () => {
    const output = { code: "export function reduceDelivery() { return null; }", summary: "Synthetic protocol fixture" };
    const result = { type: "result", subtype: "success", result: JSON.stringify(output) };
    const init = { type: "system", subtype: "init", tools: [], plugins: [], mcp_servers: [] };
    const parse = (records: unknown[]) => parseRuntimeOutput(DEFAULT_RUNTIMES[1]!, records.map(record => JSON.stringify(record)).join("\n"));
    expect(parse([result])).toMatchObject({ output, protocolIssues: ["unexpected-missing-or-duplicate-runtime-initialization"] });
    expect(parse([init, result]).protocolIssues).toEqual([]);
    expect(parse([init, init, result]).protocolIssues).toContain("unexpected-missing-or-duplicate-runtime-initialization");
    for (const incomplete of [{ ...init, tools: undefined }, { ...init, plugins: undefined }, { ...init, mcp_servers: undefined }, { ...init, tools: [null] }]) {
      expect(parse([incomplete, result]).protocolIssues).toContain("unexpected-runtime-initialization");
    }
  });

});
