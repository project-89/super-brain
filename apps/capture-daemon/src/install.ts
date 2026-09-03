import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

const execFileAsync = promisify(execFile);
const EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Notification",
  "PermissionRequest",
  "Stop",
  "SessionEnd",
] as const;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function readObject(path: string): Promise<Record<string, unknown>> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function writePrivate(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  const file = await open(temporary, "w", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await file.sync();
    await file.close();
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await file.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function hookCommand(executable: string, configPath: string, source: "claude-code" | "codex"): string {
  return `${shellQuote(process.execPath)} ${shellQuote(executable)} relay ${source} --config ${shellQuote(configPath)} # super-brain-capture`;
}

export function mergedHookSettings(
  settings: Record<string, unknown>,
  executable: string,
  configPath: string,
  source: "claude-code" | "codex",
): Record<string, unknown> {
  const existingHooks = typeof settings.hooks === "object" && settings.hooks !== null && !Array.isArray(settings.hooks)
    ? settings.hooks as Record<string, unknown>
    : {};
  const hooks: Record<string, unknown> = { ...existingHooks };
  for (const event of EVENTS) {
    const current = Array.isArray(existingHooks[event]) ? existingHooks[event] as Array<Record<string, unknown>> : [];
    const retained = current.filter((group) => {
      const entries = Array.isArray(group.hooks) ? group.hooks as Array<Record<string, unknown>> : [];
      return !entries.some((entry) =>
        typeof entry.command === "string" &&
        (entry.command.includes("super-brain-capture") || entry.command.includes("127.0.0.1:8377/hook"))
      );
    });
    hooks[event] = [
      ...retained,
      {
        hooks: [{
          type: "command",
          command: hookCommand(executable, configPath, source),
          timeout: 5,
          ...(source === "claude-code" ? { async: true } : {}),
        }],
      },
    ];
  }
  return { ...settings, hooks };
}

export async function installHooks(executableInput: string, configPathInput: string): Promise<readonly string[]> {
  const executable = resolve(executableInput);
  const configPath = resolve(configPathInput);
  const targets = [
    { path: join(homedir(), ".claude", "settings.json"), source: "claude-code" as const },
    { path: join(homedir(), ".codex", "hooks.json"), source: "codex" as const },
  ];
  for (const target of targets) {
    const settings = await readObject(target.path);
    await writePrivate(target.path, mergedHookSettings(settings, executable, configPath, target.source));
  }
  return targets.map(({ path }) => path);
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export async function installLaunchAgent(executableInput: string, configPathInput: string): Promise<string> {
  if (process.platform !== "darwin") throw new Error("launchd installation is only available on macOS");
  const executable = resolve(executableInput);
  const configPath = resolve(configPathInput);
  const stateRoot = join(homedir(), ".local", "state", "super-brain", "capture");
  const agents = join(homedir(), "Library", "LaunchAgents");
  const path = join(agents, "com.super-brain.capture.plist");
  await mkdir(agents, { recursive: true });
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.super-brain.capture</string>
<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(executable)}</string><string>run</string><string>--config</string><string>${xml(configPath)}</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>${xml(join(stateRoot, "daemon.log"))}</string>
<key>StandardErrorPath</key><string>${xml(join(stateRoot, "daemon.error.log"))}</string>
</dict></plist>\n`;
  await writeFile(path, plist, { encoding: "utf8", mode: 0o600 });
  const domain = `gui/${process.getuid?.() ?? 501}`;
  await execFileAsync("launchctl", ["bootout", domain, path]).catch(() => undefined);
  await execFileAsync("launchctl", ["bootstrap", domain, path]);
  return path;
}
