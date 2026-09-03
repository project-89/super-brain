import { randomBytes } from "node:crypto";
import { hostname, homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { chmod, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";

import type { CaptureConfig, ReasoningPolicy } from "./types.js";

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("capture configuration must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`capture configuration requires ${field}`);
  }
  return value.trim();
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new TypeError(`capture configuration ${field} must be a positive integer`);
  }
  return value as number;
}

function expandedPath(value: unknown, field: string): string {
  const path = requiredString(value, field);
  return resolve(path === "~" ? homedir() : path.startsWith("~/") ? `${homedir()}/${path.slice(2)}` : path);
}

export function defaultConfigPath(): string {
  return resolve(process.env.SUPER_BRAIN_CAPTURE_CONFIG ?? `${homedir()}/.config/super-brain/capture.json`);
}

export function parseCaptureConfig(value: unknown): CaptureConfig {
  const input = record(value);
  const apiUrl = requiredString(input.apiUrl, "apiUrl").replace(/\/+$/, "");
  const url = new URL(apiUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("capture configuration apiUrl must use HTTP(S)");
  }
  const bindHost = requiredString(input.bindHost, "bindHost");
  if (bindHost !== "127.0.0.1" && bindHost !== "::1") {
    throw new TypeError("capture daemon may only bind to a loopback address");
  }
  const reasoningPolicy = requiredString(input.reasoningPolicy, "reasoningPolicy") as ReasoningPolicy;
  if (reasoningPolicy !== "exclude" && reasoningPolicy !== "include") {
    throw new TypeError("capture configuration reasoningPolicy must be exclude or include");
  }
  const sensorId = requiredString(input.sensorId, "sensorId");
  if (!/^urn:sensor:[^\s]+$/.test(sensorId)) {
    throw new TypeError("capture configuration sensorId must be a stable urn:sensor:* identifier");
  }
  return {
    apiUrl,
    workspaceId: requiredString(input.workspaceId, "workspaceId"),
    apiToken: requiredString(input.apiToken, "apiToken"),
    sensorId,
    hookToken: requiredString(input.hookToken, "hookToken"),
    bindHost,
    port: positiveInteger(input.port, "port"),
    heartbeatWindowMs: positiveInteger(input.heartbeatWindowMs, "heartbeatWindowMs"),
    heartbeatIntervalMs: positiveInteger(input.heartbeatIntervalMs, "heartbeatIntervalMs"),
    stateRoot: expandedPath(input.stateRoot, "stateRoot"),
    vaultRoot: expandedPath(input.vaultRoot, "vaultRoot"),
    reasoningPolicy,
  };
}

export async function readCaptureConfig(path = defaultConfigPath()): Promise<CaptureConfig> {
  const metadata = await stat(path);
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error(`capture configuration must not be accessible by group or others: ${path}`);
  }
  return parseCaptureConfig(JSON.parse(await readFile(path, "utf8")) as unknown);
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
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

export async function initializeCaptureConfig(options: {
  readonly path?: string;
  readonly apiToken: string;
  readonly apiUrl?: string;
  readonly workspaceId?: string;
  readonly stateRoot?: string;
  readonly vaultRoot?: string;
  readonly reasoningPolicy?: ReasoningPolicy;
  readonly force?: boolean;
}): Promise<{ readonly path: string; readonly config: CaptureConfig }> {
  const path = resolve(options.path ?? defaultConfigPath());
  if (options.force !== true) {
    await stat(path).then(() => { throw new Error(`capture configuration already exists: ${path}`); }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
  const machine = hostname().toLowerCase().replace(/[^a-z0-9.-]+/g, "-") || "local";
  const config = parseCaptureConfig({
    apiUrl: options.apiUrl ?? "http://127.0.0.1:3003",
    workspaceId: options.workspaceId ?? "local-history",
    apiToken: options.apiToken,
    sensorId: `urn:sensor:super-brain-capture:${machine}`,
    hookToken: randomBytes(32).toString("hex"),
    bindHost: "127.0.0.1",
    port: 8377,
    heartbeatWindowMs: 90_000,
    heartbeatIntervalMs: 30_000,
    stateRoot: options.stateRoot ?? `${homedir()}/.local/state/super-brain/capture`,
    vaultRoot: options.vaultRoot ?? `${homedir()}/.local/share/super-brain/vault`,
    reasoningPolicy: options.reasoningPolicy ?? "exclude",
  });
  await writePrivateJson(path, config);
  return { path, config };
}
