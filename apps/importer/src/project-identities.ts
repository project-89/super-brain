import { writeFile } from "node:fs/promises";
import { posix, win32 } from "node:path";

import { type TranscriptProject, type TranscriptRun } from "@_89/fold-transcript";

import { listDeliveredTranscriptProjects, listDeliveredTranscriptRuns, type TranscriptDeliveryOptions } from "./delivery.js";

/** Comparison hints only: never used to change the immutable source project ID. */
export function normalizeProjectRemote(remote: string): string | undefined {
  const value = remote.trim();
  if (/[\s\\]/.test(value)) return undefined;
  let urlValue = value;
  const scpStyle = !value.includes("://");
  if (scpStyle) {
    const scp = /^(?:[^@/:]+@)?([^@/:]+):([^?#]+)(?:[?#].*)?$/.exec(value);
    if (scp === null) return undefined;
    urlValue = `ssh://${scp[1]!}/${scp[2]!}`;
  }
  let url: URL;
  try { url = new URL(urlValue); } catch { return undefined; }
  const protocol = url.protocol.slice(0, -1);
  if (!["https", "http", "ssh", "git"].includes(protocol) || !url.hostname) return undefined;
  // URL.port drops explicit default ports, which must remain distinct review evidence.
  const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(urlValue)?.[1];
  if (authority === undefined) return undefined;
  const hostPort = authority.slice(authority.lastIndexOf("@") + 1);
  const port = /:([0-9]+)$/.exec(hostPort)?.[1];
  const host = url.hostname.toLowerCase();
  const path = url.pathname;
  if (path === "" || path === "/") return undefined;
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65_535)) return undefined;
  const rawPath = urlValue.slice(urlValue.indexOf("://") + 3 + authority.length).split(/[?#]/, 1)[0];
  // Do not conflate a path normalized by URL's dot-segment or encoding rules.
  if (rawPath !== path) return undefined;
  // Only GitHub's standard transport forms are equated across protocols.
  if (host === "github.com" && port === undefined && ["https", "ssh"].includes(protocol) && /^\/[^/]+\/[^/]+\/?$/.test(path)) {
    return `github.com${path.replace(/\/$/, "").replace(/\.git$/, "")}`;
  }
  return `${scpStyle ? "scp" : protocol}://${host}${port === undefined ? "" : `:${port}`}${path}`;
}

export function normalizeProjectRoot(root: string): string | undefined {
  if (root.includes("\0")) return undefined;
  if (/^[a-z]:[\\/]/i.test(root) || root.startsWith("\\\\")) {
    const normalized = win32.normalize(root).replace(/\\/g, "/");
    return normalized.length > 3 ? normalized.replace(/\/$/, "") : normalized;
  }
  if (!posix.isAbsolute(root)) return undefined;
  const normalized = posix.normalize(root);
  return normalized.length > 1 ? normalized.replace(/\/$/, "") : normalized;
}

export interface ProjectRootEvidence {
  readonly projectId: string;
  readonly source: "project-root" | "run-cwd" | "segment-cwd";
  readonly runId?: string;
  readonly segmentId?: string;
}

export interface ProjectIdentityCandidate {
  readonly projectIds: readonly [string, string];
  readonly status: "needs-review";
  readonly evidence: readonly ({ readonly kind: "same-normalized-remote"; readonly remote: string } | {
    readonly kind: "shared-filesystem-path";
    readonly path: string;
    readonly observations: readonly ProjectRootEvidence[];
  })[];
  readonly conflicts: readonly { readonly kind: "different-remotes-at-shared-path"; readonly path: string; readonly remotes: readonly string[] }[];
}

export interface ProjectIdentityReport {
  readonly version: 1;
  readonly kind: "project-identity-review";
  readonly generatedAt: string;
  readonly scope: { readonly organizationId: string; readonly workspaceId: string };
  readonly mode: "read-only";
  readonly coverage: "authorized transcript catalog; not an atomic snapshot";
  readonly summary: {
    readonly projects: number;
    readonly runs: number;
    readonly candidates: number;
    readonly conflictingCandidates: number;
    readonly unsupportedRemotes: number;
    readonly unrecognizedPaths: number;
    readonly unknownProjectReferences: number;
  };
  readonly projects: readonly { readonly id: string; readonly resolution: TranscriptProject["resolution"]; readonly normalizedRemote?: string; readonly remoteStatus: "available" | "absent" | "unsupported" }[];
  readonly candidates: readonly ProjectIdentityCandidate[];
}

export function analyzeProjectIdentities(input: {
  readonly projects: readonly TranscriptProject[];
  readonly runs: readonly TranscriptRun[];
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly generatedAt?: string;
}): ProjectIdentityReport {
  if (!input.organizationId.trim() || !input.workspaceId.trim()) throw new TypeError("project identity review requires organization and workspace IDs");
  const projectIds = new Set(input.projects.map((project) => project.id));
  if (projectIds.size !== input.projects.length) throw new TypeError("project identity review received duplicate project IDs");
  const projects = input.projects.map((project) => {
    const normalizedRemote = project.remote === undefined ? undefined : normalizeProjectRemote(project.remote);
    return {
      id: project.id,
      resolution: project.resolution,
      ...(normalizedRemote === undefined ? {} : { normalizedRemote }),
      remoteStatus: project.remote === undefined ? "absent" as const : normalizedRemote === undefined ? "unsupported" as const : "available" as const,
    };
  }).sort((a, b) => compare(a.id, b.id));
  const remotes = new Map(projects.map((project) => [project.id, project.normalizedRemote]));
  const remoteIndex = new Map<string, Set<string>>();
  const roots = new Map<string, ProjectRootEvidence[]>();
  let unrecognizedPaths = 0;
  let unknownProjectReferences = 0;
  const addRoot = (root: string | undefined, evidence: ProjectRootEvidence) => {
    if (!projectIds.has(evidence.projectId)) { unknownProjectReferences++; return; }
    if (root === undefined) return;
    const normalized = normalizeProjectRoot(root);
    if (normalized === undefined) { unrecognizedPaths++; return; }
    const observations = roots.get(normalized) ?? [];
    observations.push(evidence);
    roots.set(normalized, observations);
  };
  for (const project of input.projects) {
    const remote = remotes.get(project.id);
    if (remote !== undefined) {
      const ids = remoteIndex.get(remote) ?? new Set<string>();
      ids.add(project.id);
      remoteIndex.set(remote, ids);
    }
    for (const root of project.roots) addRoot(root, { projectId: project.id, source: "project-root" });
  }
  for (const run of input.runs) {
    if (run.projectId !== undefined) addRoot(run.cwd, { projectId: run.projectId, source: "run-cwd", runId: run.id });
    for (const segment of run.segments) {
      // A segment without a project is unresolved, not an implicit match to its run.
      if (segment.projectId !== undefined) addRoot(segment.cwd, { projectId: segment.projectId, source: "segment-cwd", runId: run.id, segmentId: segment.id });
    }
  }
  const candidates = new Map<string, { projectIds: [string, string]; status: "needs-review"; evidence: ProjectIdentityCandidate["evidence"][number][]; conflicts: ProjectIdentityCandidate["conflicts"][number][] }>();
  const pairs = (ids: Iterable<string>, visit: (candidate: NonNullable<ReturnType<typeof candidates.get>>) => void) => {
    const sorted = [...new Set(ids)].sort(compare);
    if (sorted.length * (sorted.length - 1) / 2 > 10_000) {
      throw new RangeError("project identity review exceeds 10000 candidate pairs; narrow the authorized workspace before retrying");
    }
    for (let left = 0; left < sorted.length; left++) {
      for (let right = left + 1; right < sorted.length; right++) {
        const projectIds: [string, string] = [sorted[left]!, sorted[right]!];
        const key = JSON.stringify(projectIds);
        const candidate = candidates.get(key) ?? { projectIds, status: "needs-review", evidence: [], conflicts: [] };
        if (!candidates.has(key) && candidates.size >= 10_000) {
          throw new RangeError("project identity review exceeds 10000 candidate pairs; narrow the authorized workspace before retrying");
        }
        visit(candidate);
        candidates.set(key, candidate);
      }
    }
  };
  for (const [remote, ids] of remoteIndex) pairs(ids, (candidate) => candidate.evidence.push({ kind: "same-normalized-remote", remote }));
  for (const [path, observations] of roots) {
    const ids = new Set(observations.map((observation) => observation.projectId));
    const sharedRemotes = [...new Set([...ids].flatMap((id) => remotes.get(id) === undefined ? [] : [remotes.get(id)!]))].sort(compare);
    pairs(ids, (candidate) => {
      candidate.evidence.push({ kind: "shared-filesystem-path", path, observations: observations.filter((observation) => candidate.projectIds.includes(observation.projectId)) });
      // Include all remotes sharing this path: an unresolved project must not bridge incompatible identities.
      if (sharedRemotes.length > 1) candidate.conflicts.push({ kind: "different-remotes-at-shared-path", path, remotes: sharedRemotes });
    });
  }
  const results = [...candidates.values()].sort((a, b) => compare(JSON.stringify(a.projectIds), JSON.stringify(b.projectIds)));
  return {
    version: 1,
    kind: "project-identity-review",
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    scope: { organizationId: input.organizationId, workspaceId: input.workspaceId },
    mode: "read-only",
    coverage: "authorized transcript catalog; not an atomic snapshot",
    summary: {
      projects: projects.length, runs: input.runs.length, candidates: results.length,
      conflictingCandidates: results.filter((candidate) => candidate.conflicts.length > 0).length,
      unsupportedRemotes: projects.filter((project) => project.remoteStatus === "unsupported").length,
      unrecognizedPaths, unknownProjectReferences,
    },
    projects,
    candidates: results,
  };
}

function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

export async function writeProjectIdentityReport(path: string, report: ProjectIdentityReport): Promise<void> {
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

export async function inventoryProjectIdentities(options: TranscriptDeliveryOptions & { readonly organizationId: string; readonly reportPath: string }): Promise<ProjectIdentityReport> {
  const projects = await listDeliveredTranscriptProjects(options);
  const runs = await listDeliveredTranscriptRuns(options);
  const report = analyzeProjectIdentities({ projects, runs, organizationId: options.organizationId, workspaceId: options.workspaceId });
  await writeProjectIdentityReport(options.reportPath, report);
  return report;
}
