import { execFile } from "node:child_process";
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

export async function resolveProject(cwdInput: string | undefined, branchInput?: string): Promise<ProjectIdentity> {
  const cwd = resolve(cwdInput?.trim() || process.cwd());
  const root = (await git(cwd, ["rev-parse", "--show-toplevel"])) ?? cwd;
  const remote = await git(root, ["remote", "get-url", "origin"]);
  const branch = branchInput?.trim() || (await git(root, ["branch", "--show-current"])) || "unknown";
  const project = projectForRoot(root, remote);
  return {
    id: project.id,
    name: project.name,
    root,
    branch,
    ...(project.remote === undefined ? {} : { remote: project.remote }),
  };
}
