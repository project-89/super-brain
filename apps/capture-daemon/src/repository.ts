import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

export const repositoryHash = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");

/** Never trim Git machine output: path bytes may include spaces, newlines or invalid UTF-8. */
export function gitBytes(root: string, args: readonly string[], options: { readonly input?: Uint8Array; readonly maxBytes?: number; readonly timeoutMs?: number } = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", root, ...args], {
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" }, stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks: Buffer[] = []; let size = 0; let failure: Error | undefined;
    const stop = (error: Error) => { failure ??= error; child.kill("SIGKILL"); };
    const timer = setTimeout(() => stop(new Error("repository inspection timed out")), options.timeoutMs ?? 3_000);
    child.stdout.on("data", (chunk: Buffer) => { size += chunk.length; if (size > (options.maxBytes ?? 16 * 1024 * 1024)) stop(new Error("repository inspection exceeded byte limit")); else chunks.push(chunk); });
    child.stderr.resume(); // Diagnostics can contain private paths/configuration; never publish them.
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); if (failure !== undefined) reject(failure); else if (code !== 0) reject(new Error("repository inspection failed")); else resolve(Buffer.concat(chunks)); });
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.input);
  });
}

export function nulFields(bytes: Buffer): Buffer[] {
  const values: Buffer[] = []; let start = 0;
  for (let index = 0; index < bytes.length; index += 1) if (bytes[index] === 0) { values.push(bytes.subarray(start, index)); start = index + 1; }
  if (start !== bytes.length) throw new TypeError("unterminated Git path record");
  return values;
}

export interface RepositoryStatusEntry { readonly status: string; readonly path: Buffer; readonly previousPath?: Buffer }
export function parseRepositoryStatus(bytes: Buffer): RepositoryStatusEntry[] {
  const fields = nulFields(bytes); const result: RepositoryStatusEntry[] = [];
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i]!;
    if (field.length < 4 || field[2] !== 32) throw new TypeError("invalid Git status record");
    const status = field.subarray(0, 2).toString("ascii");
    const renamed = status.includes("R") || status.includes("C");
    const previousPath = renamed ? fields[++i] : undefined;
    if (renamed && previousPath === undefined) throw new TypeError("missing Git rename source");
    result.push({ status, path: field.subarray(3), ...(previousPath === undefined ? {} : { previousPath }) });
  }
  return result;
}

export interface IndexEntry { readonly mode: string; readonly objectId: string; readonly stage: number; readonly path: Buffer }
export function parseIndexEntries(bytes: Buffer): IndexEntry[] {
  return nulFields(bytes).map((field) => {
    const tab = field.indexOf(9); const header = field.subarray(0, tab).toString("ascii");
    const match = /^(\d{6}) ([a-f0-9]{40,64}) ([0-3])$/.exec(header);
    if (tab < 0 || match === null) throw new TypeError("invalid Git index entry");
    return { mode: match[1]!, objectId: match[2]!, stage: Number(match[3]), path: field.subarray(tab + 1) };
  });
}

export function safeRepositoryPath(path: Buffer): boolean {
  if (path.length === 0 || path[0] === 47 || path.includes(0)) return false;
  return path.toString("latin1").split("/").every((part) => part !== "" && part !== "." && part !== ".." && part.toLowerCase() !== ".git");
}
export function absoluteRepositoryPath(root: string, path: Buffer): Buffer {
  if (!safeRepositoryPath(path)) throw new TypeError("unsafe repository path");
  return Buffer.concat([Buffer.from(root), Buffer.from("/"), path]);
}

