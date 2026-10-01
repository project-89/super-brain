import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { derivationHash } from "@_89/fold-transcript";
import { deriveRetainedRecord, encodeRetainedData, parseReprocessSource, reprocessTranscripts, stageDerivation } from "../src/reprocess.js";
import { encryptVaultLine } from "../src/encryption.js";
import { parseCodexTranscript } from "../src/adapters.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function directory() { const path = await mkdtemp(join(tmpdir(), "fold-reprocess-")); directories.push(path); return path; }

describe("historical retained evidence", () => {
  it("validates source selections and preserves existing CLI aliases", () => {
    for (const value of [undefined, "all"]) expect(parseReprocessSource(value)).toBeUndefined();
    for (const value of ["claude", "claude-code"]) expect(parseReprocessSource(value)).toBe("claude-code");
    for (const value of ["codex", "gemini", "hermes"]) expect(parseReprocessSource(value)).toBe(value);
    for (const value of ["", "other", "Gemini", null, 123]) expect(() => parseReprocessSource(value)).toThrow("--source must be");
  });

  it.each(["gemini", "hermes"] as const)("filters %s sources across pages before applying the limit", async (source) => {
    const root = await directory();
    const excluded = { run: { id: "codex:old-run" }, artifact: { source: "codex", id: "old-artifact", stored: false } };
    const selected = { run: { id: `${source}:new-run` }, artifact: { source, id: "new-artifact", stored: false } };
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      expect(url.pathname.endsWith("/sources")).toBe(true);
      return Response.json(url.searchParams.has("pageCursor")
        ? { sources: [excluded, selected, { ...selected, run: { id: "over-limit" } }] }
        : { sources: [excluded], nextCursor: "page-two" });
    }) as unknown as typeof fetch;
    const results = await reprocessTranscripts({ apiUrl: "http://localhost:3003", organizationId: "org", workspaceId: "workspace", bearerToken: "test", vaultRoot: root, stateRoot: join(root, "state"), confirm: true, source, limit: 1, fetcher });
    expect(results).toMatchObject([{ runId: `${source}:new-run`, source, status: "unavailable" }]);
    expect(results).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.parse(await readFile(join(root, "state", "report.json"), "utf8")).source).toBe(source);
  });

  it("rejects an invalid runtime source before fetching or creating runner state", async () => {
    const root = await directory();
    const fetcher = vi.fn() as unknown as typeof fetch;
    await expect(reprocessTranscripts({ apiUrl: "http://localhost:3003", organizationId: "org", workspaceId: "workspace", bearerToken: "test", vaultRoot: root, stateRoot: join(root, "state"), confirm: false, source: "invalid" as "gemini", fetcher })).rejects.toThrow("--source must be");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("dry-runs without writes and resumes only server-confirmed chunks after interruption", async () => {
    const root = await directory();
    const path = join(root, "source.jsonl");
    await writeFile(path, Array.from({ length: 105 }, (_, tokens) => JSON.stringify({ type: "token_usage_record", tokens })).join("\n") + "\n");
    const { bundle } = await parseCodexTranscript(path);
    const source = { run: bundle.run, artifact: { ...bundle.artifact, stored: true, contentPolicy: "redacted" as const } };
    const vault = join(root, "codex", bundle.artifact.sha256.slice(0, 2));
    await mkdir(vault, { recursive: true });
    await writeFile(join(vault, `${bundle.artifact.sha256}.jsonl`), await readFile(path));
    let manifest: { chunkHashes: string[] } | undefined;
    let storedChunks = 0;
    let fail = true;
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/sources")) return Response.json({ sources: [source] });
      if (init?.method === "GET") return Response.json({ derivations: manifest === undefined ? [] : [{ derivationId: derivationHash(manifest), storedChunks, complete: storedChunks === manifest.chunkHashes.length }] });
      const body = JSON.parse(String(init?.body));
      if (body.manifest) { const imported = manifest === undefined; manifest = body.manifest; return Response.json({ imported }); }
      if (body.chunk.sequence === 1 && fail) return new Response("interrupted", { status: 409 });
      expect(body.chunk.sequence).toBe(storedChunks);
      storedChunks += 1;
      return Response.json({ imported: true });
    }) as unknown as typeof fetch;
    const options = { apiUrl: "http://localhost:3003", organizationId: "org", workspaceId: "workspace", bearerToken: "test", vaultRoot: root, stateRoot: join(root, "state"), confirm: false, fetcher };
    expect(await reprocessTranscripts(options)).toMatchObject([{ status: "ready", records: 105, importedEvents: 0 }]);
    expect(manifest).toBeUndefined();
    expect(await reprocessTranscripts({ ...options, confirm: true })).toMatchObject([{ status: "failed" }]);
    expect(storedChunks).toBe(1);
    fail = false;
    expect(await reprocessTranscripts({ ...options, confirm: true })).toMatchObject([{ status: "complete", importedEvents: 1 }]);
    expect(await reprocessTranscripts({ ...options, confirm: true })).toMatchObject([{ status: "complete", importedEvents: 0 }]);
    expect(storedChunks).toBe(2);
  });

  it("losslessly encodes PostgreSQL-incompatible strings and object keys", () => {
    for (const data of [{ output: "a\0b" }, { output: "\ud800" }, { ["nul\0key"]: "preserved" }]) {
      const encoded = encodeRetainedData(data);
      expect(encoded.dataEncoding).toBe("base64-json-utf8");
      expect(JSON.parse(Buffer.from(encoded.data.base64 as string, "base64").toString("utf8"))).toEqual(data);
    }
    expect(encodeRetainedData({ output: "normal" })).toEqual({ data: { output: "normal" } });
  });
  it("distinguishes explicit tool outcomes, usage, agent communication and unknown schemas", () => {
    expect(deriveRetainedRecord("codex", { type: "response_item", payload: { type: "function_call_output", output: "done" } }).evidence[0]?.data.status).toBe("unknown");
    expect(deriveRetainedRecord("codex", { type: "response_item", payload: { type: "function_call_output", output: { exit_code: 1 } } }).evidence[0]?.data.status).toBe("failed");
    expect(deriveRetainedRecord("codex", { type: "response_item", payload: { type: "function_call_output", output: { exit_code: 0 } } }).evidence[0]?.data.status).toBe("completed");
    expect(deriveRetainedRecord("claude-code", { type: "user", message: { content: [{ type: "tool_result", content: "success" }] } }).evidence[0]?.data.status).toBe("unknown");
    for (const [type, kind] of [["token_usage_record", "usage"], ["inter_agent_communication_metadata", "agent-link"]]) {
      expect(deriveRetainedRecord("codex", { type, value: "retained" })).toMatchObject({ unclassified: false, evidence: [{ kind, data: { record: { value: "retained" } } }] });
    }
    expect(deriveRetainedRecord("codex", { type: "response_item", payload: { type: "agent_message" } }).evidence[0]?.kind).toBe("agent-message");
    expect(deriveRetainedRecord("codex", { type: "future_type" }).unclassified).toBe(true);
    expect(deriveRetainedRecord("claude-code", { type: "assistant", message: { usage: { output_tokens: 7 } } }).evidence[0]?.kind).toBe("usage");
  });

  it("streams encrypted archives into deterministic bounded chunks and preserves original identities", async () => {
    const root = await directory();
    const path = join(root, "source.jsonl");
    const records = Array.from({ length: 205 }, (_, tokens) => ({ type: "token_usage_record", tokens }));
    await writeFile(path, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
    const { bundle } = await parseCodexTranscript(path);
    const source = { run: bundle.run, artifact: { ...bundle.artifact, stored: true, contentPolicy: "redacted" as const } };
    const key = new Uint8Array(32).fill(7);
    await writeFile(`${path}.enc`, records.map((record) => encryptVaultLine(JSON.stringify(record), key)).join("\n") + "\n");
    const staged = await directory();
    const manifest = await stageDerivation(source, `${path}.enc`, staged, key);
    expect(manifest).toMatchObject({ parser: { id: "retained-transcript-evidence", version: "3" }, runId: bundle.run.id, sourceSha256: bundle.artifact.sha256, inputSha256: bundle.artifact.sha256, records: 205, sourceRecords: 205, byKind: { usage: 205 } });
    expect(manifest.chunkHashes).toHaveLength(3);
    const final = JSON.parse(await readFile(join(staged, "2.json"), "utf8"));
    expect(final).toHaveLength(5);
    expect(final[4]).toMatchObject({ ordinal: 204, line: 205, data: { record: { tokens: 204 } } });
    expect(derivationHash(final)).toBe(manifest.chunkHashes[2]);
    expect(await stageDerivation(source, path, await directory())).toEqual(manifest);
    await expect(stageDerivation(source, `${path}.enc`, await directory())).rejects.toThrow("vault key");
    await writeFile(path, "not json\n");
    await expect(stageDerivation(source, path, await directory())).rejects.toThrow();
  });
});
