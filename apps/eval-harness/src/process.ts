import { spawn } from "node:child_process";

export interface ProcessResult {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly elapsedMs: number;
  readonly failure?: "spawn" | "timeout" | "output-limit" | "aborted";
}

/** No shell interpolation and no unbounded stdout, stderr, or orphaned child groups. */
export function runBoundedProcess(command: string, args: readonly string[], options: {
  cwd: string; env: NodeJS.ProcessEnv; input?: string; timeoutMs: number; maxOutputBytes?: number; signal?: AbortSignal;
}): Promise<ProcessResult> {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 600_000) throw new Error("Invalid process timeout");
  const maxBytes = options.maxOutputBytes ?? 4 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * 1024 * 1024) throw new Error("Invalid process output limit");
  if (options.signal?.aborted) return Promise.resolve({ exitCode: null, signal: null, stdout: "", stderr: "", elapsedMs: 0, failure: "aborted" });
  return new Promise((resolve) => {
    const started = performance.now();
    const child = spawn(command, [...args], { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    let failure: ProcessResult["failure"];
    let outputBytes = 0;
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const kill = (reason: NonNullable<ProcessResult["failure"]>) => {
      if (failure !== undefined) return;
      failure = reason;
      try { if (child.pid !== undefined) process.kill(-child.pid, "SIGTERM"); } catch { /* already exited */ }
      escalation = setTimeout(() => { try { if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ } }, 500);
    };
    const capture = (destination: Buffer[], chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > maxBytes) { kill("output-limit"); return; }
      destination.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
    child.stdin.on("error", () => { /* early exit closes stdin */ });
    child.on("error", () => { failure = "spawn"; });
    const abort = () => kill("aborted");
    const timer = setTimeout(() => kill("timeout"), options.timeoutMs);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    child.on("close", (exitCode, signal) => {
      // A direct child can exit while a descendant drops inherited stdio. Its process group still needs cleanup.
      try { if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL"); } catch { /* process group already gone */ }
      clearTimeout(timer); if (escalation !== undefined) clearTimeout(escalation);
      options.signal?.removeEventListener("abort", abort);
      resolve({ exitCode, signal, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), elapsedMs: Math.round(performance.now() - started), ...(failure === undefined ? {} : { failure }) });
    });
    child.stdin.end(options.input ?? "");
  });
}

/** Authentication is read by the trusted CLI from its usual home; unrelated secrets and integration variables are not inherited. */
export function runtimeEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { LANG: "en_US.UTF-8", NO_COLOR: "1" };
  for (const name of ["HOME", "PATH", "TMPDIR", "USER", "LOGNAME", "SSL_CERT_FILE", "SSL_CERT_DIR"]) if (source[name] !== undefined) env[name] = source[name];
  return env;
}
