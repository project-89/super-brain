import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { resolve } from "node:path";

import { projectForRoot } from "@_89/super-brain-importer";

import type { ProjectIdentity } from "./types.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: readonly string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
      timeout: 750,
      maxBuffer: 128 * 1024,
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
  }))].sort().slice(0, 200);
}

export async function refreshProject(project: ProjectIdentity): Promise<ProjectIdentity> {
  const [head, branch, status, diff] = await Promise.all([
    git(project.root, ["rev-parse", "HEAD"]),
    git(project.root, ["branch", "--show-current"]),
    git(project.root, ["status", "--porcelain=v1", "--untracked-files=all"]),
    git(project.root, ["diff", "--no-ext-diff", "--binary", "HEAD", "--"]),
  ]);
  if (head === undefined) return project;
  const changedPaths = statusPaths(status);
  return {
    ...project,
    branch: branch ?? project.branch,
    head,
    dirty: changedPaths.length > 0,
    changedPaths,
    worktreeDigest: digest(`${status ?? ""}\0${diff ?? ""}`),
  };
}

export async function resolveProject(cwdInput: string | undefined, branchInput?: string): Promise<ProjectIdentity> {
  const cwd = resolve(cwdInput?.trim() || process.cwd());
  const root = (await git(cwd, ["rev-parse", "--show-toplevel"])) ?? cwd;
  const [remote, observedBranch, head, status, diff] = await Promise.all([
    git(root, ["remote", "get-url", "origin"]),
    git(root, ["branch", "--show-current"]),
    git(root, ["rev-parse", "HEAD"]),
    git(root, ["status", "--porcelain=v1", "--untracked-files=all"]),
    git(root, ["diff", "--no-ext-diff", "--binary", "HEAD", "--"]),
  ]);
  const branch = branchInput?.trim() || observedBranch || "unknown";
  const project = projectForRoot(root, remote);
  const changedPaths = statusPaths(status);
  return {
    id: project.id,
    name: project.name,
    root,
    branch,
    ...(project.remote === undefined ? {} : { remote: project.remote }),
    ...(head === undefined ? {} : { head }),
    ...(head === undefined ? {} : { dirty: changedPaths.length > 0, changedPaths, worktreeDigest: digest(`${status ?? ""}\0${diff ?? ""}`) }),
  };
}
