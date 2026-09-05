import { execFile } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const WORKER_ENVIRONMENT_KEYS = [
  "SUPER_BRAIN_URL",
  "SUPER_BRAIN_ORGANIZATION",
  "SUPER_BRAIN_WORKSPACE",
  "SUPER_BRAIN_TOKEN",
  "FOLD_TRANSCRIPT_VAULT",
  "FOLD_TRANSCRIPT_VAULT_KEY_FILE",
  "SUPER_BRAIN_WORKER_STATE_ROOT",
  "SUPER_BRAIN_WORKER_SPACE",
  "SUPER_BRAIN_COGNITION_PROVIDER",
  "SUPER_BRAIN_TRUSTED_CAPTURE_SENSOR",
  "SUPER_BRAIN_TRUSTED_CAPTURE_STATE_ROOT",
  "SUPER_BRAIN_TRUSTED_CAPTURE_VAULT_ROOT",
  "SUPER_BRAIN_TRUSTED_CAPTURE_RECEIPT_KEY_FILE",
  "SUPER_BRAIN_TRUSTED_CAPTURE_VAULT_KEY_FILE",
] as const;

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function environmentFrom(source: NodeJS.ProcessEnv): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of WORKER_ENVIRONMENT_KEYS) {
    const value = source[key];
    if (value !== undefined && value.length > 0) environment[key] = value;
  }
  for (const key of ["SUPER_BRAIN_URL", "SUPER_BRAIN_WORKSPACE", "SUPER_BRAIN_TOKEN", "FOLD_TRANSCRIPT_VAULT"] as const) {
    if (environment[key] === undefined) throw new TypeError(`${key} is required to install the memory worker service`);
  }
  return environment;
}

export function memoryWorkerLaunchAgentPlist(options: {
  readonly executable: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly stateRoot: string;
  readonly consumerId: string;
  readonly autoPromote: boolean;
  readonly replayAll: boolean;
}): string {
  const variables = Object.entries(options.environment)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`)
    .join("");
  const argumentsXml = [
    process.execPath,
    options.executable,
    "watch",
    "--consumer",
    options.consumerId,
    ...(options.autoPromote ? ["--auto-promote"] : []),
    ...(options.replayAll ? ["--replay-all"] : []),
  ].map((argument) => `<string>${xml(argument)}</string>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.super-brain.memory-worker</string>
<key>ProgramArguments</key><array>${argumentsXml}</array>
<key>EnvironmentVariables</key><dict>${variables}</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>5</integer>
<key>StandardOutPath</key><string>${xml(join(options.stateRoot, "service.log"))}</string>
<key>StandardErrorPath</key><string>${xml(join(options.stateRoot, "service.error.log"))}</string>
</dict></plist>\n`;
}

export async function installMemoryWorkerLaunchAgent(
  executableInput: string,
  options: { readonly consumerId: string; readonly autoPromote: boolean; readonly replayAll: boolean },
  source: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  if (process.platform !== "darwin") throw new Error("launchd installation is only available on macOS");
  const executable = resolve(executableInput);
  const stateRoot = join(homedir(), ".local", "state", "super-brain", "memory-worker");
  const path = join(homedir(), "Library", "LaunchAgents", "com.super-brain.memory-worker.plist");
  await Promise.all([
    mkdir(dirname(path), { recursive: true }),
    mkdir(stateRoot, { recursive: true, mode: 0o700 }),
  ]);
  await writeFile(path, memoryWorkerLaunchAgentPlist({
    executable,
    environment: environmentFrom(source),
    stateRoot,
    ...options,
  }), { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
  const domain = `gui/${process.getuid?.() ?? 501}`;
  await execFileAsync("launchctl", ["bootout", domain, path]).catch(() => undefined);
  await execFileAsync("launchctl", ["bootstrap", domain, path]);
  return path;
}
