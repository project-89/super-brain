import { access, mkdtemp, open, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { sha256 } from "./hash.js";
import { runBoundedProcess, runtimeEnvironment, type ProcessResult } from "./process.js";

export type Provider = "openai-codex" | "anthropic-claude";
export interface RuntimeSpec {
  readonly provider: Provider;
  readonly executable: string;
  readonly configuredModel: string;
  readonly effort: "medium";
  readonly timeoutMs: number;
  readonly expectedVersion?: string;
  readonly codexCatalog?: Readonly<Record<string, unknown>>;
}
export const DEFAULT_RUNTIMES: readonly RuntimeSpec[] = [
  { provider: "openai-codex", executable: "codex", configuredModel: "gpt-5.6-sol", effort: "medium", timeoutMs: 180_000, expectedVersion: "codex-cli 0.153.3" },
  { provider: "anthropic-claude", executable: "claude", configuredModel: "sonnet", effort: "medium", timeoutMs: 180_000, expectedVersion: "2.1.246 (Claude Code)" },
];
export const FIXED_SYSTEM_PROMPT = "Solve only the supplied synthetic programming task. Use no tools, files, external integrations, or persistent memory. Return only the requested JSON object with JavaScript module code and a concise public implementation summary. Do not provide hidden reasoning. Do not execute the code.";
export async function isolatedDefaultRuntimes(): Promise<readonly RuntimeSpec[]> {
  const codexCatalog = JSON.parse(await readFile(join(import.meta.dirname, "../runtime/codex-catalog.json"), "utf8")) as Record<string, unknown>;
  return Promise.all(DEFAULT_RUNTIMES.map(async (runtime) => {
    const configured = (runtime.provider === "openai-codex" ? process.env.SUPER_BRAIN_EVAL_CODEX : process.env.SUPER_BRAIN_EVAL_CLAUDE) ?? runtime.executable;
    const candidates = isAbsolute(configured) || configured.includes("/") ? [resolve(configured)] : (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((directory) => join(directory, configured));
    let executable: string | undefined;
    for (const candidate of candidates) { try { await access(candidate, constants.X_OK); executable = await realpath(candidate); break; } catch { /* continue PATH search */ } }
    if (executable === undefined) throw new Error(`Configured ${runtime.provider} runtime executable is unavailable`);
    return { ...runtime, executable, ...(runtime.provider === "openai-codex" ? { codexCatalog } : {}) };
  }));
}
export const RESPONSE_SCHEMA = { type: "object", properties: { code: { type: "string" }, summary: { type: "string" } }, required: ["code", "summary"], additionalProperties: false };
export const CODEX_DISABLED_FEATURES = [
  "shell_tool", "unified_exec", "shell_snapshot", "hooks", "plugins", "apps", "memories", "multi_agent", "multi_agent_v2",
  "browser_use", "browser_use_external", "browser_use_full_cdp_access", "computer_use", "image_generation", "view_image", "skill_search",
  "skill_mcp_dependency_install", "code_mode", "code_mode_host", "workspace_dependencies", "goals", "sleep_tool", "in_app_browser", "in_app_chat",
  "in_app_local_automation", "tool_suggest", "remote_plugin", "auth_elicitation", "unbounded_connection_retries", "collaboration_modes", "default_mode_request_user_input",
] as const;

export function runtimeArguments(spec: RuntimeSpec, directory: string, mockBaseUrl?: string): string[] {
  if (spec.provider !== "openai-codex" && mockBaseUrl !== undefined) throw new Error("Mock provider is unsupported for this runtime");
  if (spec.provider === "anthropic-claude") return [
    "--print", "--safe-mode", "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--no-session-persistence",
    "--disable-slash-commands", "--no-chrome", "--setting-sources", "", "--permission-mode", "dontAsk",
    "--system-prompt", FIXED_SYSTEM_PROMPT, "--output-format", "stream-json", "--verbose", "--include-hook-events",
    "--model", spec.configuredModel, "--effort", spec.effort,
  ];
  return [
    "exec", "--ignore-user-config", "--ignore-rules", "--ephemeral", "--json", "--skip-git-repo-check", "--sandbox", "read-only", "--color", "never",
    "--model", spec.configuredModel, "--output-schema", join(directory, "response-schema.json"),
    "--output-last-message", join(directory, "last-message.json"),
    ...CODEX_DISABLED_FEATURES.flatMap((feature) => ["--disable", feature]), "--enable", "skip_host_skill_discovery",
    ...[
      'web_search="disabled"', "project_doc_max_bytes=0", "project_doc_fallback_filenames=[]", "mcp_servers={}",
      'approval_policy="never"', 'history.persistence="none"', 'shell_environment_policy.inherit="none"',
      `model_reasoning_effort=${JSON.stringify(spec.effort)}`, `model_instructions_file=${JSON.stringify(join(directory, "system.txt"))}`,
      'developer_instructions=""', "hide_agent_reasoning=true", "feedback.enabled=false", "skills.max_context_tokens=1",
      ...(spec.codexCatalog === undefined ? [] : [`model_catalog_json=${JSON.stringify(join(directory, "model-catalog.json"))}`]),
      ...(mockBaseUrl === undefined ? [] : ['model_provider="eval-probe"', 'model_providers.eval-probe.name="Synthetic isolation probe"', `model_providers.eval-probe.base_url=${JSON.stringify(mockBaseUrl)}`, 'model_providers.eval-probe.wire_api="responses"', "model_providers.eval-probe.requires_openai_auth=false", "model_providers.eval-probe.request_max_retries=0", "model_providers.eval-probe.stream_max_retries=0"]),
    ].flatMap((value) => ["-c", value]), "-",
  ];
}

export interface RuntimeObservation {
  readonly provider: Provider;
  readonly configuredModel: string;
  readonly observedModel?: string;
  readonly runtimeVersion: string;
  readonly configuration: { readonly effort: string; readonly arguments: readonly string[]; readonly systemPromptSha256: string; readonly availableTools?: readonly string[] };
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly process: ProcessResult;
  readonly output?: { readonly code: string; readonly summary: string };
  readonly reportedOutcome?: string;
  readonly usage?: Readonly<Record<string, number>>;
  readonly protocolIssues: readonly string[];
}
function record(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
async function boundedFinalMessage(path: string): Promise<string | undefined> {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > 256 * 1024) throw new Error("Final runtime response is not a bounded regular file");
    const buffer = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < buffer.length) { const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset); if (bytesRead === 0) break; offset += bytesRead; }
    const after = await file.stat();
    if (offset !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("Final runtime response changed while reading");
    return buffer.toString("utf8");
  } finally { await file.close(); }
}
function readOutput(value: unknown): RuntimeObservation["output"] {
  const object = record(value);
  if (typeof object?.code !== "string" || typeof object.summary !== "string" || Object.keys(object).some((key) => key !== "code" && key !== "summary") || Buffer.byteLength(object.code) > 128 * 1024 || object.summary.length > 8_000) return undefined;
  return { code: object.code, summary: object.summary };
}
export function parseRuntimeOutput(spec: RuntimeSpec, stdout: string, lastMessage?: string): Pick<RuntimeObservation, "output" | "observedModel" | "reportedOutcome" | "usage" | "protocolIssues"> & { availableTools?: readonly string[] } {
  const issues: string[] = [];
  const lines: Record<string, unknown>[] = [];
  for (const line of stdout.split("\n").filter((value) => value.trim() !== "")) {
    try { const value = record(JSON.parse(line)); if (value !== undefined) lines.push(value); else issues.push("non-object-runtime-record"); } catch { issues.push("malformed-runtime-json"); }
  }
  let output: RuntimeObservation["output"], observedModel: string | undefined, reportedOutcome: string | undefined;
  let usage: Record<string, number> | undefined, availableTools: string[] | undefined;
  let initializations = 0;
  const accumulateUsage = (raw: unknown) => {
    const obj = record(raw); if (obj === undefined) return;
    const allowed = ["input_tokens", "output_tokens", "cached_input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"];
    const picked = Object.fromEntries(allowed.flatMap((key) => typeof obj[key] === "number" && Number.isFinite(obj[key]) && obj[key] >= 0 ? [[key, obj[key]]] : []));
    if (Object.keys(picked).length > 0) usage = picked as Record<string, number>;
  };
  for (const item of lines) {
    if (item.type === "system" && item.subtype === "init") {
      initializations += 1;
      if (spec.provider === "anthropic-claude" && [item.tools, item.mcp_servers, item.plugins].some((value) => !Array.isArray(value) || value.length !== 0)) issues.push("unexpected-runtime-initialization");
      if (typeof item.model === "string") observedModel = item.model;
      if (Array.isArray(item.tools)) availableTools = item.tools.filter((tool): tool is string => typeof tool === "string");
      if (Array.isArray(item.mcp_servers) && item.mcp_servers.length > 0) issues.push("unexpected-mcp-server");
      if (Array.isArray(item.plugins) && item.plugins.length > 0) issues.push("unexpected-plugin");
    }
    if (item.type === "system" && typeof item.subtype === "string" && item.subtype.includes("hook")) issues.push("unexpected-hook-event");
    const message = record(item.message);
    if (typeof message?.model === "string") observedModel = message.model;
    if (Array.isArray(message?.content) && message.content.some((part) => record(part)?.type === "tool_use")) issues.push("unexpected-tool-use");
    if (["function_call", "custom_tool_call", "tool_use", "tool_call"].includes(String(item.type))) issues.push("unexpected-tool-use");
    if (item.type === "item.completed" || item.type === "item.started" || item.type === "item.updated") {
      const nested = record(item.item);
      // These exact CLI diagnostics report deliberately disabled discovery, not provider actions.
      const knownIsolationDiagnostic = nested?.type === "error" && typeof nested.message === "string" && (
        /^Exceeded skills context budget\. All skill descriptions were removed and \d+ additional skills were not included in the model-visible skills list\.$/.test(nested.message)
        || /^Under-development features enabled: skip_host_skill_discovery\. Under-development features are incomplete and may behave unpredictably\. To suppress this warning, set `suppress_unstable_features_warning = true` in [^\n]+config\.toml\.$/.test(nested.message));
      if (nested !== undefined && !["agent_message", "reasoning"].includes(String(nested.type)) && !knownIsolationDiagnostic) issues.push(nested.type === "error" ? "provider-reported-failure" : "unexpected-tool-use");
      if (nested?.type === "agent_message" && typeof nested.text === "string") { try { output = readOutput(JSON.parse(nested.text)); } catch { /* final message may be separate */ } }
    }
    if (item.type === "turn.completed") { accumulateUsage(item.usage); reportedOutcome = "turn.completed"; }
    if (item.type === "turn.failed" || item.type === "error") { reportedOutcome = String(item.type); issues.push("provider-reported-failure"); }
    if (item.type === "result") {
      reportedOutcome = typeof item.subtype === "string" ? item.subtype : "result";
      if (item.is_error === true) issues.push("provider-reported-failure");
      output = readOutput(item.structured_output) ?? output;
      if (typeof item.result === "string") { try { output = readOutput(JSON.parse(item.result)) ?? output; } catch { /* JSON schema response may be in structured_output */ } }
      accumulateUsage(item.usage);
    }
  }
  if (lastMessage !== undefined && lastMessage.trim() !== "") { try { output = readOutput(JSON.parse(lastMessage)) ?? output; } catch { issues.push("invalid-final-response"); } }
  if (spec.provider === "anthropic-claude" && initializations !== 1) issues.push("unexpected-missing-or-duplicate-runtime-initialization");
  if (availableTools !== undefined && availableTools.length > 0) issues.push("unexpected-available-tools");
  if (output === undefined) issues.push("code-response-unavailable");
  return { ...(output === undefined ? {} : { output }), ...(observedModel === undefined ? {} : { observedModel }), ...(reportedOutcome === undefined ? {} : { reportedOutcome }), ...(usage === undefined ? {} : { usage }), ...(availableTools === undefined ? {} : { availableTools }), protocolIssues: [...new Set(issues)] };
}

