import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  parseClaudeTranscript,
  parseCodexTranscript,
  projectForRoot,
  deliverTranscriptBundle,
  scanTranscripts,
  storeRedactedArtifact,
} from "../src/index.js";

async function fixture(name: string, records: readonly unknown[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "fold-importer-"));
  const path = join(directory, name);
  await writeFile(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  return path;
}

describe("transcript source adapters", () => {
  it("uses a sanitized repository remote as the stable project identity", () => {
    const first = projectForRoot(
      "/work/checkout-a",
      "https://credential@github.com/example/project.git?token=private",
    );
    const second = projectForRoot(
      "/other/checkout-b",
      "https://github.com/example/project.git",
    );
    expect(first.id).toBe(second.id);
    expect(first.remote).toBe("https://github.com/example/project.git");
    expect(JSON.stringify(first)).not.toMatch(/credential|token=private/);
  });

  it("maps Claude message lineage and observable tool activity without private thinking", async () => {
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const path = await fixture(`${sessionId}.jsonl`, [
      {
        type: "user", sessionId, uuid: "message-user", promptId: "prompt-a",
        cwd: "/work/project-a", gitBranch: "main", timestamp: "2026-08-20T12:00:00.000Z",
        version: "2.1.0", message: { role: "user", content: "Run the tests" },
      },
      {
        type: "assistant", sessionId, uuid: "assistant-thinking", cwd: "/work/project-a",
        gitBranch: "main", timestamp: "2026-08-20T12:00:01.000Z",
        message: { id: "message-assistant", role: "assistant", model: "claude-test", content: [{ type: "thinking", thinking: "private" }] },
      },
      {
        type: "assistant", sessionId, uuid: "assistant-tool", cwd: "/work/project-a",
        gitBranch: "main", timestamp: "2026-08-20T12:00:02.000Z",
        message: { id: "message-assistant", role: "assistant", model: "claude-test", content: [{ type: "tool_use", id: "tool-a", name: "Bash", input: {} }] },
      },
      {
        type: "user", sessionId, uuid: "tool-result", cwd: "/work/project-a",
        gitBranch: "main", timestamp: "2026-08-20T12:00:03.000Z",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-a", content: "passed" }] },
      },
    ]);

    const parsed = await parseClaudeTranscript(path);
    expect(parsed.bundle.run).toMatchObject({
      id: `claude-code:${sessionId}`,
      projectResolution: "resolved",
      model: "claude-test",
      counts: { records: 4, turns: 1, messages: 3, actions: 2, unknown: 0 },
    });
    expect(parsed.bundle.projects[0]).toMatchObject({ name: "project-a", roots: ["/work/project-a"] });
    expect(parsed.bundle.chunks[0]?.actions.map(({ kind, name }) => ({ kind, name }))).toEqual([
      { kind: "tool-call", name: "Bash" },
      { kind: "tool-result", name: "tool-a" },
    ]);
    expect(JSON.stringify(parsed.bundle)).not.toContain("private");
    expect(JSON.stringify(parsed.bundle)).not.toContain("Run the tests");
  });

  it("maps Codex session, turn, and tool records into the same contract", async () => {
    const sessionId = "22222222-2222-4222-8222-222222222222";
    const path = await fixture(`rollout-2026-08-20T12-00-00-${sessionId}.jsonl`, [
      { type: "session_meta", timestamp: "2026-08-20T12:00:00.000Z", payload: { id: sessionId, cwd: "/work/project-b", cli_version: "1.2.3", git: { branch: "main", repository_url: "https://secret@github.com/example/project-b.git?token=hidden" } } },
      { type: "turn_context", timestamp: "2026-08-20T12:00:01.000Z", payload: { turn_id: "turn-a", cwd: "/work/project-b", model: "gpt-test" } },
      { type: "response_item", timestamp: "2026-08-20T12:00:02.000Z", payload: { type: "message", id: "message-a", role: "user", content: [{ type: "input_text", text: "Build" }] } },
      { type: "response_item", timestamp: "2026-08-20T12:00:03.000Z", payload: { type: "function_call", call_id: "call-a", name: "exec_command", arguments: "secret" } },
      { type: "response_item", timestamp: "2026-08-20T12:00:04.000Z", payload: { type: "function_call_output", call_id: "call-a", output: "done" } },
      { type: "response_item", timestamp: "2026-08-20T12:00:05.000Z", payload: { type: "reasoning", encrypted_content: "excluded", summary: ["excluded"] } },
    ]);

    const parsed = await parseCodexTranscript(path);
    expect(parsed.bundle.run).toMatchObject({
      id: `codex:${sessionId}`,
      model: "gpt-test",
      clientVersion: "1.2.3",
      counts: { records: 6, turns: 1, messages: 1, actions: 2, unknown: 0 },
    });
    expect(parsed.bundle.chunks[0]?.actions[0]).toMatchObject({ kind: "command", name: "exec_command" });
    expect(parsed.bundle.projects[0]).toMatchObject({
      name: "project-b",
      remote: "https://github.com/example/project-b.git",
      roots: [],
    });
    expect(JSON.stringify(parsed.bundle)).not.toContain("secret");
    expect(JSON.stringify(parsed.bundle)).not.toContain("token=hidden");
    expect(JSON.stringify(parsed.bundle)).not.toContain("excluded");
  });

  it("stores only explicitly requested redacted artifacts with restrictive permissions", async () => {
    const path = await fixture("33333333-3333-4333-8333-333333333333.jsonl", [
      { type: "user", sessionId: "33333333-3333-4333-8333-333333333333", uuid: "message-a", cwd: "/work/private", timestamp: "2026-08-20T12:00:00.000Z", message: { role: "user", content: "token=abcdefghijklmnop and sk-abcdefghijklmnop" } },
      { type: "assistant", sessionId: "33333333-3333-4333-8333-333333333333", cwd: "/work/private", timestamp: "2026-08-20T12:00:01.000Z", message: { id: "message-b", role: "assistant", content: [{ type: "thinking", thinking: "never store this" }, { type: "text", text: "safe" }] } },
      { type: "event_msg", payload: { type: "agent_reasoning", text: "also never store this" } },
    ]);
    const parsed = await parseClaudeTranscript(path);
    const vault = await mkdtemp(join(tmpdir(), "fold-vault-"));
    const stored = await storeRedactedArtifact(parsed, vault);
    const target = join(vault, "claude-code", stored.bundle.artifact.sha256.slice(0, 2), `${stored.bundle.artifact.sha256}.jsonl`);
    const content = await readFile(target, "utf8");
    expect(stored.bundle.artifact).toMatchObject({ contentPolicy: "redacted", stored: true, redactionCount: 2 });
    expect(content).toContain("[REDACTED]");
    expect(content).not.toContain("abcdefghijklmnop");
    expect(content).not.toContain("never store this");
    expect(content).not.toContain("also never store this");
    expect(content).toContain('"excluded":true');
    expect((await stat(target)).mode & 0o777).toBe(0o600);
  });

  it("produces a metadata-only dry-run report and deduplicates source-qualified runs", async () => {
    const root = await mkdtemp(join(tmpdir(), "fold-scan-"));
    const sessionId = "44444444-4444-4444-8444-444444444444";
    const record = { type: "user", sessionId, uuid: "message-a", cwd: "/work/a", timestamp: "2026-08-20T12:00:00.000Z", message: { role: "user", content: "hello" } };
    await writeFile(join(root, `${sessionId}.jsonl`), `${JSON.stringify(record)}\n`, "utf8");
    await writeFile(join(root, `copy-${sessionId}.jsonl`), `${JSON.stringify(record)}\n`, "utf8");
    const report = await scanTranscripts({ roots: { claude: root } });
    expect(report).toMatchObject({ discoveredFiles: 2, parsedFiles: 1, projects: 1, runs: 1, turns: 1, actions: 0, failures: [] });
    expect(report.transcripts[0]?.bundle.artifact.contentPolicy).toBe("metadata-only");
    expect(report.transcripts[0]?.bundle.artifact.stored).toBe(false);
  });

  it("delivers canonical metadata to an encoded workspace without exposing credentials", async () => {
    const sessionId = "55555555-5555-4555-8555-555555555555";
    const path = await fixture(`${sessionId}.jsonl`, [{
      type: "user",
      sessionId,
      uuid: "message-a",
      cwd: "/work/delivery",
      timestamp: "2026-08-20T12:00:00.000Z",
      message: { role: "user", content: "hello" },
    }]);
    const parsed = await parseClaudeTranscript(path);
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      imported: true,
      eventCount: 4,
      run: parsed.bundle.run,
    }), { status: 201, headers: { "content-type": "application/json" } }));

    await expect(deliverTranscriptBundle(parsed.bundle, {
      apiUrl: "http://127.0.0.1:3000",
      workspaceId: "workspace/one",
      bearerToken: "private-token",
      maxAttempts: 1,
      fetcher: fetcher as unknown as typeof fetch,
    })).resolves.toMatchObject({ imported: true, eventCount: 4 });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:3000/v1/workspaces/workspace%2Fone/transcript-imports");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer private-token");

    const deniedFetcher = vi.fn(async () => new Response(JSON.stringify({
      error: { code: "unauthorized", message: "A valid bearer token is required" },
    }), { status: 401, headers: { "content-type": "application/json" } }));
    await expect(deliverTranscriptBundle(parsed.bundle, {
      apiUrl: "http://127.0.0.1:3000",
      workspaceId: "workspace/one",
      bearerToken: "private-token",
      maxAttempts: 1,
      fetcher: deniedFetcher as unknown as typeof fetch,
    })).rejects.not.toThrow(/private-token/);
  });
});
