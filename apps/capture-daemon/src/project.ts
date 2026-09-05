import { resolve } from "node:path";
import { realpath } from "node:fs/promises";
import { projectForRoot } from "@_89/super-brain-importer";
import { gitBytes, parseRepositoryStatus, repositorySentinel, repositoryWorktreeDigest, sentinelDigest } from "./repository.js";
import type { ProjectIdentity } from "./types.js";

async function git(root: string, args: readonly string[]): Promise<string | undefined> {
  try { return (await gitBytes(root, args)).toString("utf8").replace(/\n$/, "") || undefined; } catch { return undefined; }
}

export async function refreshProject(project: ProjectIdentity): Promise<ProjectIdentity> {
  try {
    const before = await repositorySentinel(project.root);
    const status = parseRepositoryStatus(before.status);
    const worktreeDigest = await repositoryWorktreeDigest(project.root, before);
    const after = await repositorySentinel(project.root);
    if (sentinelDigest(before) !== sentinelDigest(after) || worktreeDigest !== await repositoryWorktreeDigest(project.root, after)) throw new Error("repository changed during fingerprint");
    const branch = await git(project.root, ["branch", "--show-current"]);
    const { fingerprintReason: _previousReason, ...available } = project;
    return { ...available, ...(branch === undefined ? {} : { branch }), head: before.head,
      dirty: status.length > 0, changedPaths: status.map((entry) => entry.path.toString("utf8")),
      worktreeDigest, fingerprintStatus: "available" };
  } catch (error) {
    const { head: _head, worktreeDigest: _digest, dirty: _dirty, changedPaths: _paths, ...unavailable } = project;
    return { ...unavailable, fingerprintStatus: "unavailable", fingerprintReason: error instanceof Error && error.message === "unsupported repository checkout semantics" ? "unsupported-checkout" : "git-or-file-unavailable" };
  }
}

export async function resolveProject(cwdInput: string | undefined, branchInput?: string): Promise<ProjectIdentity> {
  const cwd = resolve(cwdInput || process.cwd());
  const observedRoot = (await git(cwd, ["rev-parse", "--show-toplevel"])) ?? cwd;
  const root = await realpath(observedRoot).catch(() => observedRoot);
  const [remote, observedBranch] = await Promise.all([git(root, ["remote", "get-url", "origin"]), git(root, ["branch", "--show-current"])]);
  const project = projectForRoot(root, remote);
  return refreshProject({ id: project.id, name: project.name, root, branch: branchInput || observedBranch || "unknown", ...(project.remote === undefined ? {} : { remote: project.remote }) });
}
