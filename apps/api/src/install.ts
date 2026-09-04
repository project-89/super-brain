import { execFile } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const API_ENVIRONMENT_KEYS = [
  "FOLD_API_CREDENTIALS_JSON",
  "FOLD_API_HOST",
  "FOLD_API_PORT",
  "FOLD_DATA_DIR",
  "FOLD_DATABASE_URL",
  "FOLD_REQUIRE_TENANT_RLS",
  "FOLD_API_RATE_LIMIT_PER_MINUTE",
  "FOLD_API_CORS_ORIGINS",
  "FOLD_FLEET_ORPHAN_AFTER_MS",
  "FOLD_EMBEDDING_URL",
  "FOLD_EMBEDDING_MODEL",
  "FOLD_EMBEDDING_DIMENSIONS",
  "FOLD_EMBEDDING_TOKEN",
] as const;

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function environmentFrom(source: NodeJS.ProcessEnv): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of API_ENVIRONMENT_KEYS) {
    const value = source[key];
    if (value !== undefined && value.length > 0) environment[key] = value;
  }
  if (environment.FOLD_API_CREDENTIALS_JSON === undefined) {
    throw new TypeError("FOLD_API_CREDENTIALS_JSON is required to install the API service");
  }
  return environment;
}

export function apiLaunchAgentPlist(options: {
  readonly executable: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly workingDirectory: string;
  readonly stateRoot: string;
}): string {
  const variables = Object.entries(options.environment)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.super-brain.api</string>
<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(options.executable)}</string><string>serve</string></array>
<key>EnvironmentVariables</key><dict>${variables}</dict>
<key>WorkingDirectory</key><string>${xml(options.workingDirectory)}</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>${xml(join(options.stateRoot, "service.log"))}</string>
<key>StandardErrorPath</key><string>${xml(join(options.stateRoot, "service.error.log"))}</string>
</dict></plist>\n`;
}

export async function installApiLaunchAgent(
  executableInput: string,
  source: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  if (process.platform !== "darwin") throw new Error("launchd installation is only available on macOS");
  const executable = resolve(executableInput);
  const stateRoot = join(homedir(), ".local", "state", "super-brain", "api");
  const path = join(homedir(), "Library", "LaunchAgents", "com.super-brain.api.plist");
  await Promise.all([
    mkdir(dirname(path), { recursive: true }),
    mkdir(stateRoot, { recursive: true, mode: 0o700 }),
  ]);
  await writeFile(path, apiLaunchAgentPlist({
    executable,
    environment: environmentFrom(source),
    workingDirectory: process.cwd(),
    stateRoot,
  }), { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
  const domain = `gui/${process.getuid?.() ?? 501}`;
  await execFileAsync("launchctl", ["bootout", domain, path]).catch(() => undefined);
  await execFileAsync("launchctl", ["bootstrap", domain, path]);
  return path;
}
