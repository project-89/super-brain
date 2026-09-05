import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { NativeTranscriptNormalizer, ensureVaultKey, explicitToolResult, parseClaudeTranscript, parseCodexTranscript } from "../src/index.js";

it("preserves source-specific failure and unknown rather than guessing from output prose", () => {
  expect([undefined, {}, "done", { stdout: "tests passed" }].map(explicitToolResult)).toEqual(["unknown", "unknown", "unknown", "unknown"]);
  expect(explicitToolResult({ is_error: false })).toBe("success");
  expect(explicitToolResult({ success: true, exit_code: 1 })).toBe("failure");
  expect(explicitToolResult('{"exit_code":2}')).toBe("failure");
  expect(explicitToolResult("Process exited with code 0\nFinal output:\npassed")).toBe("success");
});

for (const source of ["codex", "claude-code"] as const) describe(`${source} shared native identity`, () => {
  it("allocates identical turns before boilerplate/text filtering and includes tool-only evidence", async () => {
    const records = source === "codex" ? [
      { type: "response_item", payload: { type: "message", role: "system", content: [{ type: "text", text: "You are Codex" }] } },
      { type: "response_item", payload: { type: "function_call_output", call_id: "implicit", output: '{"exit_code":2}' } },
      { type: "event_msg", payload: { type: "task_started", turn_id: "task-a" } },
      { type: "turn_context", payload: { turn_id: "task-a" } },
      { type: "response_item", payload: { type: "message", role: "user", id: "user-a", content: [{ type: "input_text", text: "Do this" }] } },
      { type: "response_item", payload: { type: "function_call_output", call_id: "unknown", output: "done" } },
    ] : [
      { type: "user", uuid: "meta", isMeta: true, message: { content: [{ type: "tool_result", tool_use_id: "implicit", is_error: true, content: "failed" }] } },
      { type: "user", uuid: "boilerplate", promptId: "task-a", message: { content: "You are Claude" } },
      { type: "user", uuid: "user-a", promptId: "task-a", message: { content: "Do this" } },
      { type: "user", uuid: "unknown", message: { content: [{ type: "tool_result", tool_use_id: "unknown", content: "done" }] } },
    ];
    const directory = await mkdtemp(join(tmpdir(), "native-identity-"));
    const path = join(directory, "run.jsonl");
    await writeFile(path, records.map((r) => JSON.stringify(r)).join("\n"));
    const parsed = await (source === "codex" ? parseCodexTranscript(path) : parseClaudeTranscript(path));
    const decoder = new NativeTranscriptNormalizer(source, "run");
    const normalized = records.map((record) => decoder.push(record));
    const identities = [...new Set(normalized.flatMap((record) => record.turn === undefined ? [] : [record.turn.id]))];
    expect(parsed.bundle.chunks.flatMap((chunk) => chunk.turns.map((turn) => turn.id))).toEqual(identities);
    expect(identities).toEqual([`${source}:run:turn:0`, `${source}:run:turn:1`]);
    expect(parsed.bundle.chunks.flatMap((chunk) => chunk.actions.map((action) => action.status))).toEqual(["failed", "unknown"]);
    expect(normalized.flatMap((record) => record.actions.map((action) => action.text))).toHaveLength(2);
    expect(JSON.stringify(parsed.bundle)).not.toContain("Do this");
  });
});

it("publishes a complete shared encryption key under concurrent first relay startup", async () => {
  const root = await mkdtemp(join(tmpdir(), "receipt-key-"));
  const keys = await Promise.all(Array.from({ length: 20 }, () => ensureVaultKey(join(root, "vault.key"))));
  expect(new Set(keys.map(({ key }) => Buffer.from(key).toString("hex"))).size).toBe(1);
});

it("retains immutable v1 metadata on re-import and reports that no v2 interpretation was committed", async () => {
  const { deliverTranscriptBundle } = await import("../src/index.js");
  const root = await mkdtemp(join(tmpdir(), "native-migration-"));
  const path = join(root, "legacy.jsonl");
  await writeFile(path, JSON.stringify({ type: "response_item", payload: { type: "function_call_output", output: "done", call_id: "call" } }));
  const { bundle } = await parseCodexTranscript(path);
  const older = { ...bundle.artifact, parser: { ...bundle.artifact.parser, version: "1" } };
  const requests: string[] = [];
  const options = { apiUrl: "http://127.0.0.1:1", workspaceId: "workspace-a", bearerToken: "test", maxAttempts: 1,
    fetcher: async (url: string | URL | Request) => {
      requests.push(String(url));
      return requests.length === 1 ? new Response(JSON.stringify({ error: { code: "conflict", message: "artifact changed after import" } }), { status: 409 })
        : new Response(JSON.stringify({ run: bundle.run, artifact: older, chunks: [] }), { status: 200 });
    } };
  expect(await deliverTranscriptBundle(bundle, options)).toMatchObject({ imported: false, eventCount: 0, interpretation: "retained-existing", run: bundle.run });
  expect(requests[1]).toContain(encodeURIComponent(bundle.run.id));
  requests.length = 0;
  const changed = { ...bundle, artifact: { ...bundle.artifact, sha256: "a".repeat(64) } };
  await expect(deliverTranscriptBundle(changed, options)).rejects.toMatchObject({ status: 409 });
});

it("keeps v1 Claude implicit-turn identity when string-only assistant metadata was historically excluded", () => {
  const records = [
    { type: "assistant", message: { content: "legacy uncounted" } },
    { type: "user", uuid: "user", message: { content: "Actual prompt" } },
  ];
  const legacy = new NativeTranscriptNormalizer("claude-code", "run", { parserVersion: "1" });
  expect(records.map((record) => legacy.push(record).turn?.id)).toEqual([undefined, "claude-code:run:turn:0"]);
  const current = new NativeTranscriptNormalizer("claude-code", "run", { parserVersion: "2" });
  expect(records.map((record) => current.push(record).turn?.id)).toEqual(["claude-code:run:turn:0", "claude-code:run:turn:1"]);
});

it("retains a checksum-only metadata addition without swallowing same-parser chunk changes", async () => {
  const { deliverTranscriptBundle } = await import("../src/index.js");
  const root = await mkdtemp(join(tmpdir(), "native-checksum-migration-"));
  const path = join(root, "legacy.jsonl");
  await writeFile(path, JSON.stringify({ type: "response_item", payload: { type: "function_call_output", output: "done", call_id: "call" } }));
  const { bundle } = await parseCodexTranscript(path);
  const updated = { ...bundle, artifact: { ...bundle.artifact, storedSha256: "a".repeat(64) } };
  const options = { apiUrl: "http://127.0.0.1:1", workspaceId: "workspace-a", bearerToken: "test", maxAttempts: 1,
    fetcher: async (_url: string | URL | Request, init?: RequestInit) => init?.method === "POST"
      ? new Response(JSON.stringify({ error: { code: "conflict", message: "immutable artifact" } }), { status: 409 })
      : new Response(JSON.stringify({ run: bundle.run, artifact: bundle.artifact, chunks: bundle.chunks, projects: bundle.projects }), { status: 200 }) };
  expect(await deliverTranscriptBundle(updated, options)).toMatchObject({ interpretation: "retained-existing", imported: false });
  const changed = { ...updated, chunks: updated.chunks.map((chunk) => ({ ...chunk, actions: chunk.actions.map((action) => ({ ...action, status: "completed" as const })) })) };
  await expect(deliverTranscriptBundle(changed, options)).rejects.toMatchObject({ status: 409 });
});