/** Generation is explicit: call only after frozen inputs and isolation review have been approved. */
export async function runRuntime(spec: RuntimeSpec, prompt: string, options: { signal?: AbortSignal; mockBaseUrl?: string } = {}): Promise<RuntimeObservation> {
  const directory = await mkdtemp("/tmp/super-brain-eval-runtime-");
  try {
    await writeFile(join(directory, "system.txt"), FIXED_SYSTEM_PROMPT, { mode: 0o600 });
    await writeFile(join(directory, "response-schema.json"), JSON.stringify(RESPONSE_SCHEMA), { mode: 0o600 });
    if (spec.codexCatalog !== undefined) await writeFile(join(directory, "model-catalog.json"), JSON.stringify(spec.codexCatalog), { mode: 0o600 });
    const args = runtimeArguments(spec, directory, options.mockBaseUrl);
    if (spec.provider === "openai-codex") {
      const systemRoot = join(homedir(), ".codex", "skills", ".system");
      const skills = await readdir(systemRoot, { withFileTypes: true }).catch(() => []);
      const entries = skills.filter((entry) => entry.isDirectory()).map((entry) => `{path=${JSON.stringify(join(systemRoot, entry.name))},enabled=false}`);
      args.splice(args.length - 1, 0, "-c", `skills.config=[${entries.join(",")}]`);
    }
    const env = runtimeEnvironment();
    const version = await runBoundedProcess(spec.executable, ["--version"], { cwd: directory, env, timeoutMs: 10_000, maxOutputBytes: 1024 });
    if (version.exitCode !== 0 || version.failure !== undefined) throw new Error("Provider runtime version unavailable");
    if (spec.expectedVersion !== undefined && version.stdout.trim() !== spec.expectedVersion) throw new Error("Provider runtime version changed from reviewed configuration");
    const startedAt = new Date().toISOString();
    const process = await runBoundedProcess(spec.executable, args, { cwd: directory, env, input: prompt, timeoutMs: spec.timeoutMs, ...(options.signal === undefined ? {} : { signal: options.signal }) });
    const finishedAt = new Date().toISOString();
    const lastMessage = spec.provider === "openai-codex" ? await boundedFinalMessage(join(directory, "last-message.json")) : undefined;
    const parsed = parseRuntimeOutput(spec, process.stdout, lastMessage);
    const safeArgs = args.map((arg) => arg.split(directory).join("<synthetic-runtime-directory>").split(homedir()).join("<runtime-auth-home>"));
    return { provider: spec.provider, configuredModel: spec.configuredModel, runtimeVersion: version.stdout.trim(), configuration: { effort: spec.effort, arguments: safeArgs, systemPromptSha256: sha256(FIXED_SYSTEM_PROMPT), ...(parsed.availableTools === undefined ? {} : { availableTools: parsed.availableTools }) }, startedAt, finishedAt, process, ...parsed };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
