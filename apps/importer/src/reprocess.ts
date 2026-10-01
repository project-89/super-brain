import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import {
  derivationHash, derivedTranscriptRecordSchema, transcriptDerivationManifestSchema,
  type DerivedTranscriptRecord, type TranscriptArtifact, type TranscriptRun,
} from "@_89/fold-transcript";
import { toolResultFailed } from "./adapters.js";
import { decryptVaultLine } from "./encryption.js";

export const REPROCESSOR = { id: "retained-transcript-evidence", version: "3" } as const;
type Source = { run: TranscriptRun; artifact: TranscriptArtifact };
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const label = (value: unknown): string => typeof value === "string" && /^[a-zA-Z0-9_.-]{1,100}$/.test(value) ? value : "<missing-or-invalid-type>";
const claudeKnown = new Set(["assistant", "attachment", "file-history-snapshot", "last-prompt", "progress", "queue-operation", "summary", "system", "tool-use-summary", "user"]);
const codexKnown = new Set(["session_meta", "turn_context", "event_msg", "world_state", "compacted"]);
const codexItems = new Set(["message", "function_call", "custom_tool_call", "function_call_output", "custom_tool_call_output", "web_search_call", "reasoning"]);

export function encodeRetainedData(data: Record<string, unknown>) {
  const supported = (value: unknown): boolean => {
    if (typeof value === "string") return !/[\u0000\uD800-\uDFFF]/u.test(value);
    if (Array.isArray(value)) return value.every(supported);
    if (value !== null && typeof value === "object") return Object.entries(value).every(([key, item]) => supported(key) && supported(item));
    return true;
  };
  return supported(data) ? { data } : { data: { base64: Buffer.from(JSON.stringify(data), "utf8").toString("base64") }, dataEncoding: "base64-json-utf8" as const };
}

export function deriveRetainedRecord(source: TranscriptArtifact["source"], record: Record<string, unknown>) {
  const payload = object(record.payload);
  const sourceType = record.type === "response_item" ? `${label(record.type)}:${label(payload?.type)}` : label(record.type ?? record.role);
  const evidence: Array<{ kind: DerivedTranscriptRecord["kind"]; data: Record<string, unknown> }> = [];
  const add = (kind: DerivedTranscriptRecord["kind"], data: Record<string, unknown> = { record }) => evidence.push({ kind, data });
  let known: boolean;
  if (source === "codex") {
    known = record.type === "response_item" ? codexItems.has(String(payload?.type)) : codexKnown.has(String(record.type));
    if (record.type === "token_usage_record" || (record.type === "event_msg" && payload?.type === "token_count")) add("usage");
    if (record.type === "inter_agent_communication_metadata") add("agent-link");
    if (record.type === "response_item" && payload?.type === "agent_message") add("agent-message");
    if (record.type === "response_item" && ["function_call_output", "custom_tool_call_output"].includes(String(payload?.type))) {
      const failed = toolResultFailed(payload);
      add("tool-result", { record, status: failed === null ? "unknown" : failed ? "failed" : "completed" });
    }
    if (record.type === "response_item" && payload?.type === "web_search_call") add("web-search");
  } else if (source === "claude-code") {
    known = claudeKnown.has(String(record.type));
    const message = object(record.message);
    if (object(message?.usage) !== undefined) add("usage");
    for (const block of Array.isArray(message?.content) ? message.content : []) {
      const item = object(block);
      if (item?.type !== "tool_result") continue;
      const failed = toolResultFailed(item);
      add("tool-result", { block: item, messageId: typeof record.uuid === "string" ? record.uuid : null, status: failed === null ? "unknown" : failed ? "failed" : "completed" });
    }
  } else {
    const type = record.type ?? record.role;
    known = ["archive_metadata", "user", "gemini", "assistant", "system", "tool"].includes(String(type));
    if (object(record.tokens) !== undefined || typeof record.token_count === "number") add("usage");
    if (type === "archive_metadata") {
      const metadata = object(record.metadata);
      if (metadata?.input_tokens != null || metadata?.output_tokens != null) add("usage");
      if (typeof metadata?.parent_session_id === "string") add("agent-link");
    }
    if (source === "hermes" && type === "tool") {
      const failed = toolResultFailed({ output: record.content });
      add("tool-result", { record, status: failed === null ? "unknown" : failed ? "failed" : "completed" });
    }
    for (const value of Array.isArray(record.toolCalls) ? record.toolCalls : []) {
      const tool = object(value);
      if (tool && (tool.result != null || ["success", "error", "cancelled"].includes(String(tool.status)))) {
        add("tool-result", { tool, status: tool.status === "success" ? "completed" : tool.status === "error" ? "failed" : "unknown" });
      }
    }
  }
  return { sourceType, evidence, unclassified: !known && evidence.length === 0 };
}

