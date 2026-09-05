import { createServer } from "node:http";
import { sha256 } from "./hash.js";
import { FIXED_SYSTEM_PROMPT, runRuntime, type RuntimeSpec } from "./runtime.js";

export function assessCodexIsolation(request: Record<string, unknown>): { approvedShape: boolean; advertisedTools: string[]; issues: string[] } {
  const advertisedTools: string[] = [], issues: string[] = [];
  const tool = (value: unknown) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) { issues.push("invalid-tool-definition"); return; }
    const item = value as Record<string, unknown>;
    if (item.type === "namespace") {
      if (item.name !== "functions" || !Array.isArray(item.tools)) issues.push("unexpected-tool-namespace");
      if (Array.isArray(item.tools)) item.tools.forEach(tool);
    } else {
      advertisedTools.push(String(item.name));
      if (item.name !== "request_user_input" || item.type !== "function" || typeof item.description !== "string" || !item.description.includes("only available in Plan mode")) issues.push("functional-or-unexpected-tool");
    }
  };
  if (request.tools !== undefined && !Array.isArray(request.tools)) issues.push("invalid-tool-set");
  else if (Array.isArray(request.tools)) request.tools.forEach(tool);
  if (request.instructions !== undefined && request.instructions !== FIXED_SYSTEM_PROMPT) issues.push("unexpected-instructions");
  const text = JSON.stringify(request);
  if (/\/Users\/|\/home\/|\.codex\/|\.claude\/|SKILL\.md\)/.test(text)) issues.push("private-host-or-skill-context");
  if (!text.includes(FIXED_SYSTEM_PROMPT)) issues.push("fixed-system-prompt-missing");
  if (Array.isArray(request.tools) && request.tools.length > 0) issues.push("unexpected-top-level-tools");
  const input = Array.isArray(request.input) ? request.input as Record<string, unknown>[] : [];
  if (!Array.isArray(request.input)) issues.push("input-unavailable");
  for (const message of input) {
    if (message.type === "additional_tools") { if (Array.isArray(message.tools)) message.tools.forEach(tool); else issues.push("invalid-additional-tools"); continue; }
    if (message.type !== "message" || !["developer", "user"].includes(String(message.role)) || !Array.isArray(message.content)) { issues.push("unexpected-input-record"); continue; }
    for (const content of message.content) {
    const value = (content as Record<string, unknown>).text;
    if (typeof value !== "string") { issues.push("unexpected-nontext-context"); continue; }
    if (value === FIXED_SYSTEM_PROMPT || value === "SYNTHETIC_ISOLATION_PROBE. Return the requested JSON response only.") continue;
    if (value.startsWith("<skills_instructions>") && /### Available skills\s*<\/skills_instructions>/.test(value)) continue;
    if (value.startsWith("<permissions instructions>") && value.includes('`sandbox_mode` is `read-only`') && value.includes("Approval policy is currently never")) continue;
    if (value.startsWith("<environment_context>") && /<cwd>\/private\/tmp\/super-brain-eval-runtime-[A-Za-z0-9]+<\/cwd>/.test(value)) continue;
    issues.push("unexpected-prompt-context");
    }
  }
  if (request.tools === undefined && !input.some((message) => message.type === "additional_tools")) issues.push("tool-set-unavailable");
  if (advertisedTools.filter((name) => name === "request_user_input").length > 1) issues.push("duplicate-input-stub");
  return { approvedShape: issues.length === 0, advertisedTools, issues: [...new Set(issues)] };
}

/** Exercises the actual Codex request builder against loopback. Never contacts a model provider or retains headers. */
export async function probeCodexIsolation(spec: RuntimeSpec) {
  if (spec.provider !== "openai-codex") throw new Error("Only Codex supports this local wire probe");
  let captured: Record<string, unknown> | undefined;
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/responses") { response.writeHead(404).end(); return; }
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of request) { size += chunk.length; if (size > 1024 * 1024) { response.writeHead(413).end(); return; } chunks.push(chunk); }
    captured = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    const text = JSON.stringify({ code: "export function reduceDelivery() { throw new Error('synthetic probe'); }", summary: "Synthetic isolation probe; no provider generation occurred." });
    const item = { id: "msg_probe", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] };
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of [
      { type: "response.created", response: { id: "resp_probe", status: "in_progress", model: spec.configuredModel, output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
      { type: "response.content_part.added", item_id: "msg_probe", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
      { type: "response.output_text.delta", item_id: "msg_probe", output_index: 0, content_index: 0, delta: text },
      { type: "response.output_text.done", item_id: "msg_probe", output_index: 0, content_index: 0, text },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: "resp_probe", status: "completed", model: spec.configuredModel, output: [item], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } },
    ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (address === null || typeof address === "string") throw new Error("Probe listener unavailable");
  try {
    const runtime = await runRuntime({ ...spec, timeoutMs: 30_000 }, "SYNTHETIC_ISOLATION_PROBE. Return the requested JSON response only.", { mockBaseUrl: `http://127.0.0.1:${address.port}/v1` });
    if (captured === undefined) return { kind: "synthetic-isolation-probe" as const, available: false, runtime };
    const tools = Array.isArray(captured.tools) ? captured.tools.map((tool: Record<string, unknown>) => ({ type: tool.type, name: tool.name })) : [];
    const input = captured.input;
    // Body alone is synthetic review material. Never copy request headers or authentication state.
    return { kind: "synthetic-isolation-probe" as const, available: true, runtime, isolation: assessCodexIsolation(captured), request: { model: captured.model, instructions: captured.instructions, input, tools }, requestSha256: sha256(JSON.stringify(captured)) };
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
}
