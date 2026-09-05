import * as fs from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { NativeTranscriptNormalizer, TranscriptBuilder, RecordAnonymizer, parseClaudeTranscript, parseCodexTranscript, storeRedactedArtifact } from "@_89/super-brain-importer";
import type { TranscriptSource } from "@_89/fold-transcript";
import { readVaultEvidence, vaultPath } from "../src/vault.js";

vi.mock("node:fs", { spy: true });
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture(source: TranscriptSource, records: readonly object[], options: { encryptionKey?: Uint8Array; anonymizer?: RecordAnonymizer; parserVersion?: "1" | "2" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "worker-vault-")); roots.push(root);
  const sourcePath = join(root, "native-run.jsonl");
  await writeFile(sourcePath, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  let parsed = await (source === "codex" ? parseCodexTranscript(sourcePath) : parseClaudeTranscript(sourcePath));
  if (options.parserVersion === "1") {
    const builder = new TranscriptBuilder(source, "native-run");
    const normalizer = new NativeTranscriptNormalizer(source, "native-run", { parserVersion: "1" });
    for (const record of records) builder.consume(normalizer.push(record as Record<string, unknown>));
    parsed = { ...parsed, bundle: builder.finish({ ...parsed.bundle.artifact, parser: { ...parsed.bundle.artifact.parser, version: "1" } }) };
  }
  const vaultRoot = join(root, "vault");
  const { bundle } = await storeRedactedArtifact(parsed, vaultRoot, options);
  const canonicalTurns = bundle.chunks.flatMap((chunk) => chunk.turns);
  const read = () => readVaultEvidence(vaultRoot, bundle.run, { artifact: bundle.artifact, canonicalTurns,
    ...(options.encryptionKey === undefined ? {} : { encryptionKey: options.encryptionKey }) });
  return { root, vaultRoot, bundle, canonicalTurns, read, path: vaultPath(vaultRoot, bundle.run, options.encryptionKey !== undefined, bundle.artifact)! };
}

for (const source of ["codex", "claude-code"] as const) it(`matches ${source} canonical identities before boilerplate filtering and retains honest tool results`, async () => {
  const records = source === "codex" ? [
    { type: "response_item", payload: { type: "message", role: "system", content: [{ type: "text", text: "You are Codex" }] } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "tool-only", output: '{"exit_code":1}' } },
    { type: "event_msg", payload: { type: "task_started", turn_id: "native-turn" } },
    { type: "turn_context", payload: { turn_id: "native-turn" } },
    { type: "response_item", payload: { type: "message", role: "user", id: "native-message", content: [{ type: "input_text", text: "We decided to keep evidence." }] } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "unknown-result", output: "passed" } },
  ] : [
    { type: "user", isMeta: true, message: { content: [{ type: "tool_result", tool_use_id: "tool-only", is_error: true, content: "failed" }] } },
    { type: "user", promptId: "native-turn", uuid: "boilerplate", message: { content: "You are Claude" } },
    { type: "user", promptId: "native-turn", uuid: "native-message", message: { content: "We decided to keep evidence." } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "unknown-result", content: "passed" }] } },
  ];
  const item = await fixture(source, records);
  const result = await item.read();
  expect(result).toMatchObject({ status: "ready", coverage: { integrity: "verified", turnIds: item.canonicalTurns.map(({ id }) => id), toolResults: 2 } });
  if (result.status !== "ready") throw new Error(result.status);
  expect(result.messages.map(({ turnId }) => turnId)).toEqual([item.canonicalTurns[0]!.id, item.canonicalTurns[1]!.id, item.canonicalTurns[1]!.id]);
  expect(result.messages.filter(({ role }) => role === "tool").map(({ result }) => result)).toEqual(["failure", "unknown"]);
  expect(result.messages.find(({ role }) => role === "user")).toMatchObject({ nativeId: "native-message" });
});

for (const parserVersion of ["1", "2"] as const) it(`honors immutable Claude parser ${parserVersion} interpretation`, async () => {
  const item = await fixture("claude-code", [
    { type: "assistant", message: { content: "Legacy string-only text" } },
    { type: "user", uuid: "user", message: { content: "Keep this actual prompt." } },
  ], { parserVersion });
  const result = await item.read();
  expect(result).toMatchObject({ status: "ready", coverage: { turnIds: item.canonicalTurns.map(({ id }) => id) } });
  if (result.status !== "ready") throw new Error(result.status);
  expect(result.messages.at(-1)?.turnId).toBe(`claude-code:native-run:turn:${parserVersion === "1" ? 0 : 1}`);
  expect(result.messages).toHaveLength(parserVersion === "1" ? 1 : 2);
});

it("resolves pseudonymous vault paths by artifact digest and citations by actual canonical turn ordinals", async () => {
  const anonymizer = new RecordAnonymizer("pseudonymous", new Uint8Array(32).fill(5));
  const item = await fixture("codex", [
    { type: "event_msg", payload: { type: "task_started", turn_id: "native-turn" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "We decided to retain this." }] } },
  ], { anonymizer });
  expect(item.bundle.run.artifactId).not.toMatch(/^artifact-[a-f0-9]{64}$/);
  expect(await item.read()).toMatchObject({ status: "ready", messages: [{ turnId: item.canonicalTurns[0]!.id }], coverage: { integrity: "verified" } });
  expect(await readVaultEvidence(item.vaultRoot, item.bundle.run, { artifact: item.bundle.artifact })).toEqual({ status: "waiting", reason: "metadata-unavailable" });
});

