import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { FoldLogEntry } from "@_89/fold";
import { FoldSdk } from "../../../packages/fold-sdk/dist/index.js";
import { createApiServer, StaticIdentityDirectory } from "../../api/dist/index.js";
import { SuperBrainClient } from "@_89/super-brain-client";
import { NativeTranscriptNormalizer, TranscriptBuilder, deliverTranscriptBundle, reinterpretStoredTranscript } from "@_89/super-brain-importer";
import { expect, it } from "vitest";
import { TranscriptMemoryWorker } from "../src/worker.js";
import { deterministicCandidateId, RULE_EXTRACTOR } from "../src/extractor.js";

it("previews and publishes an explicit reinterpretation through CLI/API without changing the original or increasing corroboration", async () => {
  const root = await mkdtemp(join(tmpdir(), "reinterpret-http-"));
  const entries: FoldLogEntry[] = [];
  const sdk = new FoldSdk({ async read() { return { entries: [...entries] }; }, async append(entry) { entries.push(entry); } });
  const directory = new StaticIdentityDirectory({ test: { principalId: "worker", workspaces: { workspace: { role: "admin" } } } });
  const server = createApiServer({ authenticator: directory, memberships: directory, sdks: { sdkFor: async () => sdk } });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = new SuperBrainClient({ baseUrl: apiUrl, workspaceId: "workspace", token: "test" });
  const worker = new TranscriptMemoryWorker({ client, vaultRoot: root, stateRoot: join(root, "jobs") });
  try {
    const records = [
      { type: "assistant", message: { id: "message", content: "We decided that original event evidence must always remain immutable." } },
      { type: "user", uuid: "turn", cwd: "/synthetic/project", message: { content: "We decided that original event evidence must always remain immutable." } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "test", is_error: true, content: "Failed check" }] } },
      { type: "user", uuid: "correction", message: { content: "Correction: preserve original evidence and publish a separate versioned interpretation." } },
    ];
    const bytes = records.map((record) => JSON.stringify(record)).join("\n") + "\n";
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const path = join(root, "claude-code", sha256.slice(0, 2), `${sha256}.jsonl`);
    await mkdir(join(root, "claude-code", sha256.slice(0, 2)), { recursive: true }); await writeFile(path, bytes);
    const decoder = new NativeTranscriptNormalizer("claude-code", "native", { parserVersion: "1" });
    const builder = new TranscriptBuilder("claude-code", "native"); records.forEach((record) => builder.consume(decoder.push(record)));
    const original = builder.finish({ id: `artifact-${sha256}`, source: "claude-code", sha256, storedSha256: sha256, sourcePathHash: "a".repeat(64),
      byteLength: Buffer.byteLength(bytes), mediaType: "application/x-ndjson", parser: { id: "claude-jsonl", version: "1" }, contentPolicy: "redacted", stored: true, redactionCount: 0 });
    const delivery = { apiUrl, workspaceId: "workspace", bearerToken: "test" };
    await deliverTranscriptBundle(original, delivery);
    const count = entries.length;
    const cli = fileURLToPath(new URL("../../importer/dist/main.js", import.meta.url));
    const args = [cli, "reinterpret", "--api-url", apiUrl, "--workspace", "workspace", "--run", original.run.id, "--parser-version", "2", "--vault", root];
    const env = { ...process.env, FOLD_API_TOKEN: "test", FOLD_API_ORGANIZATION: "local" };
    const preview = JSON.parse((await promisify(execFile)(process.execPath, args, { env })).stdout);
    expect(preview).toMatchObject({ mode: "reinterpret-preview", recomputed: true, storedRecords: 4 });
    expect(entries).toHaveLength(count);
    const published = JSON.parse((await promisify(execFile)(process.execPath, [...args, "--confirm"], { env })).stdout);
    expect(published.imported).toBe(true);
    const result = await reinterpretStoredTranscript(original, { vaultRoot: root, parserVersion: "2" });
    expect((await deliverTranscriptBundle(result.bundle, delivery)).imported).toBe(false);
    expect((await client.transcriptRun(original.run.id))?.run).toEqual(original.run);
    expect(await readFile(path, "utf8")).toBe(bytes);
    const eventFor = (runId: string) => entries.find(({ event }) => event.kind === "transcript.run-imported" && event.changes.some((change) => change.verb === "create" && (change.after.run as any)?.id === runId))!.event.id;
    const projectId = original.run.projectId!;
    const originalRef = { eventId: eventFor(original.run.id), runId: original.run.id, turnId: original.chunks[0]!.turns[0]!.id, projectId };
    const nextRef = { eventId: eventFor(result.bundle.run.id), runId: result.bundle.run.id, turnId: result.bundle.chunks[0]!.turns[1]!.id, projectId };
    const origins = await client.transcriptEvidenceOrigins([originalRef, nextRef]);
    expect(origins).toHaveLength(2); expect(new Set(origins.map(({ independenceKey }) => independenceKey)).size).toBe(1);
    const candidate = (ref: typeof originalRef, index: number) => ({ id: deterministicCandidateId(100, `source-${index}`), audience: "workspace" as const,
      projectIds: [projectId], source: "transcript-rule", summary: "Keep original evidence immutable", content: { statement: "Keep original evidence immutable", runId: ref.runId, turnId: ref.turnId },
      evidence: [ref], confidence: 0.8, salience: 0.8, extractor: RULE_EXTRACTOR });
    expect(await worker.propose([candidate(originalRef, 1)])).toBe(1);
    expect(await worker.propose([candidate(nextRef, 2)])).toBe(0);
    expect((await client.memoryCandidates())[0]!.candidate.evidence).toHaveLength(2);
    expect((await client.transcriptEvidenceOrigins((await client.memoryCandidates())[0]!.candidate.evidence)).map(({ independenceKey }) => independenceKey)).toEqual([origins[0]!.independenceKey, origins[0]!.independenceKey]);
    const lastTurn = result.bundle.chunks.flatMap(({ turns }) => turns).at(-1)!;
    const correctionRef = { ...nextRef, turnId: lastTurn.id };
    const correction = { ...candidate(correctionRef, 3), summary: "Publish corrections as separate interpretations",
      content: { statement: "Publish corrections as separate interpretations", runId: correctionRef.runId, turnId: correctionRef.turnId } };
    expect(await worker.propose([correction])).toBe(1);
    const candidates = (await client.memoryCandidates()).map(({ candidate: value }) => value);
    expect(candidates).toHaveLength(2);
    expect(candidates.find(({ summary }) => summary === correction.summary)?.evidence).toEqual([correctionRef]);
    expect(candidates.find(({ summary }) => summary === "Keep original evidence immutable")?.evidence).toHaveLength(2);
    const allOrigins = await client.transcriptEvidenceOrigins(candidates.flatMap(({ evidence }) => evidence));
    expect(allOrigins).toHaveLength(3);
    expect(new Set(allOrigins.map(({ independenceKey }) => independenceKey)).size).toBe(1);
  } finally { await worker.close(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});
