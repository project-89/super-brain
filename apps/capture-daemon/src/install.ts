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

async function writePrivateText(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  const file = await open(temporary, "w", 0o600);
  try {
    await file.writeFile(value, "utf8");
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

export async function installHermesHook(configPathInput: string): Promise<readonly string[]> {
  const configPath = resolve(configPathInput);
  const directory = join(homedir(), ".hermes", "hooks", "super-brain-capture");
  const manifestPath = join(directory, "HOOK.yaml");
  const handlerPath = join(directory, "handler.py");
  const manifest = `name: super-brain-capture\ndescription: Relay Hermes gateway lifecycle and tool-step observations\nevents:\n  - session:start\n  - session:reset\n  - agent:start\n  - agent:step\n  - agent:end\n`;
  const handler = `import asyncio\nimport json\nimport os\nimport urllib.request\nfrom pathlib import Path\n\nCONFIG_PATH = Path(${JSON.stringify(configPath)})\n\ndef _emit(name, context):\n    config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))\n    session_id = context.get("session_id") or context.get("session_key") or "hermes-gateway"\n    payload = dict(context)\n    payload.update({"hook_event_name": name, "session_id": str(session_id), "cwd": os.getcwd()})\n    request = urllib.request.Request(\n        "http://%s:%s/hook" % (config["bindHost"], config["port"]),\n        data=json.dumps(payload).encode("utf-8"),\n        headers={\n            "Content-Type": "application/json",\n            "X-Agent-Source": "hermes",\n            "X-Super-Brain-Hook-Token": config["hookToken"],\n        },\n        method="POST",\n    )\n    with urllib.request.urlopen(request, timeout=2):\n        pass\n\nasync def handle(event_type, context):\n    names = {\n        "session:start": ["SessionStart"],\n        "session:reset": ["SessionEnd"],\n        "agent:start": ["UserPromptSubmit"],\n        "agent:step": ["HermesStep"],\n        "agent:end": ["Stop", "SessionEnd"],\n    }.get(event_type, [])\n    payload = dict(context or {})\n    if event_type == "agent:start":\n        payload["prompt"] = payload.get("message", "")\n    if event_type == "agent:end":\n        payload["last_assistant_message"] = payload.get("response", "")\n    if event_type == "session:reset":\n        payload["reason"] = "reset"\n    for name in names:\n        await asyncio.to_thread(_emit, name, payload)\n`;
  await Promise.all([
    writePrivateText(manifestPath, manifest),
    writePrivateText(handlerPath, handler),
  ]);
  return [manifestPath, handlerPath];
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
