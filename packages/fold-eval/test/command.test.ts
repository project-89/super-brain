import { describe, expect, it, vi } from "vitest";

import { runCommandOracle, type CommandRunner } from "../src/index.js";

describe("runCommandOracle", () => {
  it("maps a successful command to the configured confidence", async () => {
    const runner = vi.fn<CommandRunner>().mockResolvedValue({ stdout: "ok", stderr: "" });
    const result = await runCommandOracle(
      { type: "command", run: "pnpm test", cwd: "/workspace", passConfidence: 0.9 },
      runner,
    );
    expect(result).toMatchObject({ confidence: 0.9 });
    expect(runner).toHaveBeenCalledWith({
      command: "pnpm test",
      cwd: "/workspace",
      timeoutMs: 120_000,
      maxBufferBytes: 10 * 1024 * 1024,
    });
  });

  it("maps rejection to fail confidence and retains a bounded diagnostic tail", async () => {
    const runner: CommandRunner = async () => {
      throw Object.assign(new Error("exit 1"), { stderr: "tests failed" });
    };
    const result = await runCommandOracle(
      { type: "command", run: "pnpm test", failConfidence: 0.1 },
      runner,
    );
    expect(result.confidence).toBe(0.1);
    expect(result.detail).toContain("tests failed");
  });

  it("uses scorePattern on success and failure", async () => {
    const success = await runCommandOracle(
      {
        type: "command",
        run: "tests",
        scorePattern: "(\\d+) passed, (\\d+) failed",
      },
      async () => ({ stdout: "3 passed, 1 failed" }),
    );
    expect(success.confidence).toBe(0.75);

    const failure = await runCommandOracle(
      {
        type: "command",
        run: "tests",
        scorePattern: "(\\d+) passed, (\\d+) failed",
      },
      async () => {
        throw Object.assign(new Error("exit 1"), { stdout: "2 passed, 2 failed" });
      },
    );
    expect(failure.confidence).toBe(0.5);
  });

  it("rejects invalid configuration before executing", async () => {
    const runner = vi.fn<CommandRunner>();
    await expect(
      runCommandOracle({ type: "command", run: "test", scorePattern: "[" }, runner),
    ).rejects.toThrow(/scorePattern is invalid/);
    await expect(
      runCommandOracle({ type: "command", run: "test", passConfidence: 2 }, runner),
    ).rejects.toThrow(/passConfidence/);
    expect(runner).not.toHaveBeenCalled();
  });
});
