import { chmod, mkdir, mkdtemp, readFile, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureVaultKey } from "@_89/super-brain-importer";
import { captureRepositorySnapshot, gitBytes, parseCaptureConfig, parseRepositoryStatus, readRepositorySnapshot, reconstructRepositorySnapshot, refreshProject, repositoryRevisionId, resolveProject } from "../src/index.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "capture-snapshot-")); const repository = join(root, "repo"); await mkdir(repository);
  await gitBytes(repository, ["init", "--quiet"]);
  await gitBytes(repository, ["config", "user.name", "Test"]); await gitBytes(repository, ["config", "user.email", "test@example.test"]);
  await writeFile(join(repository, "first.txt"), "initial\n"); await writeFile(join(repository, "remove.txt"), "remove\n"); await writeFile(join(repository, "rename.txt"), "rename\n");
  await gitBytes(repository, ["add", "."]); await gitBytes(repository, ["commit", "--quiet", "-m", "initial"]);
  const vaultKeyPath = join(root, "vault.key"); const { key } = await ensureVaultKey(vaultKeyPath);
  const config = parseCaptureConfig({ apiUrl: "http://127.0.0.1:3003", workspaceId: "workspace", apiToken: "api-token", sensorId: "urn:sensor:test", hookToken: "hook", operatorToken: "operator", stateRoot: join(root, "state"), vaultRoot: join(root, "vault"), vaultKeyPath,
    port: 8377, bindHost: "127.0.0.1", heartbeatWindowMs: 90_000, heartbeatIntervalMs: 30_000, reasoningPolicy: "exclude",
    repositoryCapture: { mode: "snapshot", roots: [repository], maxFiles: 100, maxBytes: 1024 * 1024, includeUntracked: true, includeBinary: true } });
  const capture = async () => { const project = await resolveProject(repository); return captureRepositorySnapshot(config, project, { sourceRevisionId: repositoryRevisionId(project)!, publicRevisionId: "revision:public", capturedAt: "2026-09-04T00:00:00.000Z" }); };
  return { root, repository, key, config, capture };
}

