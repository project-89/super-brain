import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { runBoundedProcess, runtimeEnvironment } from "../src/process.js";

describe("bounded trusted process runner", () => {
  it("does not start a canceled provider, excludes unrelated environment secrets, and preserves normal output", async () => {
    const root = await mkdtemp(join(tmpdir(), "eval-process-"));
    try {
      const marker = join(root, "marker"); const signal = AbortSignal.abort();
      expect((await runBoundedProcess(process.execPath, ["-e", `require('fs').writeFileSync(${JSON.stringify(marker)},'bad')`], { cwd: root, env: {}, timeoutMs: 1000, signal })).failure).toBe("aborted");
      await expect(readFile(marker)).rejects.toThrow();
      expect(runtimeEnvironment({ HOME: "/synthetic", PATH: "/bin", OPENAI_API_KEY: "not-inherited", CAPTURE_TOKEN: "not-inherited", CLAUDE_CONFIG_DIR: "/private" })).toEqual({ HOME: "/synthetic", PATH: "/bin", LANG: "en_US.UTF-8", NO_COLOR: "1" });
      expect(await runBoundedProcess(process.execPath, ["-e", "process.stdout.write('ok')"], { cwd: root, env: {}, timeoutMs: 1000 })).toMatchObject({ exitCode: 0, stdout: "ok" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("kills bounded output, timed out work, and descendants that abandon inherited stdio", async () => {
    const root = await mkdtemp(join(tmpdir(), "eval-process-"));
    try {
      const output = await runBoundedProcess(process.execPath, ["-e", "setInterval(()=>process.stdout.write('x'.repeat(1024)),1)"], { cwd: root, env: {}, timeoutMs: 1000, maxOutputBytes: 100 });
      expect(output.failure).toBe("output-limit"); expect(output.stdout.length).toBeLessThanOrEqual(100);
      expect((await runBoundedProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], { cwd: root, env: {}, timeoutMs: 50 })).failure).toBe("timeout");
      const marker = join(root, "descendant-marker");
      const grandchild = `setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'orphan'),250)`;
      await runBoundedProcess(process.execPath, ["-e", `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'}).unref()`], { cwd: root, env: {}, timeoutMs: 1000 });
      await new Promise((resolve) => setTimeout(resolve, 350));
      await expect(readFile(marker)).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
