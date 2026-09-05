import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TranscriptImportBundle } from "@_89/fold-transcript";
import { afterEach, describe, expect, it } from "vitest";
import { NativeTranscriptNormalizer, TranscriptBuilder, encryptVaultLine, reinterpretStoredTranscript } from "../src/index.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture(policy: "none" | "pseudonymous" | "strict" = "none", encrypted = false) {
  const root = await mkdtemp(join(tmpdir(), "reinterpret-test-")); roots.push(root);
  const records = [
    { type: "assistant", timestamp: "2026-09-04T00:00:00Z", message: { id: "private-assistant-id", content: "We decided that the original immutable evidence must always survive." } },
    { type: "user", uuid: "private-native-turn-id", cwd: "/Users/private-person/private-project", message: { content: "We decided that every failed check must preserve its failure result." } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "private-tool-id", is_error: true, content: "A failed verification" }] } },
  ];
  const decoder = new NativeTranscriptNormalizer("claude-code", "private-native-run", { parserVersion: "1" });
  const builder = new TranscriptBuilder("claude-code", "private-native-run");
  for (const record of records) builder.consume(decoder.push(record));
  const plain = records.map((record) => JSON.stringify(record)).join("\n") + "\n";
  const key = new Uint8Array(32).fill(7);
  const bytes = encrypted ? records.map((record) => encryptVaultLine(JSON.stringify(record), key)).join("\n") + "\n" : plain;
  const sha = createHash("sha256").update(plain).digest("hex");
  const path = join(root, "claude-code", sha.slice(0, 2), `${sha}.jsonl${encrypted ? ".enc" : ""}`);
  await mkdir(join(root, "claude-code", sha.slice(0, 2)), { recursive: true }); await writeFile(path, bytes);
  const original = builder.finish({ id: "artifact-original", source: "claude-code", sha256: sha, sourcePathHash: "a".repeat(64),
    storedSha256: createHash("sha256").update(bytes).digest("hex"), byteLength: Buffer.byteLength(plain), mediaType: "application/x-ndjson",
    parser: { id: "claude-jsonl", version: "1" }, contentPolicy: "redacted", anonymizationPolicy: policy, stored: true, redactionCount: 0 });
  const previous: TranscriptImportBundle = policy === "none" ? original : {
    ...original, projects: [],
    run: { id: "opaque-canonical-run", nativeId: "opaque-native-run", source: "claude-code", artifactId: original.artifact.id, projectResolution: "unassigned", counts: original.run.counts, segments: [] },
    chunks: original.chunks.map((chunk) => ({ ...chunk, runId: "opaque-canonical-run",
      turns: chunk.turns.map((turn) => ({ ...turn, id: `opaque-turn-${turn.ordinal}`, nativeId: `opaque-native-turn-${turn.ordinal}` })),
      actions: chunk.actions.map(({ name: _name, ...action }) => ({ ...action, id: `opaque-action-${action.ordinal}`, turnId: "opaque-turn-0" })),
    })),
  };
  return { previous, root, path, bytes, key };
}

describe("explicit immutable transcript reinterpretation", () => {
  it("preserves the original bytes and IDs while reporting recomputed coverage and exact shifted turn origins", async () => {
    const item = await fixture(); const snapshot = JSON.stringify(item.previous);
    const result = await reinterpretStoredTranscript(item.previous, { vaultRoot: item.root, parserVersion: "2" });
    expect(JSON.stringify(item.previous)).toBe(snapshot); expect(await readFile(item.path, "utf8")).toBe(item.bytes);
    expect(result.bundle.run.id).not.toBe(item.previous.run.id);
    expect(result.bundle.artifact.sha256).toBe(item.previous.artifact.sha256);
    expect(result.bundle.run.interpretation).toMatchObject({ previousRunId: item.previous.run.id, sourceOccurrenceId: item.previous.artifact.id, sourceArtifactId: item.previous.artifact.id });
    expect(result.report).toMatchObject({ recomputed: true, storedRecords: 3, integrity: "verified", previousCounts: { turns: 1 }, recomputedCounts: { turns: 2 } });
    expect(result.bundle.chunks[0]!.actions[0]?.status).toBe("failed");
    expect(result.report.turnCorrespondence).toEqual([{ previousTurnId: item.previous.chunks[0]!.turns[0]!.id,
      turnIds: [`${result.bundle.run.id}:turn:1`], recordRanges: [{ start: 1, end: 2 }] }]);
    expect(result.bundle.chunks[0]!.turns[0]?.origin?.recordRanges).toEqual([{ start: 0, end: 0 }]);
    expect(await reinterpretStoredTranscript(item.previous, { vaultRoot: item.root, parserVersion: "2" })).toEqual(result);
    expect((await reinterpretStoredTranscript(result.bundle, { vaultRoot: item.root, parserVersion: "2" })).report.recomputed).toBe(false);
  });

  it.each(["pseudonymous", "strict"] as const)("retains %s metadata without publishing private native IDs or paths from the vault", async (policy) => {
    const item = await fixture(policy, true);
    const result = await reinterpretStoredTranscript(item.previous, { vaultRoot: item.root, parserVersion: "2", encryptionKey: item.key });
    const encoded = JSON.stringify(result.bundle);
    expect(encoded).not.toContain("private-"); expect(encoded).not.toContain("/Users/");
    expect(result.bundle.run.nativeId).toBe(item.previous.run.nativeId);
    expect(result.bundle.projects).toEqual(item.previous.projects); expect(result.bundle.run.segments).toEqual(item.previous.run.segments);
    expect(result.bundle.chunks.flatMap(({ turns }) => turns).every(({ nativeId }) => nativeId === undefined)).toBe(true);
  });

  it("fails closed for missing encrypted keys, corrupt bytes, and unavailable old turn correspondence", async () => {
    const item = await fixture("none", true);
    await expect(reinterpretStoredTranscript(item.previous, { vaultRoot: item.root, parserVersion: "2" })).rejects.toThrow("key-unavailable");
    await expect(reinterpretStoredTranscript({ ...item.previous, chunks: [] }, { vaultRoot: item.root, parserVersion: "2", encryptionKey: item.key })).rejects.toThrow("previous-turn-origin-unavailable");
    await writeFile(item.path, item.bytes.replace(/ciphertext":"./, 'ciphertext":"X'));
    await expect(reinterpretStoredTranscript(item.previous, { vaultRoot: item.root, parserVersion: "2", encryptionKey: item.key })).rejects.toThrow();
  });
});