// Stage bounded chunks privately; the manifest commits to every byte of derived evidence.
export async function stageDerivation(source: Source, path: string, directory: string, key?: Uint8Array) {
  const before = await stat(path);
  const digest = createHash("sha256");
  const byKind: Record<string, number> = {};
  const unclassifiedTypes: Record<string, number> = {};
  const chunkHashes: string[] = [];
  let chunk: DerivedTranscriptRecord[] = [];
  let chunkBytes = 0;
  let records = 0;
  let sourceRecords = 0;
  const flush = async () => {
    if (chunk.length === 0) return;
    await writeFile(join(directory, `${chunkHashes.length}.json`), JSON.stringify(chunk), { flag: "wx", mode: 0o600 });
    chunkHashes.push(derivationHash(chunk));
    chunk = [];
    chunkBytes = 0;
  };
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  let line = 0;
  for await (const encrypted of lines) {
    line += 1;
    if (!encrypted.trim()) continue;
    const plaintext = decryptVaultLine(encrypted, key);
    digest.update(plaintext).update("\n");
    const record = object(JSON.parse(plaintext));
    if (record === undefined) throw new Error(`Retained line ${line} is not a JSON object`);
    sourceRecords += 1;
    const extracted = deriveRetainedRecord(source.artifact.source, record);
    if (extracted.unclassified) unclassifiedTypes[extracted.sourceType] = (unclassifiedTypes[extracted.sourceType] ?? 0) + 1;
    for (const item of extracted.evidence) {
      const derived = derivedTranscriptRecordSchema.parse({ kind: item.kind, ...encodeRetainedData(item.data), ordinal: records, line, sourceType: extracted.sourceType });
      const bytes = Buffer.byteLength(JSON.stringify(derived));
      if (bytes > 15 * 1024 * 1024) throw new Error(`Retained line ${line} exceeds the API record size; no content was truncated`);
      if (chunk.length >= 100 || chunkBytes + bytes > 1024 * 1024) await flush();
      chunk.push(derived);
      chunkBytes += bytes;
      records += 1;
      byKind[item.kind] = (byKind[item.kind] ?? 0) + 1;
    }
  }
  await flush();
  const after = await stat(path);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) throw new Error("Retained artifact changed during processing; retry with a stable archive");
  const artifact = source.artifact;
  return transcriptDerivationManifestSchema.parse({
    runId: source.run.id, artifactId: artifact.id, sourceSha256: artifact.sha256,
    inputSha256: digest.digest("hex"), inputKind: "retained-policy-artifact", parser: REPROCESSOR,
    policy: { contentPolicy: artifact.contentPolicy, ...(artifact.reasoningPolicy === undefined ? {} : { reasoningPolicy: artifact.reasoningPolicy }), ...(artifact.encryptedReasoningPolicy === undefined ? {} : { encryptedReasoningPolicy: artifact.encryptedReasoningPolicy }), ...(artifact.anonymizationPolicy === undefined ? {} : { anonymizationPolicy: artifact.anonymizationPolicy }) },
    records, sourceRecords, byKind, unclassifiedTypes, chunkHashes,
  });
}

export interface ReprocessOptions {
  apiUrl: string;
  organizationId: string;
  workspaceId: string;
  bearerToken: string;
  vaultRoot: string;
  stateRoot: string;
  key?: Uint8Array;
  confirm: boolean;
  limit?: number;
  runId?: string;
  source?: TranscriptArtifact["source"] | "claude" | "all";
  fetcher?: typeof fetch;
  progress?: (value: unknown) => void;
}

export function parseReprocessSource(value: unknown): TranscriptArtifact["source"] | undefined {
  if (value === undefined || value === "all") return undefined;
  if (value === "claude" || value === "claude-code") return "claude-code";
  if (value === "codex" || value === "gemini" || value === "hermes") return value;
  throw new TypeError("--source must be claude, codex, gemini, hermes, or all");
}

