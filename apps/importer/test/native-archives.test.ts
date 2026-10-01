import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { parseNativeArchive, redactTranscriptRecord, scanTranscripts, storeRedactedArtifact, RecordAnonymizer, sha256Text } from "../src/index.js";
import { deriveRetainedRecord } from "../src/reprocess.js";

async function directory() { return mkdtemp(join(tmpdir(), "native-archives-")); }
const gemini = {
  sessionId: "native-session", projectHash: "opaque-project", startTime: "2026-09-11T10:00:00Z", messages: [
    { id: "u1", timestamp: "2026-09-11T10:00:01Z", type: "user", content: "Inspect project" },
    { id: "a1", timestamp: "2026-09-11T10:00:02Z", type: "gemini", model: "gemini-fast", content: [{ text: "Result" }],
      thoughts: [{ subject: "private thought", description: "do not retain" }], tokens: { input: 12, output: 4 },
      toolCalls: [{ id: "t1", name: "run_shell_command", args: {}, status: "success", result: [{ text: "ok" }] },
        { id: "t2", name: "read_file", status: "cancelled" }, { id: "t3", name: "read_file", result: "ambiguous" }] },
    { type: "future_native_message", content: "Preserve me" },
  ],
};

describe("native archive adapters", () => {
  it("preserves user messages and arbitrary tool data when excluding provider reasoning", () => {
    const applicationData = { reasoning: "business rationale", thoughts: ["plan"], thought: true,
      encrypted_content: "application ciphertext", thoughtSignature: "application signature",
      text: "Implement <think>example</think> and <REASONING_SCRATCHPAD>example</REASONING_SCRATCHPAD> tags" };
    for (const record of [
      { role: "user", content: applicationData.text },
      { role: "tool", content: applicationData },
      { type: "user", message: { content: [{ type: "tool_result", content: applicationData }] } },
      { type: "response_item", payload: { type: "function_call_output", output: applicationData } },
      { type: "assistant", message: { content: [{ type: "tool_use", input: applicationData }] } },
      { type: "gemini", toolCalls: [{ args: applicationData, result: [{ functionResponse: { response: applicationData } }] }] },
      { role: "assistant", tool_calls: [{ function: { arguments: applicationData } }] },
    ]) {
      expect(redactTranscriptRecord(record).value).toEqual(record);
    }
    const assistant = { role: "assistant", content: "<think>private</think>Answer", reasoning: "private" };
    expect(redactTranscriptRecord(assistant).value).toEqual({ role: "assistant", content: "Answer" });
    expect(redactTranscriptRecord(assistant, { reasoningPolicy: "include" }).value).toEqual(assistant);
  });

  it("separates readable reasoning and opaque provider signatures", () => {
    const value = { type: "gemini", thoughts: [{ subject: "readable" }], content: [{ text: "answer", thoughtSignature: "opaque" }],
      toolCalls: [{ result: [{ thoughtSignature: "opaque-tool" }] }], codex_reasoning_items: [{ encrypted_content: "opaque-codex" }] };
    const readable = JSON.stringify(redactTranscriptRecord(value, { reasoningPolicy: "include" }).value);
    expect(readable).toContain("readable");
    expect(readable).not.toContain("opaque");
    const retained = JSON.stringify(redactTranscriptRecord(value, { reasoningPolicy: "include", retainEncryptedReasoning: true }).value);
    expect(retained).toContain("opaque-tool");
    expect(retained).toContain("opaque-codex");
    const excluded = JSON.stringify(redactTranscriptRecord(value, { retainEncryptedReasoning: true }).value);
    expect(excluded).not.toMatch(/readable|opaque/);
    const claude = { type: "assistant", message: { content: [
      { type: "thinking", thinking: "readable", signature: "opaque" },
      { type: "redacted_thinking", data: "opaque-block" },
    ] } };
    expect(JSON.stringify(redactTranscriptRecord(claude, { reasoningPolicy: "include" }).value)).not.toContain("opaque");
    expect(JSON.stringify(redactTranscriptRecord(claude, { reasoningPolicy: "include", retainEncryptedReasoning: true }).value)).toContain("opaque-block");
    const hermes = { role: "assistant", reasoning_details: [{ type: "reasoning.encrypted", data: "opaque-detail" }] };
    expect(JSON.stringify(redactTranscriptRecord(hermes, { reasoningPolicy: "include" }).value)).not.toContain("opaque-detail");
  });
  it("uses native Gemini identity and preserves unknown and cancelled tool outcomes", async () => {
    const root = await directory(), path = join(root, "session-2026.json");
    await writeFile(path, JSON.stringify(gemini, null, 2));
    const parsed = await parseNativeArchive(path, "gemini");
    expect(parsed.bundle.run).toMatchObject({ id: "gemini:native-session", projectResolution: "estimated", model: "gemini-fast", counts: { records: 4, unknown: 1 } });
    expect(parsed.diagnostics?.toolResults).toEqual({ completed: 1, unknown: 2, failed: 0 });
    expect(parsed.bundle.projects[0]?.roots).toEqual([]);
    const vault = join(root, "vault");
    const stored = await storeRedactedArtifact(parsed, vault);
    const contents = await readFile(join(vault, "gemini", stored.bundle.artifact.sha256.slice(0, 2), `${stored.bundle.artifact.sha256}.jsonl`), "utf8");
    expect(contents).toContain("Preserve me");
    expect(contents).not.toContain("private thought");
    expect(contents.trim().split("\n")).toHaveLength(4);
    const included = await storeRedactedArtifact(parsed, join(root, "included"), { reasoningPolicy: "include" });
    expect(included.bundle.artifact.reasoningPolicy).toBe("included");
    expect(deriveRetainedRecord("gemini", gemini.messages[1]!).evidence.map((item) => item.kind)).toEqual(["usage", "tool-result", "tool-result", "tool-result"]);
  });

  it("only resolves a Gemini project marker when its native hash matches", async () => {
    const root = await directory(), chats = join(root, "chats"), path = join(chats, "session-native.json");
    await mkdir(chats);
    await writeFile(join(root, ".project_root"), "/work/my-project");
    await writeFile(path, JSON.stringify({ ...gemini, projectHash: sha256Text("/work/my-project") }));
    expect((await parseNativeArchive(path, "gemini")).bundle.run).toMatchObject({ cwd: "/work/my-project", projectResolution: "resolved" });
    await writeFile(join(root, ".project_root"), "/work/wrong-project");
    expect((await parseNativeArchive(path, "gemini")).bundle.run.projectResolution).toBe("estimated");
  });

  it("snapshots Hermes WAL data consistently and refuses changed sessions before archival", async () => {
    const root = await directory(), path = join(root, "state.db");
    const db = new DatabaseSync(path);
    try {
      db.exec("PRAGMA journal_mode=WAL; CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, started_at REAL, model TEXT, parent_session_id TEXT, input_tokens INTEGER); CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, tool_calls TEXT, tool_call_id TEXT, reasoning_content TEXT, timestamp REAL)");
      db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)").run("session-1", "/work/project", 1789120800, "hermes-model", "parent-1", 10);
      db.prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(1, "session-1", "user", "Inspect", null, null, null, 1789120801);
      db.prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(2, "session-1", "assistant", "<think>private trace</think>Done", JSON.stringify([{ id: "call-1", type: "function", function: { name: "terminal", arguments: "{}" } }]), null, "private reasoning", 1789120802);
      db.prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(3, "session-1", "tool", JSON.stringify({ exit_code: 1 }), null, "call-1", null, 1789120803);
      const parsed = await parseNativeArchive(path, "hermes", "session-1");
      expect(parsed.bundle.run).toMatchObject({ id: "hermes:session-1", cwd: "/work/project", counts: { messages: 3, turns: 1, actions: 2 } });
      expect(parsed.diagnostics?.toolResults.failed).toBe(1);
      const hash = parsed.bundle.artifact.sha256;
      db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)").run("unrelated", null, null, null, null, 0);
      expect((await parseNativeArchive(path, "hermes", "session-1")).bundle.artifact.sha256).toBe(hash);
      const vault = join(root, "vault");
      const stored = await storeRedactedArtifact(parsed, vault, { anonymizer: new RecordAnonymizer("strict", Buffer.alloc(32, 1)) });
      const target = join(vault, "hermes", stored.bundle.artifact.sha256.slice(0, 2), `${stored.bundle.artifact.sha256}.jsonl`);
      const contents = await readFile(target, "utf8");
      expect(contents).not.toMatch(/private trace|private reasoning|session-1|parent-1|\/work\/project/);
      expect(contents).toContain("Done");
      expect((await stat(target)).mode & 0o777).toBe(0o600);
      await storeRedactedArtifact(parsed, vault, { anonymizer: new RecordAnonymizer("strict", Buffer.alloc(32, 1)) });
      db.prepare("UPDATE messages SET content = ? WHERE id = 1").run("Changed");
      await expect(storeRedactedArtifact(parsed, vault)).rejects.toThrow("changed after it was scanned");
    } finally { db.close(); }
  });

  it("scans only named native session files and reports malformed documents", async () => {
    const root = await directory();
    await writeFile(join(root, "session-valid.json"), JSON.stringify(gemini));
    await writeFile(join(root, "session-invalid.json"), "{}");
    await writeFile(join(root, "credentials.json"), "{}");
    const report = await scanTranscripts({ roots: { gemini: root, hermes: join(root, "absent") } });
    expect(report.discoveredFiles).toBe(2);
    expect(report.runs).toBe(1);
    expect(report.failures).toHaveLength(1);
    expect(report.bySource.gemini.files).toBe(1);
  });

  it("does not invent timestamps, projects, or success for legacy Hermes logs", async () => {
    const root = await directory(), path = join(root, "session_legacy.json");
    await writeFile(path, JSON.stringify({ session_id: "legacy", session_start: "2026-09-11T10:00:00", messages: [
      { role: "system", content: "setup" }, { role: "user", content: "Question" }, { role: "tool", content: "done" }, { role: "future", content: "retain" },
    ] }));
    const parsed = await parseNativeArchive(path, "hermes");
    expect(parsed.bundle.run.projectResolution).toBe("unassigned");
    expect(parsed.bundle.run.startedAt).toBeUndefined();
    expect(parsed.bundle.run.counts).toMatchObject({ turns: 2, unknown: 1 });
    expect(parsed.diagnostics?.toolResults.unknown).toBe(1);
  });
});
