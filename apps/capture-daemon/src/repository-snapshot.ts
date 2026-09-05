import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { decryptVaultLine, encryptVaultLine, readVaultKey, redactJsonValue } from "@_89/super-brain-importer";
import { atomicPrivateText, readBoundedPrivateText } from "./storage.js";
import { absoluteRepositoryPath, gitBytes, nulFields, parseIndexEntries, parseRepositoryStatus, readRepositoryFile, repositoryHash, repositorySentinel, repositoryWorktreeDigest, safeRepositoryPath, sentinelDigest } from "./repository.js";
import type { CaptureConfig, ProjectIdentity, RepositoryCapturePolicy } from "./types.js";

export const DEFAULT_REPOSITORY_CAPTURE: RepositoryCapturePolicy = { mode: "metadata-only", roots: [], maxBytes: 16 * 1024 * 1024, maxFiles: 1_000, includeUntracked: false, includeBinary: false };
export interface RepositorySnapshotEntry {
  readonly pathBase64: string;
  readonly layer: "index" | "worktree";
  readonly kind: "file" | "deleted";
  readonly mode?: "100644" | "100755";
  readonly contentBase64?: string;
  readonly sha256?: string;
  readonly redacted?: true;
}
export interface RepositorySnapshot {
  readonly version: 1;
  readonly baseCommit: string;
  readonly sourceRevisionId: string;
  readonly publicRevisionId: string;
  readonly capturedAt: string;
  readonly consent: RepositoryCapturePolicy;
  readonly reconstruction: "complete" | "partial";
  readonly requiresBaseCommit: true;
  readonly entries: readonly RepositorySnapshotEntry[];
  readonly exclusions: readonly { readonly pathBase64?: string; readonly reason: string }[];
  readonly stagedPatchBase64?: string;
  readonly unstagedPatchBase64?: string;
  readonly reviewPatches: "included" | "omitted-partial" | "omitted-redaction" | "omitted-byte-limit";
}
export interface RepositorySnapshotResult {
  readonly reconstruction: "complete" | "partial" | "unavailable";
  readonly artifactId?: string;
  readonly byteLength?: number;
  readonly reason?: "metadata-only" | "outside-consent" | "key-unavailable" | "fingerprint-unavailable" | "repository-changing" | "repository-unavailable";
}

function sanitizedBytes(bytes: Buffer, includeBinary: boolean): { readonly bytes?: Buffer; readonly redacted: boolean; readonly excluded?: string } {
  const utf8 = bytes.toString("utf8"); const binary = bytes.includes(0) || !Buffer.from(utf8).equals(bytes);
  // Scan original bytes before encoding. Binary data is never made opaque to the redactor by base64.
  const scan = redactJsonValue(binary ? bytes.toString("latin1") : utf8);
  const wideScan = binary ? redactJsonValue(bytes.toString("utf16le")) : { count: 0 };
  if (binary && (!includeBinary || scan.count > 0 || wideScan.count > 0)) return { redacted: false, excluded: scan.count > 0 || wideScan.count > 0 ? "binary-secret" : "binary-not-consented" };
  return { bytes: binary ? bytes : Buffer.from(scan.value as string), redacted: scan.count > 0 };
}
function pathAllowed(path: Buffer): boolean {
  return safeRepositoryPath(path) && redactJsonValue(path.toString("latin1")).count === 0 && redactJsonValue(path.toString("utf8")).count === 0;
}
function snapshotPath(vaultRoot: string, id: string): string {
  if (!/^repository-snapshot:[a-f0-9]{64}$/.test(id)) throw new TypeError("invalid repository snapshot identity");
  return join(vaultRoot, "repository-snapshots", `${id.slice("repository-snapshot:".length)}.json.enc`);
}
function isWithin(root: string, path: string): boolean { const local = relative(root, path); return local === "" || (!local.startsWith(`..${sep}`) && local !== ".." && !local.startsWith(sep)); }

