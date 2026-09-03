import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, mkdir, open, readFile, readdir, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";

import { SuperBrainClient } from "@_89/super-brain-client";

import type { CaptureConfig } from "./types.js";

interface ExportFile {
  readonly path: string;
  readonly byteLength: number;
  readonly sha256: string;
}

export interface CaptureExportManifest {
  readonly version: 1;
  readonly createdAt: string;
  readonly workspaceId: string;
  readonly apiUrl: string;
  readonly includesVaultKey: boolean;
  readonly canonicalEventCount: number;
  readonly files: readonly ExportFile[];
}

async function fileSha256(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk as Buffer);
  return digest.digest("hex");
}

async function filesUnder(root: string): Promise<string[]> {
  const paths: string[] = [];
  async function visit(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) paths.push(path);
    }
  }
  await visit(root);
  return paths.sort();
}

async function copyTree(source: string, target: string): Promise<void> {
  for (const path of await filesUnder(source)) {
    const destination = join(target, relative(source, path));
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await copyFile(path, destination);
    await chmod(destination, 0o600);
  }
}

async function writePrivate(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(content, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
}

function assertSeparateDestination(config: CaptureConfig, destination: string): void {
  for (const source of [config.stateRoot, config.vaultRoot]) {
    if (destination === source || destination.startsWith(`${source}/`) || source.startsWith(`${destination}/`)) {
      throw new Error("export destination must be separate from capture state and vault roots");
    }
  }
}

export async function exportCaptureData(
  config: CaptureConfig,
  destinationInput: string,
  options: { readonly includeVaultKey?: boolean; readonly apiToken?: string } = {},
): Promise<CaptureExportManifest> {
  const destination = resolve(destinationInput);
  assertSeparateDestination(config, destination);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await mkdir(destination, { mode: 0o700 });
  await copyTree(config.stateRoot, join(destination, "capture-state"));
  await copyTree(config.vaultRoot, join(destination, "vault"));
  if (options.includeVaultKey === true && config.vaultKeyPath !== undefined) {
    const target = join(destination, "keys", basename(config.vaultKeyPath));
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(config.vaultKeyPath, target);
    await chmod(target, 0o600);
  }
  const client = new SuperBrainClient({
    baseUrl: config.apiUrl,
    workspaceId: config.workspaceId,
    token: options.apiToken ?? config.apiToken,
  });
  const entries = await client.listEvents({ include: "canon+draft" });
  await writePrivate(
    join(destination, "canonical-events.jsonl"),
    entries.map((entry) => JSON.stringify(entry)).join("\n") + (entries.length === 0 ? "" : "\n"),
  );
  const files = await Promise.all((await filesUnder(destination)).map(async (path): Promise<ExportFile> => {
    const metadata = await stat(path);
    return { path: relative(destination, path), byteLength: metadata.size, sha256: await fileSha256(path) };
  }));
  const manifest: CaptureExportManifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    workspaceId: config.workspaceId,
    apiUrl: config.apiUrl,
    includesVaultKey: options.includeVaultKey === true && config.vaultKeyPath !== undefined,
    canonicalEventCount: entries.length,
    files,
  };
  await writePrivate(join(destination, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export async function verifyCaptureExport(destinationInput: string): Promise<CaptureExportManifest> {
  const destination = resolve(destinationInput);
  const manifest = JSON.parse(await readFile(join(destination, "manifest.json"), "utf8")) as CaptureExportManifest;
  if (manifest.version !== 1 || !Array.isArray(manifest.files)) throw new Error("export manifest is invalid");
  for (const expected of manifest.files) {
    const path = join(destination, expected.path);
    const metadata = await stat(path);
    const digest = await fileSha256(path);
    if (metadata.size !== expected.byteLength || digest !== expected.sha256) {
      throw new Error(`export integrity check failed: ${expected.path}`);
    }
  }
  return manifest;
}

export async function pruneHookArtifacts(
  config: CaptureConfig,
  beforeMs: number,
  confirm = false,
): Promise<{ readonly matched: number; readonly deleted: number; readonly bytes: number }> {
  if (!Number.isFinite(beforeMs) || beforeMs < 0) throw new TypeError("retention cutoff is invalid");
  const files = await filesUnder(join(config.vaultRoot, "hooks"));
  let matched = 0;
  let deleted = 0;
  let bytes = 0;
  for (const path of files) {
    const metadata = await stat(path);
    if (metadata.mtimeMs >= beforeMs) continue;
    matched += 1;
    bytes += metadata.size;
    if (confirm) {
      await unlink(path);
      deleted += 1;
    }
  }
  return { matched, deleted, bytes };
}