it("keeps changed fragments sharing a native message id and deduplicates only exact repetitions", async () => {
  const message = (text: string) => ({ type: "assistant", message: { id: "streamed", content: [{ type: "text", text }] } });
  const item = await fixture("claude-code", [message("First fragment"), message("First fragment"), message("Additional fragment")]);
  const result = await item.read();
  expect(result).toMatchObject({ status: "ready", messages: [{ text: "First fragment" }, { text: "Additional fragment" }], coverage: { excludedMessages: 1 } });
});

it("reports waiting, decryption failure, unsupported interpretation, and malformed lines separately", async () => {
  const key = new Uint8Array(32).fill(9);
  const item = await fixture("codex", [{ type: "event_msg", payload: { type: "task_started", turn_id: "turn" } }], { encryptionKey: key });
  expect(await readVaultEvidence(item.vaultRoot, item.bundle.run, {})).toEqual({ status: "waiting", reason: "metadata-unavailable" });
  expect(await readVaultEvidence(item.vaultRoot, item.bundle.run, { artifact: item.bundle.artifact })).toEqual({ status: "waiting", reason: "key-unavailable" });
  expect(await readVaultEvidence(item.vaultRoot, item.bundle.run, { artifact: item.bundle.artifact, encryptionKey: new Uint8Array(32) })).toMatchObject({ status: "retry", reason: "decryption-failed", line: 1 });
  expect(await readVaultEvidence(item.vaultRoot, item.bundle.run, { artifact: { ...item.bundle.artifact, parser: { id: "codex-jsonl", version: "future" } } })).toEqual({ status: "excluded", reason: "unsupported-parser" });
  await rm(item.path);
  expect(await item.read()).toEqual({ status: "waiting", reason: "artifact-unavailable" });
  const plain = await fixture("codex", [{ type: "event_msg", payload: { type: "task_started", turn_id: "turn" } }]);
  await writeFile(plain.path, '{"type":"session_meta"}\nnot-json\n');
  expect(await plain.read()).toEqual({ status: "excluded", reason: "malformed-record", line: 2 });
});

it("rejects substituted valid JSONL and reordered authenticated encrypted records", async () => {
  const records = [
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "We decided first." }] } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "We decided second." }] } },
  ];
  const plain = await fixture("codex", records);
  await writeFile(plain.path, (await readFile(plain.path, "utf8")).replace("first", "false"));
  expect(await plain.read()).toEqual({ status: "excluded", reason: "artifact-integrity-mismatch" });
  const encrypted = await fixture("codex", records, { encryptionKey: new Uint8Array(32).fill(8) });
  const lines = (await readFile(encrypted.path, "utf8")).trim().split("\n");
  await writeFile(encrypted.path, lines.reverse().join("\n") + "\n");
  expect(await encrypted.read()).toEqual({ status: "excluded", reason: "artifact-integrity-mismatch" });
});

it("labels historical missing checksums as unverified and excludes mismatched canonical identities", async () => {
  const item = await fixture("codex", [{ type: "event_msg", payload: { type: "task_started", turn_id: "turn" } }]);
  const { storedSha256: _, ...legacyArtifact } = item.bundle.artifact;
  expect(await readVaultEvidence(item.vaultRoot, item.bundle.run, { artifact: legacyArtifact, canonicalTurns: item.canonicalTurns })).toMatchObject({ status: "ready", coverage: { integrity: "legacy-unverified" } });
  expect(await readVaultEvidence(item.vaultRoot, item.bundle.run, { artifact: item.bundle.artifact, canonicalTurns: [] })).toEqual({ status: "excluded", reason: "turn-identity-mismatch" });
});


it("bounds bytes read when an artifact grows after its size check", async () => {
  const item = await fixture("codex", [{ type: "event_msg", payload: { type: "task_started", turn_id: "turn" } }]);
  const original = await vi.importActual<typeof import("node:fs")>("node:fs");
  const size = original.statSync(item.path).size;
  let streamed = 0;
  vi.mocked(fs.createReadStream).mockImplementationOnce((path, options) => {
    original.appendFileSync(path, "\n" + JSON.stringify({ type: "session_meta", payload: { extra: "x".repeat(1024 * 1024) } }) + "\n");
    const stream = original.createReadStream(path, options);
    stream.on("data", (chunk) => { streamed += Buffer.byteLength(chunk); });
    return stream;
  });
  expect(await readVaultEvidence(item.vaultRoot, item.bundle.run, { artifact: item.bundle.artifact, canonicalTurns: item.canonicalTurns, maxBytes: size }))
    .toEqual({ status: "retry", reason: "artifact-changing" });
  expect(streamed).toBeLessThanOrEqual(size);
});


it("does not accept plaintext substituted for a legacy encrypted envelope", async () => {
  const record = { type: "event_msg", payload: { type: "task_started", turn_id: "turn" } };
  const key = new Uint8Array(32).fill(4);
  const item = await fixture("codex", [record], { encryptionKey: key });
  const { storedSha256: _, ...legacyArtifact } = item.bundle.artifact;
  await writeFile(item.path, JSON.stringify(record) + "\n");
  expect(await readVaultEvidence(item.vaultRoot, item.bundle.run, { artifact: legacyArtifact, encryptionKey: key }))
    .toEqual({ status: "excluded", reason: "malformed-record", line: 1 });
});