describe("private repository snapshots", () => {
  it("preserves NUL status path bytes, leading spaces, newlines and rename order", () => {
    const bytes = Buffer.concat([Buffer.from(" M  first\nname\0R  renamed -> literal\0old\nname\0?? "), Buffer.from([255]), Buffer.from("\0")]);
    const values = parseRepositoryStatus(bytes);
    expect(values[0]?.path.toString()).toBe(" first\nname");
    expect(values[1]).toMatchObject({ status: "R ", path: Buffer.from("renamed -> literal"), previousPath: Buffer.from("old\nname") });
    expect(values[2]?.path).toEqual(Buffer.from([255]));
  });

  it("reconstructs separate index/worktree edits, binary bytes, modes, deletions, renames and untracked paths", async () => {
    const f = await fixture();
    await writeFile(join(f.repository, "first.txt"), "staged\n"); await gitBytes(f.repository, ["add", "first.txt"]);
    await writeFile(join(f.repository, "first.txt"), "working\n"); await chmod(join(f.repository, "first.txt"), 0o755);
    await unlink(join(f.repository, "remove.txt"));
    await gitBytes(f.repository, ["mv", "rename.txt", " renamed\nfile"]);
    const binary = Buffer.from([0, 1, 255, 2, 0, 128]); await writeFile(join(f.repository, "binary.bin"), binary); await gitBytes(f.repository, ["add", "binary.bin"]);
    await writeFile(join(f.repository, " loose\nfile "), "untracked\n");
    const result = await f.capture(); expect(result.reconstruction).toBe("complete");
    const artifact = await readRepositorySnapshot({ vaultRoot: f.config.vaultRoot, artifactId: result.artifactId!, encryptionKey: f.key });
    expect(artifact.reviewPatches).toBe("included"); expect(Buffer.from(artifact.stagedPatchBase64!, "base64").toString()).toContain("GIT binary patch");
    expect(artifact.requiresBaseCommit).toBe(true); expect(artifact.entries.filter((entry) => Buffer.from(entry.pathBase64, "base64").toString() === "first.txt").map((entry) => Buffer.from(entry.contentBase64!, "base64").toString())).toEqual(["staged\n", "working\n"]);
    const destination = join(f.root, "restored");
    await reconstructRepositorySnapshot({ vaultRoot: f.config.vaultRoot, artifactId: result.artifactId!, encryptionKey: f.key, sourceRepository: f.repository, destination });
    expect(await readFile(join(destination, "binary.bin"))).toEqual(binary);
    expect(await readFile(join(destination, "first.txt"), "utf8")).toBe("working\n");
    expect((await stat(join(destination, "first.txt"))).mode & 0o111).not.toBe(0);
    expect((await gitBytes(destination, ["show", ":first.txt"])).toString()).toBe("staged\n");
    expect(await gitBytes(destination, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).toEqual(await gitBytes(f.repository, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]));
    await expect(reconstructRepositorySnapshot({ vaultRoot: f.config.vaultRoot, artifactId: result.artifactId!, encryptionKey: f.key, sourceRepository: f.repository, destination })).rejects.toThrow("new destination");
  });

  it("rejects a previously observed fingerprint after a stable intervening edit", async () => {
    const f = await fixture(); const project = await resolveProject(f.repository);
    await writeFile(join(f.repository, "first.txt"), "changed after fingerprint\n");
    const result = await captureRepositorySnapshot(f.config, project, { sourceRevisionId: repositoryRevisionId(project)!, publicRevisionId: "revision:old", capturedAt: "2026-09-04T00:00:00.000Z" });
    expect(result).toEqual({ reconstruction: "unavailable", reason: "repository-changing" });
  });

  it("rejects a destination parent that resolves through a symlink into the source", async () => {
    const f = await fixture(); const captured = await f.capture(); const alias = join(f.root, "repository-alias"); await symlink(f.repository, alias);
    await expect(reconstructRepositorySnapshot({ vaultRoot: f.config.vaultRoot, artifactId: captured.artifactId!, encryptionKey: f.key, sourceRepository: f.repository, destination: join(alias, "restored") })).rejects.toThrow("separate from source");
    await expect(stat(join(f.repository, "restored"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("redacts before base64 and refuses original reconstruction from partial evidence", async () => {
    const f = await fixture(); const secret = "sk-proj-abcdefghijklmnopqrstuvwx";
    await writeFile(join(f.repository, "first.txt"), `key ${secret}\n`);
    const result = await f.capture(); expect(result.reconstruction).toBe("partial");
    const artifact = await readRepositorySnapshot({ vaultRoot: f.config.vaultRoot, artifactId: result.artifactId!, encryptionKey: f.key });
    const decoded = artifact.entries.flatMap((entry) => entry.contentBase64 === undefined ? [] : [Buffer.from(entry.contentBase64, "base64").toString()]).join("\n");
    expect(decoded).not.toContain(secret); expect(decoded).toContain("[REDACTED]"); expect(artifact.reviewPatches).toBe("omitted-partial"); expect(artifact.stagedPatchBase64).toBeUndefined(); expect(artifact.unstagedPatchBase64).toBeUndefined();
    await expect(reconstructRepositorySnapshot({ vaultRoot: f.config.vaultRoot, artifactId: result.artifactId!, encryptionKey: f.key, sourceRepository: f.repository, destination: join(f.root, "partial") })).rejects.toThrow("partial snapshot");
  });

  it("excludes secrets in binary bytes instead of hiding them behind encoding", async () => {
    const f = await fixture(); await writeFile(join(f.repository, "secret.bin"), Buffer.concat([Buffer.from([0, 255]), Buffer.from("Bearer abcdefghijklmnopqrstuvwxyz")]));
    const result = await f.capture(); expect(result.reconstruction).toBe("partial");
    const artifact = await readRepositorySnapshot({ vaultRoot: f.config.vaultRoot, artifactId: result.artifactId!, encryptionKey: f.key });
    expect(artifact.exclusions).toContainEqual(expect.objectContaining({ reason: "binary-secret" }));
    expect(artifact.entries.some((entry) => Buffer.from(entry.pathBase64, "base64").toString() === "secret.bin")).toBe(false);
  });

  it("keeps legacy capture metadata-only and rejects roots without consent", async () => {
    const f = await fixture(); const project = await resolveProject(f.repository); const identity = { sourceRevisionId: repositoryRevisionId(project)!, publicRevisionId: "revision:a", capturedAt: "2026-09-04T00:00:00.000Z" };
    const { repositoryCapture: _policy, ...legacy } = f.config;
    expect(await captureRepositorySnapshot(legacy, project, identity)).toEqual({ reconstruction: "unavailable", reason: "metadata-only" });
    expect(await captureRepositorySnapshot({ ...f.config, repositoryCapture: { ...f.config.repositoryCapture!, roots: [join(f.root, "other")] } }, project, identity)).toEqual({ reconstruction: "unavailable", reason: "outside-consent" });
    expect(() => parseCaptureConfig({ ...f.config, repositoryCapture: { ...f.config.repositoryCapture, roots: [] } })).toThrow("consent roots");
  });

  it("never claims a clean gitlink or symlink is a complete regular-file checkout", async () => {
    const f = await fixture(); const head = (await gitBytes(f.repository, ["rev-parse", "HEAD"])).toString().trim();
    await gitBytes(f.repository, ["update-index", "--add", "--cacheinfo", `160000,${head},module`]);
    await gitBytes(f.repository, ["commit", "--quiet", "-m", "gitlink"]); await mkdir(join(f.repository, "module"));
    const result = await f.capture(); expect(result).toEqual({ reconstruction: "unavailable", reason: "fingerprint-unavailable" });
    expect(await resolveProject(f.repository)).toMatchObject({ fingerprintStatus: "unavailable", fingerprintReason: "unsupported-checkout" });
    await symlink(join(f.root, "vault.key"), join(f.repository, "outside-link"));
    expect((await refreshProject(await resolveProject(f.repository))).fingerprintStatus).toBe("unavailable");
  });

  it("respects byte and private storage exclusions without leaking excluded patch content", async () => {
    const f = await fixture(); await writeFile(join(f.repository, "first.txt"), "L".repeat(200));
    const project = await resolveProject(f.repository);
    const result = await captureRepositorySnapshot({ ...f.config, repositoryCapture: { ...f.config.repositoryCapture!, maxBytes: 10 } }, project, { sourceRevisionId: repositoryRevisionId(project)!, publicRevisionId: "revision:a", capturedAt: "2026-09-04T00:00:00.000Z" });
    expect(result.reconstruction).toBe("partial");
    const artifact = await readRepositorySnapshot({ vaultRoot: f.config.vaultRoot, artifactId: result.artifactId!, encryptionKey: f.key });
    expect(artifact.reviewPatches).toBe("omitted-partial"); expect(artifact.unstagedPatchBase64).toBeUndefined();
  });

  it("excludes canonical private storage reached through an external symlink", async () => {
    const f = await fixture(); const privateRoot = join(f.repository, "private"); await mkdir(privateRoot); const storageAlias = join(f.root, "storage-alias"); await symlink(privateRoot, storageAlias);
    await writeFile(join(privateRoot, "sensitive.bin"), Buffer.from([0, 255, 3, 12]));
    const keyPath = join(f.repository, "private-key"); await writeFile(keyPath, Buffer.from(f.key).toString("base64"), { mode: 0o600 });
    const config = { ...f.config, stateRoot: storageAlias, vaultKeyPath: keyPath };
    const project = await resolveProject(f.repository);
    const result = await captureRepositorySnapshot(config, project, { sourceRevisionId: repositoryRevisionId(project)!, publicRevisionId: "revision:a", capturedAt: "2026-09-04T00:00:00.000Z" });
    expect(result.reconstruction).toBe("partial");
    const artifact = await readRepositorySnapshot({ vaultRoot: f.config.vaultRoot, artifactId: result.artifactId!, encryptionKey: f.key });
    expect(artifact.exclusions.filter((entry) => entry.reason === "private-storage-path")).toHaveLength(2);
    expect(artifact.entries.some((entry) => Buffer.from(entry.pathBase64, "base64").toString().startsWith("private"))).toBe(false);
    expect(artifact.reviewPatches).toBe("omitted-partial");
  });
});