export async function captureRepositorySnapshot(config: CaptureConfig, project: ProjectIdentity, identity: { readonly sourceRevisionId: string; readonly publicRevisionId: string; readonly capturedAt: string }): Promise<RepositorySnapshotResult> {
  const policy = config.repositoryCapture ?? DEFAULT_REPOSITORY_CAPTURE;
  if (policy.mode !== "snapshot") return { reconstruction: "unavailable", reason: "metadata-only" };
  if (config.vaultKeyPath === undefined) return { reconstruction: "unavailable", reason: "key-unavailable" };
  if (project.head === undefined || project.fingerprintStatus !== "available") return { reconstruction: "unavailable", reason: "fingerprint-unavailable" };
  const root = await realpath(project.root).catch(() => undefined);
  const roots = await Promise.all(policy.roots.map((path) => realpath(path).catch(() => undefined)));
  if (root === undefined || !roots.some((allowed) => allowed !== undefined && isWithin(allowed, root))) return { reconstruction: "unavailable", reason: "outside-consent" };
  const privatePaths = [config.stateRoot, config.vaultRoot, config.vaultKeyPath, config.anonymizationKeyPath].filter((path): path is string => path !== undefined);
  const excludedRoots = [...new Set((await Promise.all(privatePaths.map(async (path) => [resolve(path), await realpath(path).catch(() => resolve(path))]))).flat())];
  if (excludedRoots.some((path) => isWithin(path, root))) return { reconstruction: "unavailable", reason: "outside-consent" };
  const entries: RepositorySnapshotEntry[] = []; const exclusions: { pathBase64?: string; reason: string }[] = [];
  let bytes = 0; let changed = false;
  try {
    const before = await repositorySentinel(root);
    const worktreeDigest = await repositoryWorktreeDigest(root, before);
    if (before.head !== project.head || worktreeDigest !== project.worktreeDigest || identity.sourceRevisionId !== `git:${before.head}:worktree:${worktreeDigest}`) return { reconstruction: "unavailable", reason: "repository-changing" };
    const statuses = parseRepositoryStatus(before.status);
    const index = parseIndexEntries(before.index);
    if (index.some((entry) => entry.stage !== 0 || !["100644", "100755"].includes(entry.mode))) exclusions.push({ reason: "unsupported-base-or-index-mode" });
    const baseEntries = nulFields(await gitBytes(root, ["ls-tree", "-r", "-z", before.head])).map((entry) => {
      const tab = entry.indexOf(9); const [mode, kind, objectId] = entry.subarray(0, tab).toString("ascii").split(" ");
      return { mode, kind, objectId, path: entry.subarray(tab + 1) };
    });
    if (baseEntries.some((entry) => entry.kind !== "blob" || !["100644", "100755"].includes(entry.mode!))) exclusions.push({ reason: "unsupported-base-mode" });
    const paths = new Map<string, Buffer>();
    const untracked = new Set<string>();
    for (const status of statuses) {
      paths.set(status.path.toString("base64"), status.path);
      if (status.previousPath !== undefined) paths.set(status.previousPath.toString("base64"), status.previousPath);
      if (status.status === "??") untracked.add(status.path.toString("base64"));
    }
    // Git binary patches already encode their old/new blobs. Inspect original base bytes before retaining that encoding.
    let patchRedacted = false; let patchScanBytes = 0;
    for (const entry of baseEntries) if (paths.has(entry.path.toString("base64")) && entry.kind === "blob" && entry.objectId !== undefined) {
      try {
        const bytes = await gitBytes(root, ["cat-file", "blob", entry.objectId], { maxBytes: Math.max(1, policy.maxBytes - patchScanBytes) }); patchScanBytes += bytes.length;
        const safe = sanitizedBytes(bytes, policy.includeBinary);
        if (safe.redacted || safe.bytes === undefined) patchRedacted = true;
      } catch { patchRedacted = true; }
    }
    const fileWitnesses: { path: Buffer; sha256?: string; mode?: string }[] = [];
    let count = 0;
    for (const [pathBase64, path] of paths) {
      if (!pathAllowed(path)) { exclusions.push({ reason: "unsafe-or-redacted-path" }); continue; }
      if (excludedRoots.some((excluded) => isWithin(excluded, absoluteRepositoryPath(root, path).toString("utf8")))) { exclusions.push({ pathBase64, reason: "private-storage-path" }); continue; }
      if (++count > policy.maxFiles) { exclusions.push({ pathBase64, reason: "file-limit" }); continue; }
      if (untracked.has(pathBase64) && !policy.includeUntracked) { exclusions.push({ pathBase64, reason: "untracked-not-consented" }); continue; }
      const staged = index.filter((entry) => entry.path.equals(path));
      if (staged.some((entry) => entry.stage !== 0 || (entry.mode !== "100644" && entry.mode !== "100755"))) { exclusions.push({ pathBase64, reason: "unmerged-or-unsupported-index-mode" }); continue; }
      const add = (layer: "index" | "worktree", data: { bytes: Buffer; mode: string } | undefined) => {
        if (data === undefined) { entries.push({ pathBase64, layer, kind: "deleted" }); return; }
        bytes += data.bytes.length;
        if (bytes > policy.maxBytes) { exclusions.push({ pathBase64, reason: "byte-limit" }); return; }
        const safe = sanitizedBytes(data.bytes, policy.includeBinary);
        if (safe.bytes === undefined) { exclusions.push({ pathBase64, reason: safe.excluded! }); return; }
        if (safe.redacted) exclusions.push({ pathBase64, reason: "content-redacted" });
        entries.push({ pathBase64, layer, kind: "file", mode: data.mode as "100644" | "100755", contentBase64: safe.bytes.toString("base64"), sha256: repositoryHash(safe.bytes), ...(safe.redacted ? { redacted: true as const } : {}) });
      };
      try {
        // An untracked path has no index overlay; deleted staged paths must remove their base entry.
        if (!untracked.has(pathBase64)) {
          const stagedEntry = staged[0];
          add("index", stagedEntry === undefined ? undefined : { bytes: await gitBytes(root, ["cat-file", "blob", stagedEntry.objectId], { maxBytes: Math.max(1, policy.maxBytes - bytes) }), mode: stagedEntry.mode });
        }
        const file = await readRepositoryFile(root, path, Math.max(0, policy.maxBytes - bytes));
        fileWitnesses.push({ path, ...(file === undefined ? {} : { sha256: repositoryHash(file.bytes), mode: file.mode }) });
        add("worktree", file);
      } catch { exclusions.push({ pathBase64, reason: "unavailable-unsafe-or-over-limit-file" }); }
    }
    const after = await repositorySentinel(root);
    changed = sentinelDigest(before) !== sentinelDigest(after) || await repositoryWorktreeDigest(root, after) !== worktreeDigest;
    for (const witness of fileWitnesses) {
      const file = await readRepositoryFile(root, witness.path, policy.maxBytes);
      if ((file === undefined ? undefined : repositoryHash(file.bytes)) !== witness.sha256 || file?.mode !== witness.mode) changed = true;
    }
    if (changed) return { reconstruction: "unavailable", reason: "repository-changing" };
    const patch = (value: Buffer): string => Buffer.from(redactJsonValue(value.toString("utf8")).value as string).toString("base64");
    const reviewPatches = exclusions.length > 0 ? "omitted-partial" : patchRedacted ? "omitted-redaction" : before.staged.length + before.unstaged.length + bytes > policy.maxBytes ? "omitted-byte-limit" : "included";
    const stagedPatchBase64 = reviewPatches === "included" ? patch(before.staged) : undefined; const unstagedPatchBase64 = reviewPatches === "included" ? patch(before.unstaged) : undefined;
    const snapshot: RepositorySnapshot = { version: 1, baseCommit: before.head, ...identity, consent: policy,
      reconstruction: exclusions.length === 0 ? "complete" : "partial", requiresBaseCommit: true, entries, exclusions, reviewPatches,
      ...(stagedPatchBase64 === undefined ? {} : { stagedPatchBase64 }), ...(unstagedPatchBase64 === undefined ? {} : { unstagedPatchBase64 }) };
    const serialized = JSON.stringify(snapshot);
    const artifactId = `repository-snapshot:${repositoryHash(serialized)}`;
    const key = await readVaultKey(config.vaultKeyPath);
    await atomicPrivateText(snapshotPath(config.vaultRoot, artifactId), `${encryptVaultLine(serialized, key)}\n`);
    return { artifactId, reconstruction: snapshot.reconstruction, byteLength: Buffer.byteLength(serialized) };
  } catch { return { reconstruction: "unavailable", reason: changed ? "repository-changing" : "repository-unavailable" }; }
}

