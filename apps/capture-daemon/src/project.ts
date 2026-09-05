import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { lstat, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

import { projectForRoot } from "@_89/super-brain-importer";

import type { ProjectIdentity } from "./types.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: readonly string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
      timeout: 750,
      maxBuffer: 16 * 1024 * 1024,
      encoding: "utf8",
    });
    const value = stdout.trim();
    return value.length === 0 ? undefined : value;
  } catch {
    return undefined;
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function statusPaths(status: string | undefined): readonly string[] {
  if (status === undefined) return [];
  return [...new Set(status.split("\n").flatMap((line) => {
    if (line.length < 4) return [];
    const path = line.slice(3).split(" -> ").at(-1)?.replace(/^"|"$/g, "").trim();
    return path === undefined || path.length === 0 ? [] : [path];
  }))].sort();
}

export async function refreshProject(project: ProjectIdentity): Promise<ProjectIdentity> {
  const inspect = async (args: readonly string[]) => {
    try {
      const { stdout } = await execFileAsync("git", ["-C", project.root, ...args], { timeout: 750, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" });
      return { available: true, value: stdout.trim() };
    } catch { return { available: false, value: "" }; }
  };
  const [head, branch, status, diff, untracked] = await Promise.all([
    inspect(["rev-parse", "HEAD"]), inspect(["branch", "--show-current"]),
    inspect(["status", "--porcelain=v1", "--untracked-files=all"]), inspect(["diff", "--no-ext-diff", "--binary", "HEAD", "--"]), inspect(["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  let untrackedDigest = "";
  let untrackedAvailable = untracked.available;
  let bytes = 0;
  const fingerprints: string[] = [];
  for (const path of untracked.value.split("\0").filter(Boolean)) {
    try {
      const absolute = resolve(project.root, path);
      if (relative(project.root, absolute).startsWith("..")) throw new Error("untracked path outside project");
      const metadata = await lstat(absolute);
      bytes += metadata.size;
      if (!metadata.isFile() || bytes > 16 * 1024 * 1024) throw new Error("untracked fingerprint unavailable");
      const content = await readFile(absolute);
      const after = await lstat(absolute);
      if (after.size !== metadata.size || after.mtimeMs !== metadata.mtimeMs) throw new Error("untracked file changed during fingerprint");
      fingerprints.push(`${path}\0${createHash("sha256").update(content).digest("hex")}`);
    } catch { untrackedAvailable = false; break; }
  }
  if (untrackedAvailable) untrackedDigest = fingerprints.join("\0");
  if (!untrackedAvailable || ![head, branch, status, diff].every((value) => value.available) || head.value.length === 0) {
    const { head: _head, worktreeDigest: _digest, dirty: _dirty, changedPaths: _paths, ...unavailable } = project;
    return { ...unavailable, fingerprintStatus: "unavailable" };
  }
  const changedPaths = statusPaths(status.value);
  return { ...project, branch: branch.value || project.branch, head: head.value, dirty: changedPaths.length > 0,
    changedPaths, worktreeDigest: digest(`${status.value}\0${diff.value}${untrackedDigest.length === 0 ? "" : `\0${untrackedDigest}`}`), fingerprintStatus: "available" };
}

export async function resolveProject(cwdInput: string | undefined, branchInput?: string): Promise<ProjectIdentity> {
  const cwd = resolve(cwdInput?.trim() || process.cwd());
  const root = (await git(cwd, ["rev-parse", "--show-toplevel"])) ?? cwd;
  const [remote, observedBranch] = await Promise.all([
    git(root, ["remote", "get-url", "origin"]), git(root, ["branch", "--show-current"]),
  ]);
  const branch = branchInput?.trim() || observedBranch || "unknown";
  const project = projectForRoot(root, remote);
  return refreshProject({
    id: project.id,
    name: project.name,
    root,
    branch,
    ...(project.remote === undefined ? {} : { remote: project.remote }),
  });
}
