import { mkdtemp, mkdir, writeFile, symlink, lstat, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { readEvaluationDirectory } from "../src/export.js";
import { readEvaluationText } from "../src/io.js";

it("bounds selected files and rejects symlinks and replaced inodes before reading", async () => {
  const root = await mkdtemp(join(tmpdir(), "eval-io-test-"));
  try {
    await writeFile(join(root, "safe.json"), "{}");
    expect(await readEvaluationDirectory(root)).toEqual({ "safe.json": "{}" });
    const expected = await lstat(join(root, "safe.json"));
    await writeFile(join(root, "replacement"), "changed"); await rename(join(root, "replacement"), join(root, "safe.json"));
    await expect(readEvaluationText(join(root, "safe.json"), 100, { expected, validate: async () => {} })).rejects.toThrow(/replaced/);
    await expect(readEvaluationText(join(root, "safe.json"), 2)).rejects.toThrow(/bounds/);
    await symlink(join(root, "safe.json"), join(root, "link.json"));
    await expect(readEvaluationDirectory(root)).rejects.toThrow(/unsupported/);
    await rm(join(root, "link.json")); await mkdir(join(root, "directory"));
    await symlink(join(root, "directory"), join(root, "directory-link"));
    await expect(readEvaluationDirectory(root)).rejects.toThrow(/unsupported/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
it("checks the opened file's directory boundary before allocating or publishing bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "eval-io-boundary-"));
  try {
    const file = join(root, "file.json"); await writeFile(file, "{}"); const expected = await lstat(file);
    await expect(readEvaluationText(file, 100, { expected, validate: async () => { throw new Error("ancestor replaced"); } })).rejects.toThrow(/ancestor replaced/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