export async function readRepositorySnapshot(options: { readonly vaultRoot: string; readonly artifactId: string; readonly encryptionKey: Uint8Array; readonly maxBytes?: number }): Promise<RepositorySnapshot> {
  const path = snapshotPath(options.vaultRoot, options.artifactId);
  const raw = (await readBoundedPrivateText(path, options.maxBytes ?? 128 * 1024 * 1024)).trim();
  if ((JSON.parse(raw) as { $superBrainEncrypted?: unknown }).$superBrainEncrypted !== 1) throw new Error("snapshot requires authenticated encryption");
  const serialized = decryptVaultLine(raw, options.encryptionKey);
  if (`repository-snapshot:${repositoryHash(serialized)}` !== options.artifactId) throw new Error("snapshot identity mismatch");
  const snapshot = JSON.parse(serialized) as RepositorySnapshot;
  if (snapshot.version !== 1 || !/^[a-f0-9]{40,64}$/.test(snapshot.baseCommit) || !Array.isArray(snapshot.entries) || snapshot.entries.length > 200_000) throw new Error("unsupported snapshot descriptor");
  const seen = new Set<string>();
  for (const entry of snapshot.entries) {
    const path = Buffer.from(entry.pathBase64, "base64"); const identity = `${entry.layer}:${entry.pathBase64}`;
    if (!pathAllowed(path) || path.toString("base64") !== entry.pathBase64 || seen.has(identity) || (entry.layer !== "index" && entry.layer !== "worktree") ||
      (entry.kind !== "deleted" && entry.kind !== "file") || (entry.kind === "file" && (entry.contentBase64 === undefined || (entry.mode !== "100644" && entry.mode !== "100755") || repositoryHash(Buffer.from(entry.contentBase64, "base64")) !== entry.sha256))) throw new Error("invalid snapshot entry");
    seen.add(identity);
  }
  return snapshot;
}

