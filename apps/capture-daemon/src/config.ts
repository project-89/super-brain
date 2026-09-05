import { randomBytes } from "node:crypto";
import { hostname, homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { chmod, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";

import type { AnonymizationPolicy } from "@_89/super-brain-importer";
import type { CaptureConfig, ReasoningPolicy, ReasoningTreePolicy } from "./types.js";
import { ensureVaultKey } from "@_89/super-brain-importer";
import { DEFAULT_REPOSITORY_CAPTURE } from "./repository-snapshot.js";
import type { RepositoryCapturePolicy } from "./types.js";

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

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new TypeError(`capture configuration ${field} must be a non-negative integer`);
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

export function parseRepositoryCapturePolicy(value: unknown): RepositoryCapturePolicy {
  if (value === undefined) return DEFAULT_REPOSITORY_CAPTURE;
  const input = record(value);
  const allowed = new Set(["mode", "roots", "maxBytes", "maxFiles", "includeUntracked", "includeBinary"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new TypeError("unknown repository capture policy field");
  if (input.mode !== "metadata-only" && input.mode !== "snapshot") throw new TypeError("repository capture mode must be metadata-only or snapshot");
  if (!Array.isArray(input.roots) || input.roots.length > 100) throw new TypeError("repository capture requires at most 100 explicit consent roots");
  const roots = input.roots.map((root) => expandedPath(root, "repositoryCapture.roots"));
  if (input.mode === "snapshot" && roots.length === 0) throw new TypeError("repository snapshots require explicit consent roots");
  const maxBytes = positiveInteger(input.maxBytes ?? DEFAULT_REPOSITORY_CAPTURE.maxBytes, "repositoryCapture.maxBytes");
  const maxFiles = positiveInteger(input.maxFiles ?? DEFAULT_REPOSITORY_CAPTURE.maxFiles, "repositoryCapture.maxFiles");
  if (maxBytes > 64 * 1024 * 1024 || maxFiles > 10_000) throw new TypeError("repository snapshot bounds exceed 64 MiB or 10000 paths");
  for (const key of ["includeUntracked", "includeBinary"] as const) if (input[key] !== undefined && typeof input[key] !== "boolean") throw new TypeError(`repositoryCapture.${key} must be boolean`);
  return { mode: input.mode, roots, maxBytes, maxFiles, includeUntracked: input.includeUntracked === true, includeBinary: input.includeBinary === true };
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
  const reasoningTreePolicy = (input.reasoningTreePolicy ?? (reasoningPolicy === "include" ? "summaries" : "exclude")) as ReasoningTreePolicy;
  if (reasoningTreePolicy !== "exclude" && reasoningTreePolicy !== "summaries") {
    throw new TypeError("capture configuration reasoningTreePolicy must be exclude or summaries");
  }
  if (reasoningTreePolicy === "summaries" && reasoningPolicy !== "include") {
    throw new TypeError("reasoningTreePolicy summaries requires reasoningPolicy include");
  }
  if (input.retainEncryptedReasoning === true && reasoningPolicy !== "include") {
    throw new TypeError("retainEncryptedReasoning requires reasoningPolicy include");
  }
  const anonymizationPolicy = (input.anonymizationPolicy ?? "none") as AnonymizationPolicy;
  if (!(["none", "pseudonymous", "strict"] as const).includes(anonymizationPolicy)) {
    throw new TypeError("capture configuration anonymizationPolicy must be none, pseudonymous, or strict");
  }
  const anonymizationKeyPath = input.anonymizationKeyPath === undefined
    ? undefined
    : expandedPath(input.anonymizationKeyPath, "anonymizationKeyPath");
  if (anonymizationPolicy !== "none" && anonymizationKeyPath === undefined) {
    throw new TypeError("pseudonymous and strict anonymization require anonymizationKeyPath");
  }
  const sensorId = requiredString(input.sensorId, "sensorId");
  const repositoryCapture = parseRepositoryCapturePolicy(input.repositoryCapture);
  if (repositoryCapture.mode === "snapshot" && input.vaultKeyPath === undefined) throw new TypeError("repository snapshots require configured vault encryption");
  if (!/^urn:sensor:[^\s]+$/.test(sensorId)) {
    throw new TypeError("capture configuration sensorId must be a stable urn:sensor:* identifier");
  }
  return {
    apiUrl,
    organizationId: requiredString(input.organizationId ?? "local", "organizationId"),
    workspaceId: requiredString(input.workspaceId, "workspaceId"),
    apiToken: requiredString(input.apiToken, "apiToken"),
    sensorId,
    hookToken: requiredString(input.hookToken, "hookToken"),
    operatorToken: requiredString(input.operatorToken ?? input.hookToken, "operatorToken"),
    bindHost,
    port: positiveInteger(input.port, "port"),
    heartbeatWindowMs: positiveInteger(input.heartbeatWindowMs, "heartbeatWindowMs"),
    heartbeatIntervalMs: positiveInteger(input.heartbeatIntervalMs, "heartbeatIntervalMs"),
    orphanAfterMs: positiveInteger(input.orphanAfterMs ?? 24 * 60 * 60_000, "orphanAfterMs"),
    stateRoot: expandedPath(input.stateRoot, "stateRoot"),
    vaultRoot: expandedPath(input.vaultRoot, "vaultRoot"),
    ...(input.vaultKeyPath === undefined ? {} : { vaultKeyPath: expandedPath(input.vaultKeyPath, "vaultKeyPath") }),
    reasoningPolicy,
    retainEncryptedReasoning: input.retainEncryptedReasoning === true,
    reasoningTreePolicy,
    treeSnapshotEveryEvents: nonNegativeInteger(input.treeSnapshotEveryEvents ?? 25, "treeSnapshotEveryEvents"),
    anonymizationPolicy,
    repositoryCapture,
    ...(anonymizationKeyPath === undefined ? {} : { anonymizationKeyPath }),
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

export async function enableCaptureVaultEncryption(
  pathInput = defaultConfigPath(),
  keyPathInput?: string,
): Promise<{ readonly path: string; readonly keyPath: string }> {
  const path = resolve(pathInput);
  const current = await readCaptureConfig(path);
  const keyPath = resolve(keyPathInput ?? current.vaultKeyPath ?? join(dirname(path), "vault.key"));
  await ensureVaultKey(keyPath);
  await writePrivateJson(path, { ...current, vaultKeyPath: keyPath });
  return { path, keyPath };
}

export async function initializeCaptureConfig(options: {
  readonly path?: string;
  readonly apiToken: string;
  readonly apiUrl?: string;
  readonly organizationId?: string;
  readonly workspaceId?: string;
  readonly stateRoot?: string;
  readonly vaultRoot?: string;
  readonly vaultKeyPath?: string;
  readonly reasoningPolicy?: ReasoningPolicy;
  readonly retainEncryptedReasoning?: boolean;
  readonly reasoningTreePolicy?: ReasoningTreePolicy;
  readonly treeSnapshotEveryEvents?: number;
  readonly anonymizationPolicy?: AnonymizationPolicy;
  readonly anonymizationKeyPath?: string;
  readonly force?: boolean;
}): Promise<{ readonly path: string; readonly config: CaptureConfig }> {
  const path = resolve(options.path ?? defaultConfigPath());
  if (options.force !== true) {
    await stat(path).then(() => { throw new Error(`capture configuration already exists: ${path}`); }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
  const machine = hostname().toLowerCase().replace(/[^a-z0-9.-]+/g, "-") || "local";
  const vaultKeyPath = resolve(options.vaultKeyPath ?? join(dirname(path), "vault.key"));
  await ensureVaultKey(vaultKeyPath);
  const anonymizationPolicy = options.anonymizationPolicy ?? "pseudonymous";
  const anonymizationKeyPath = resolve(options.anonymizationKeyPath ?? join(dirname(path), "anonymization.key"));
  if (anonymizationPolicy !== "none") await ensureVaultKey(anonymizationKeyPath);
  const config = parseCaptureConfig({
    apiUrl: options.apiUrl ?? "http://127.0.0.1:3003",
    organizationId: options.organizationId ?? "local",
    workspaceId: options.workspaceId ?? "local-history",
    apiToken: options.apiToken,
    sensorId: `urn:sensor:super-brain-capture:${machine}`,
    hookToken: randomBytes(32).toString("hex"),
    operatorToken: randomBytes(32).toString("hex"),
    bindHost: "127.0.0.1",
    port: 8377,
    heartbeatWindowMs: 90_000,
    heartbeatIntervalMs: 30_000,
    orphanAfterMs: 24 * 60 * 60_000,
    stateRoot: options.stateRoot ?? `${homedir()}/.local/state/super-brain/capture`,
    vaultRoot: options.vaultRoot ?? `${homedir()}/.local/share/super-brain/vault`,
    vaultKeyPath,
    reasoningPolicy: options.reasoningPolicy ?? "exclude",
    retainEncryptedReasoning: options.retainEncryptedReasoning ?? false,
    reasoningTreePolicy: options.reasoningTreePolicy ?? "exclude",
    treeSnapshotEveryEvents: options.treeSnapshotEveryEvents ?? 25,
    anonymizationPolicy,
    ...(anonymizationPolicy === "none" ? {} : { anonymizationKeyPath }),
  });
  await writePrivateJson(path, config);
  return { path, config };
}

export async function updateCaptureConfig(
  pathInput = defaultConfigPath(),
  changes: Partial<Pick<CaptureConfig,
    | "reasoningPolicy"
    | "retainEncryptedReasoning"
    | "reasoningTreePolicy"
    | "treeSnapshotEveryEvents"
    | "anonymizationPolicy"
    | "anonymizationKeyPath"
    | "repositoryCapture"
  >> = {},
): Promise<{ readonly path: string; readonly config: CaptureConfig }> {
  const path = resolve(pathInput);
  const current = await readCaptureConfig(path);
  const requestedPolicy = changes.anonymizationPolicy ?? current.anonymizationPolicy;
  const anonymizationKeyPath = resolve(
    changes.anonymizationKeyPath ?? current.anonymizationKeyPath ?? join(dirname(path), "anonymization.key"),
  );
  if (requestedPolicy !== "none") await ensureVaultKey(anonymizationKeyPath);
  const config = parseCaptureConfig({
    ...current,
    ...changes,
    anonymizationPolicy: requestedPolicy,
    ...(requestedPolicy === "none" ? {} : { anonymizationKeyPath }),
  });
  await writePrivateJson(path, config);
  return { path, config };
}

export async function rotateCaptureOperatorToken(
  pathInput = defaultConfigPath(),
): Promise<{ readonly path: string; readonly config: CaptureConfig }> {
  const path = resolve(pathInput);
  const current = await readCaptureConfig(path);
  const config = parseCaptureConfig({
    ...current,
    operatorToken: randomBytes(32).toString("hex"),
  });
  await writePrivateJson(path, config);
  return { path, config };
}