/** Refuse symlink components and use O_NOFOLLOW on the final open. */
export async function readRepositoryFile(root: string, path: Buffer, remainingBytes: number): Promise<{ readonly bytes: Buffer; readonly mode: "100644" | "100755" } | undefined> {
  const absolute = absoluteRepositoryPath(root, path);
  for (let index = Buffer.byteLength(root) + 1; index < absolute.length; index += 1) if (absolute[index] === 47) {
    const directory = await lstat(absolute.subarray(0, index));
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("unsafe repository path component");
  }
  let file;
  try { file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > remainingBytes) throw new Error("repository file excluded by type or byte limit");
    const bytes = Buffer.alloc(before.size); let offset = 0;
    while (offset < bytes.length) { const read = await file.read(bytes, offset, bytes.length - offset, offset); if (read.bytesRead === 0) break; offset += read.bytesRead; }
    const after = await file.stat(); const current = await lstat(absolute);
    if (offset !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.mode !== after.mode || before.ino !== current.ino || before.dev !== current.dev) throw new Error("repository file changed during read");
    return { bytes, mode: (before.mode & 0o111) === 0 ? "100644" : "100755" };
  } finally { await file.close(); }
}

export async function repositorySentinel(root: string): Promise<{ readonly head: string; readonly status: Buffer; readonly index: Buffer; readonly staged: Buffer; readonly unstaged: Buffer }> {
  const [head, status, index, staged, unstaged, flags, configuration] = await Promise.all([
    gitBytes(root, ["rev-parse", "--verify", "HEAD"]),
    gitBytes(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    gitBytes(root, ["ls-files", "--stage", "-z"]),
    gitBytes(root, ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--binary", "--full-index", "HEAD", "--"]),
    gitBytes(root, ["diff", "--no-ext-diff", "--no-textconv", "--binary", "--full-index", "--"]),
    gitBytes(root, ["ls-files", "-v", "-z"]), gitBytes(root, ["config", "--null", "--list"]),
  ]);
  const hidden = nulFields(flags).some((entry) => entry[0] === 83 || (entry[0]! >= 97 && entry[0]! <= 122));
  const unsupportedIndex = parseIndexEntries(index).some((entry) => entry.stage !== 0 || !["100644", "100755"].includes(entry.mode));
  const settings = new Map(nulFields(configuration).map((entry) => { const newline = entry.indexOf(10); return [entry.subarray(0, newline).toString("utf8").toLowerCase(), entry.subarray(newline + 1).toString("utf8").toLowerCase()] as const; }));
  const attributes = nulFields(await gitBytes(root, ["check-attr", "-a", "-z", "--stdin"], { input: Buffer.concat(parseIndexEntries(index).flatMap((entry) => [entry.path, Buffer.from([0])])) }));
  const transforms = attributes.some((entry, ordinal) => ordinal % 3 === 1 && ["filter", "working-tree-encoding", "eol", "text", "ident"].includes(entry.toString("ascii")));
  if (hidden || unsupportedIndex || transforms || settings.get("core.filemode") === "false" || (settings.has("core.autocrlf") && settings.get("core.autocrlf") !== "false")) throw new Error("unsupported repository checkout semantics");
  return { head: head.toString("ascii").trim(), status, index, staged, unstaged };
}
export function sentinelDigest(value: Awaited<ReturnType<typeof repositorySentinel>>): string {
  return repositoryHash(Buffer.concat([Buffer.from(value.head), Buffer.from([0]), value.status, value.index, value.staged, value.unstaged]));
}

/** Bind raw bytes and modes, including index/worktree cancellation and untracked content. */
export async function repositoryWorktreeDigest(root: string, sentinel: Awaited<ReturnType<typeof repositorySentinel>>): Promise<string> {
  const paths = new Map<string, Buffer>();
  for (const entry of parseRepositoryStatus(sentinel.status)) {
    paths.set(entry.path.toString("base64"), entry.path);
    if (entry.previousPath !== undefined) paths.set(entry.previousPath.toString("base64"), entry.previousPath);
  }
  const contents: Buffer[] = []; let bytes = 0;
  for (const path of [...paths.values()].sort(Buffer.compare)) {
    const file = await readRepositoryFile(root, path, 16 * 1024 * 1024 - bytes);
    bytes += file?.bytes.length ?? 0;
    contents.push(path, Buffer.from(file === undefined ? "\0deleted\0" : `\0${file.mode}\0${repositoryHash(file.bytes)}\0`));
  }
  return repositoryHash(Buffer.concat([Buffer.from(sentinelDigest(sentinel)), ...contents]));
}
