import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type TranscriptProject, type TranscriptRun } from "@_89/fold-transcript";
import { describe, expect, it, vi } from "vitest";

import { analyzeProjectIdentities, inventoryProjectIdentities, normalizeProjectRemote, normalizeProjectRoot, writeProjectIdentityReport } from "../src/project-identities.js";

function project(id: string, options: Partial<TranscriptProject> = {}): TranscriptProject {
  return { id, name: "same-name", identityKeyHash: "a".repeat(64), resolution: "resolved", roots: [], ...options };
}

function run(id: string, options: Partial<TranscriptRun> = {}): TranscriptRun {
  return {
    id, nativeId: id, source: "codex", artifactId: `artifact-${id}`, projectResolution: "resolved",
    counts: { records: 0, turns: 0, messages: 0, actions: 0, unknown: 0 }, segments: [], ...options,
  };
}

function analyze(projects: readonly TranscriptProject[], runs: readonly TranscriptRun[] = []) {
  return analyzeProjectIdentities({ projects, runs, organizationId: "org-a", workspaceId: "workspace-a", generatedAt: "2026-09-14T12:00:00.000Z" });
}

describe("read-only project identity review", () => {
  it("strips transport credentials, query, and fragment and equates standard GitHub transports only", () => {
    expect(normalizeProjectRemote("https://user:super-secret@GitHub.com/Project-89/Brain.git?token=secret#secret"))
      .toBe("github.com/Project-89/Brain");
    expect(normalizeProjectRemote("git@github.com:Project-89/Brain.git")).toBe("github.com/Project-89/Brain");
    expect(normalizeProjectRemote("ssh://git@github.com/Project-89/Brain.git")).toBe("github.com/Project-89/Brain");
    expect(normalizeProjectRemote("https://user:secret@git.example/Owner/Repo?access_token=secret"))
      .toBe("https://git.example/Owner/Repo");
    expect(normalizeProjectRemote("ssh://git@git.example/Owner/Repo")).not.toBe(normalizeProjectRemote("https://git.example/Owner/Repo"));
    expect(normalizeProjectRemote("git@git.example:Owner/Repo")).not.toBe(normalizeProjectRemote("ssh://git@git.example/Owner/Repo"));
  });

  it("preserves host, protocol, explicit port, and path case differences", () => {
    const inputs = [
      "https://github.com/Owner/Repo.git", "https://github.com/owner/Repo.git",
      "https://github.com/Owner/repo.git", "https://github.com:443/Owner/Repo.git",
      "https://github.com:444/Owner/Repo.git", "ssh://git@github.com:22/Owner/Repo.git",
      "https://other.example/Owner/Repo.git", "http://github.com/Owner/Repo.git",
    ];
    expect(new Set(inputs.map(normalizeProjectRemote)).size).toBe(inputs.length);
    expect(normalizeProjectRemote("https://github.com:443/Owner/Repo.git")).toBe("https://github.com:443/Owner/Repo.git");
    expect(normalizeProjectRemote("https://host:70000/Owner/Repo")).toBeUndefined();
    expect(normalizeProjectRemote("not a remote with secret")).toBeUndefined();
    expect(normalizeProjectRemote("file:///tmp/repo")).toBeUndefined();
    expect(normalizeProjectRemote("https://[aa]/Owner/Repo")).toBeUndefined();
    expect(normalizeProjectRemote("https://github.com:port/Owner/Repo")).toBeUndefined();
    expect(normalizeProjectRemote("https://github.com/Owner/../Repo")).toBeUndefined();
    expect(normalizeProjectRemote("https://github.com/Owner/%2e%2e/Repo")).toBeUndefined();
  });

  it("does not group on names alone or leak unsupported remote content", () => {
    const report = analyze([project("a"), project("b", { remote: "invalid secret remote" })]);
    expect(report.candidates).toEqual([]);
    expect(report.summary.unsupportedRemotes).toBe(1);
    expect(JSON.stringify(report)).not.toContain("secret");
    expect(JSON.stringify(report)).not.toContain("same-name");
  });

  it("matches remote evidence without choosing a canonical winner or changing inputs", () => {
    const projects = [project("z", { remote: "git@github.com:Owner/Repo.git" }), project("a", { remote: "https://secret:password@github.com/Owner/Repo.git" })];
    const original = structuredClone(projects);
    const report = analyze(projects);
    expect(report.candidates).toEqual([{
      projectIds: ["a", "z"], status: "needs-review", conflicts: [],
      evidence: [{ kind: "same-normalized-remote", remote: "github.com/Owner/Repo" }],
    }]);
    expect(report.scope).toEqual({ organizationId: "org-a", workspaceId: "workspace-a" });
    expect(projects).toEqual(original);
    expect(JSON.stringify(report)).not.toContain("password");
    expect(JSON.stringify(report)).not.toContain("confidence");
  });

  it("retains concrete project, run, and segment evidence for exact shared paths", () => {
    const report = analyze([project("a", { roots: ["/work/Repo/"] }), project("b"), project("c")], [
      run("r1", { projectId: "b", cwd: "/work/Repo", segments: [{ id: "s1", ordinal: 0, projectId: "c", resolution: "resolved", cwd: "/work/Repo" }] }),
      run("r2", { projectId: "b", cwd: "/work/Other", segments: [{ id: "unresolved", ordinal: 0, resolution: "unassigned", cwd: "/work/Repo" }] }),
    ]);
    expect(report.candidates).toHaveLength(3);
    expect(report.candidates.find((candidate) => candidate.projectIds.join(",") === "a,b")?.evidence).toEqual([{
      kind: "shared-filesystem-path", path: "/work/Repo", observations: [
        { projectId: "a", source: "project-root" }, { projectId: "b", source: "run-cwd", runId: "r1" },
      ],
    }]);
    expect(report.candidates.find((candidate) => candidate.projectIds.join(",") === "a,c")?.evidence).toEqual([{
      kind: "shared-filesystem-path", path: "/work/Repo", observations: [
        { projectId: "a", source: "project-root" }, { projectId: "c", source: "segment-cwd", runId: "r1", segmentId: "s1" },
      ],
    }]);
    expect(JSON.stringify(report)).not.toContain("unresolved");
  });

  it("flags remote conflicts even when a no-remote identity bridges different repositories", () => {
    const report = analyze([
      project("a", { roots: ["/work/shared"] }),
      project("b", { roots: ["/work/shared"], remote: "https://github.com/Owner/One.git" }),
      project("c", { roots: ["/work/shared"], remote: "https://github.com/Owner/Two.git" }),
    ]);
    expect(report.summary.conflictingCandidates).toBe(3);
    for (const candidate of report.candidates) {
      expect(candidate.status).toBe("needs-review");
      expect(candidate.conflicts).toEqual([{ kind: "different-remotes-at-shared-path", path: "/work/shared", remotes: ["github.com/Owner/One", "github.com/Owner/Two"] }]);
    }
  });

  it("does not conflate path case, relative paths, or child directories", () => {
    expect(normalizeProjectRoot("/work/Repo/")).toBe("/work/Repo");
    expect(normalizeProjectRoot("C:\\work\\Repo\\")).toBe("C:/work/Repo");
    expect(normalizeProjectRoot("./Repo")).toBeUndefined();
    const report = analyze([
      project("a", { roots: ["/work/Repo"] }), project("b", { roots: ["/work/repo"] }),
      project("c", { roots: ["/work/Repo/child"] }), project("d", { roots: ["./Repo"] }),
    ], [run("missing", { projectId: "unknown", cwd: "/work/Repo" })]);
    expect(report.candidates).toEqual([]);
    expect(report.summary).toMatchObject({ unrecognizedPaths: 1, unknownProjectReferences: 1 });
  });

  it("fails explicitly instead of truncating an excessive shared-path fanout", () => {
    expect(() => analyze(Array.from({ length: 143 }, (_, index) => project(`project-${index}`, { roots: ["/workspace"] }))))
      .toThrow("exceeds 10000 candidate pairs");
  });

  it("writes a private exclusive report and refuses overwrite or symlink targets", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fold-identity-"));
    try {
      const path = join(dir, "report.json");
      const report = analyze([project("a")]);
      await writeProjectIdentityReport(path, report);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual(report);
      await expect(writeProjectIdentityReport(path, report)).rejects.toMatchObject({ code: "EEXIST" });
      const target = join(dir, "target");
      await writeFile(target, "untouched");
      const link = join(dir, "link");
      await symlink(target, link);
      await expect(writeProjectIdentityReport(link, report)).rejects.toMatchObject({ code: "EEXIST" });
      expect(await readFile(target, "utf8")).toBe("untouched");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("reads the authorized catalog with cursor pagination and performs GET requests only", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fold-identity-api-"));
    const urls: URL[] = [];
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const parsed = new URL(String(url));
      urls.push(parsed);
      expect(init?.method ?? "GET").toBe("GET");
      expect(init?.headers).toEqual({ authorization: "Bearer private-test-token" });
      expect(init?.signal).toBeDefined();
      if (parsed.pathname.endsWith("transcript-projects")) return Response.json({ projects: [{ project: project("a") }, { project: project("b") }] });
      expect(parsed.searchParams.get("limit")).toBe("100");
      return parsed.searchParams.get("pageCursor") === null
        ? Response.json({ runs: [run("r1", { projectId: "a", cwd: "/work/Repo" })], nextCursor: "page-2" })
        : Response.json({ runs: [run("r2", { projectId: "b", cwd: "/work/Repo" })] });
    }) as typeof fetch;
    try {
      const report = await inventoryProjectIdentities({ apiUrl: "http://localhost:3003", organizationId: "org-a", workspaceId: "workspace-a", bearerToken: "private-test-token", reportPath: join(dir, "report.json"), fetcher });
      expect(report.summary).toMatchObject({ projects: 2, runs: 2, candidates: 1 });
      expect(urls).toHaveLength(3);
      expect(urls.every((url) => url.pathname.startsWith("/v1/organizations/org-a/workspaces/workspace-a/"))).toBe(true);
      expect(urls[2]?.searchParams.get("pageCursor")).toBe("page-2");
      expect(JSON.stringify(report)).not.toContain("private-test-token");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("fails closed on repeated cursors instead of publishing a partial inventory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fold-identity-cursor-"));
    const path = join(dir, "report.json");
    const fetcher = vi.fn(async (url: string | URL | Request) => String(url).includes("transcript-projects")
      ? Response.json({ projects: [] }) : Response.json({ runs: [], nextCursor: "repeat" })) as typeof fetch;
    try {
      await expect(inventoryProjectIdentities({ apiUrl: "http://localhost:3003", organizationId: "org-a", workspaceId: "workspace-a", bearerToken: "token", reportPath: path, fetcher }))
        .rejects.toThrow("invalid cursor");
      await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