/** Only creates a NEW empty checkout. A base commit remains an explicit external dependency. */
export async function reconstructRepositorySnapshot(options: { readonly vaultRoot: string; readonly artifactId: string; readonly encryptionKey: Uint8Array; readonly sourceRepository: string; readonly destination: string }): Promise<{ readonly destination: string; readonly entries: number; readonly reconstruction: "complete" }> {
  const snapshot = await readRepositorySnapshot(options);
  if (snapshot.reconstruction !== "complete" || snapshot.exclusions.length !== 0 || snapshot.entries.some((entry) => entry.redacted)) throw new Error("partial snapshot cannot reconstruct the original repository state");
  const requestedDestination = resolve(options.destination);
  const destination = join(await realpath(dirname(requestedDestination)), basename(requestedDestination)); const source = await realpath(options.sourceRepository);
  if (isWithin(source, destination) || isWithin(destination, source)) throw new Error("reconstruction destination must be separate from source repository");
  try { await lstat(destination); throw new Error("reconstruction requires a new destination"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await mkdir(destination, { recursive: false, mode: 0o700 });
  await gitBytes(destination, ["init", "--quiet"]);
  await gitBytes(destination, ["fetch", "--quiet", "--no-tags", "--", source, snapshot.baseCommit], { timeoutMs: 30_000 });
  // Fresh repository has no source-local filters or hooks; global config is disabled by gitBytes.
  await gitBytes(destination, ["-c", "core.autocrlf=false", "checkout", "--quiet", "--detach", snapshot.baseCommit]);
  for (const entry of snapshot.entries.filter((candidate) => candidate.layer === "index")) {
    const path = Buffer.from(entry.pathBase64, "base64");
    const objectId = entry.kind === "deleted" ? "0".repeat(snapshot.baseCommit.length) : (await gitBytes(destination, ["hash-object", "-w", "--stdin"], { input: Buffer.from(entry.contentBase64!, "base64") })).toString("ascii").trim();
    await gitBytes(destination, ["update-index", "-z", "--index-info"], { input: Buffer.concat([Buffer.from(`${entry.kind === "deleted" ? "0" : entry.mode} ${objectId}\t`), path, Buffer.from([0])]) });
  }
  // Delete first so rename/file-to-directory changes can be applied without following old entries.
  for (const entry of snapshot.entries.filter((candidate) => candidate.layer === "worktree").sort((a, b) => (a.kind === "deleted" ? -1 : 1) - (b.kind === "deleted" ? -1 : 1))) {
    const path = Buffer.from(entry.pathBase64, "base64"); const absolute = absoluteRepositoryPath(destination, path);
    for (let index = Buffer.byteLength(destination) + 1; index < absolute.length; index += 1) if (absolute[index] === 47) {
      const directory = absolute.subarray(0, index);
      await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
      if (!(await lstat(directory)).isDirectory()) throw new Error("reconstruction path traverses non-directory");
    }
    if (entry.kind === "deleted") { await unlink(absolute).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; }); continue; }
    const file = await open(absolute, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, entry.mode === "100755" ? 0o755 : 0o644);
    try { await file.writeFile(Buffer.from(entry.contentBase64!, "base64")); await file.chmod(entry.mode === "100755" ? 0o755 : 0o644); await file.sync(); } finally { await file.close(); }
  }
  const restored = await repositorySentinel(destination);
  if (`git:${restored.head}:worktree:${await repositoryWorktreeDigest(destination, restored)}` !== snapshot.sourceRevisionId) throw new Error("restored repository does not match the witnessed source revision");
  return { destination, entries: snapshot.entries.length, reconstruction: "complete" };
}