export async function reprocessTranscripts(options: ReprocessOptions) {
  const sourceFilter = parseReprocessSource(options.source);
  const url = new URL(options.apiUrl);
  if (!["http:", "https:"].includes(url.protocol) || !options.bearerToken.trim()) throw new Error("Reprocessing requires an HTTP(S) API URL and bearer token");
  if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1)) throw new Error("limit must be a positive integer");
  const endpoint = `${options.apiUrl.replace(/\/+$/, "")}/v1/organizations/${encodeURIComponent(options.organizationId)}/workspaces/${encodeURIComponent(options.workspaceId)}/transcript-derivations`;
  const request = async <T>(suffix: string, body?: unknown): Promise<T> => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const response = await (options.fetcher ?? fetch)(`${endpoint}${suffix}`, {
          method: body === undefined ? "GET" : "POST", signal: AbortSignal.timeout(60_000),
          headers: { authorization: `Bearer ${options.bearerToken}`, "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (!response.ok) {
          if ((response.status === 429 || response.status >= 500) && attempt < 3) {
            const retryAfter = response.headers.get("retry-after");
            const seconds = retryAfter === null ? NaN : Number(retryAfter);
            const wait = Number.isFinite(seconds) ? seconds * 1000 : retryAfter === null ? 0 : Date.parse(retryAfter) - Date.now();
            await response.body?.cancel();
            await delay(Math.max(500 * 2 ** attempt, Math.min(Number.isFinite(wait) ? wait : 0, 300_000)));
            continue;
          }
          throw new Error(`Reprocessing API returned HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
        }
        return await response.json() as T;
      } catch (error) {
        if (attempt >= 3 || (error instanceof Error && error.message.startsWith("Reprocessing API"))) throw error;
        await delay(500 * 2 ** attempt);
      }
    }
  };
  await mkdir(options.stateRoot, { recursive: true, mode: 0o700 });
  const lockPath = join(options.stateRoot, "reprocess.lock");
  const lock = await open(lockPath, "wx", 0o600).catch(() => { throw new Error(`Reprocessing lock exists: ${lockPath}. Verify no runner is active before removing a stale lock.`); });
  const results: Array<Record<string, unknown>> = [];
  const save = async () => {
    const path = join(options.stateRoot, "report.json");
    await writeFile(`${path}.tmp`, JSON.stringify({ mode: options.confirm ? "apply" : "dry-run", apiUrl: options.apiUrl, organizationId: options.organizationId, workspaceId: options.workspaceId, source: sourceFilter ?? "all", parser: REPROCESSOR, updatedAt: new Date().toISOString(), results }, null, 2), { mode: 0o600 });
    await rename(`${path}.tmp`, path);
  };
  try {
    await lock.writeFile(String(process.pid));
    let cursor: string | undefined;
    do {
      const page = await request<{ sources: Source[]; nextCursor?: string }>(`/sources?limit=100${cursor === undefined ? "" : `&pageCursor=${encodeURIComponent(cursor)}`}`);
      for (const source of page.sources) {
        if (sourceFilter !== undefined && source.artifact.source !== sourceFilter) continue;
        if (options.runId !== undefined && source.run.id !== options.runId) continue;
        if (options.limit !== undefined && results.length >= options.limit) break;
        const base = { runId: source.run.id, source: source.artifact.source, artifactId: source.artifact.id };
        let directory: string | undefined;
        try {
          if (!source.artifact.stored || source.artifact.contentPolicy !== "redacted") { results.push({ ...base, status: "unavailable", reason: "No retained content" }); continue; }
          const hash = source.artifact.sha256;
          if (!/^[a-f0-9]{64}$/.test(hash) || !["codex", "claude-code", "gemini", "hermes"].includes(source.artifact.source)) throw new Error("Invalid source artifact identity");
          const path = join(options.vaultRoot, source.artifact.source, hash.slice(0, 2), `${hash}.jsonl`);
          const encrypted = await stat(`${path}.enc`).then(() => true).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error; });
          directory = await mkdtemp(join(options.stateRoot, "staging-"));
          const manifest = await stageDerivation(source, encrypted ? `${path}.enc` : path, directory, options.key);
          const derivationId = derivationHash(manifest);
          let importedEvents = 0;
          if (options.confirm) {
            let existing: { complete: boolean; storedChunks: number } | undefined;
            let derivationCursor: string | undefined;
            do {
              const state = await request<{ derivations: Array<{ derivationId: string; complete: boolean; storedChunks: number }>; nextCursor?: string }>(`?runId=${encodeURIComponent(source.run.id)}&limit=100${derivationCursor ? `&pageCursor=${encodeURIComponent(derivationCursor)}` : ""}`);
              existing = state.derivations.find((item) => item.derivationId === derivationId);
              derivationCursor = state.nextCursor;
            } while (!existing && derivationCursor);
            if (!existing?.complete) {
              const posted = await request<{ imported: boolean }>("", { manifest });
              importedEvents += Number(posted.imported);
              for (let sequence = existing?.storedChunks ?? 0; sequence < manifest.chunkHashes.length; sequence += 1) {
                const records: unknown = JSON.parse(await readFile(join(directory, `${sequence}.json`), "utf8"));
                if (derivationHash(records) !== manifest.chunkHashes[sequence]) throw new Error("Staged chunk failed checksum verification");
                const postedChunk = await request<{ imported: boolean }>("", { chunk: { runId: source.run.id, derivationId, sequence, records } });
                importedEvents += Number(postedChunk.imported);
              }
            }
          }
          results.push({ ...base, status: options.confirm ? "complete" : "ready", derivationId, importedEvents, records: manifest.records, sourceRecords: manifest.sourceRecords, byKind: manifest.byKind, unclassifiedTypes: manifest.unclassifiedTypes });
        } catch (error) {
          results.push({ ...base, status: "failed", error: error instanceof Error ? error.message : String(error) });
        } finally {
          if (directory !== undefined) await rm(directory, { recursive: true, force: true });
          await save();
          options.progress?.(results[results.length - 1]);
        }
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined && (options.limit === undefined || results.length < options.limit));
    if (options.runId !== undefined && results.length === 0) throw new Error("Requested run was not found in authorized reprocessing sources");
    return results;
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}
