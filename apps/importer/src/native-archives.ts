import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { createRequire } from "node:module";

import { TranscriptBuilder } from "./builder.js";
import { fileMetadata, sha256File, sha256Text } from "./files.js";
import { arrayValue, isoTimestamp, recordValue, stringValue } from "./json.js";
import { toolResultFailed } from "./adapters.js";
import type { ParsedTranscript } from "./types.js";

type Document = Record<string, unknown> & { messages: unknown[] };

// SQLite is a prefix-only builtin; preserve node: through downstream tsup bundles.
function openDatabase(path: string) {
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
  return new DatabaseSync(path, { readOnly: true });
}

function document(value: unknown): Document {
  const result = recordValue(value);
  if (!result || !Array.isArray(result.messages)) throw new Error("Unsupported native transcript: missing messages array");
  return result as Document;
}

export function hermesSessionIds(path: string): string[] {
  const db = openDatabase(path);
  try { return db.prepare("SELECT id FROM sessions ORDER BY id").all().map((row) => String(row.id)); }
  finally { db.close(); }
}

export function readHermesSnapshot(path: string, sessionId: string): Document {
  const db = openDatabase(path);
  try {
    // One read transaction includes WAL-backed messages and matching session metadata.
    db.exec("BEGIN");
    const session = db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId);
    if (!session) throw new Error("Hermes source session no longer exists");
    const messages = db.prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY id").all(sessionId).map((row) => {
      const parsed = { ...row } as Record<string, unknown>;
      for (const field of ["tool_calls", "reasoning_details", "codex_reasoning_items", "codex_message_items", "api_content"]) {
        if (typeof parsed[field] === "string") {
          try { parsed[field] = JSON.parse(parsed[field]) as unknown; } catch { /* Preserve unfamiliar source encoding. */ }
        }
      }
      return parsed;
    });
    db.exec("COMMIT");
    return { ...session, session_id: session.id, messages };
  } finally { db.close(); }
}

export async function readArchiveDocument(transcript: Pick<ParsedTranscript, "sourcePath" | "archiveInput">): Promise<Document> {
  if (transcript.archiveInput?.kind === "hermes-sqlite") return readHermesSnapshot(transcript.sourcePath, transcript.archiveInput.sessionId);
  if (transcript.sourcePath.endsWith(".jsonl")) throw new Error("Gemini append-only JSONL archives are not supported by this parser; retain the original file");
  const text = await readFile(transcript.sourcePath, "utf8");
  let value: unknown;
  try { value = JSON.parse(text) as unknown; } catch { throw new Error("Invalid native transcript JSON"); }
  return document(value);
}

export function archiveRecords(value: Document): Record<string, unknown>[] {
  const { messages, ...metadata } = value;
  return [{ type: "archive_metadata", metadata }, ...messages.map((message) => recordValue(message) ?? { type: "invalid_native_record", value: message })];
}

function timestamp(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value * 1000).toISOString();
  // Naive legacy Hermes timestamps have no source timezone; do not invent UTC.
  return typeof value === "string" && /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? isoTimestamp(value) : undefined;
}

export async function parseNativeArchive(
  path: string,
  source: "gemini" | "hermes",
  sessionId?: string,
): Promise<ParsedTranscript> {
  const archiveInput = sessionId === undefined ? { kind: "json" as const } : { kind: "hermes-sqlite" as const, sessionId };
  const before = await fileMetadata(path);
  const value = await readArchiveDocument({ sourcePath: path, archiveInput });
  const nativeId = stringValue(source === "gemini" ? value.sessionId : value.session_id);
  if (!nativeId) throw new Error("Unsupported native transcript: missing session identity");
  const builder = new TranscriptBuilder(source, nativeId);
  const at = timestamp(value.startTime ?? value.started_at ?? value.session_start);
  builder.countRecord(at, "archive_metadata");
  builder.observeContext(stringValue(value.cwd), stringValue(value.git_branch), at);
  if (source === "gemini" && typeof value.projectHash === "string") {
    try {
      const root = (await readFile(join(dirname(dirname(path)), ".project_root"), "utf8")).trim();
      if (isAbsolute(root) && sha256Text(root) === value.projectHash) builder.observeContext(root, undefined, at);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  builder.setModel(stringValue(value.model));
  for (const message of value.messages) {
    const record = recordValue(message);
    const kind = stringValue(source === "gemini" ? record?.type : record?.role);
    const time = timestamp(record?.timestamp);
    builder.countRecord(time, kind && /^[a-zA-Z0-9_.-]{1,100}$/.test(kind) ? kind : "<invalid>");
    if (!record) { builder.countUnknown(); continue; }
    const id = typeof record.id === "number" ? String(record.id) : stringValue(record.id);
    if (kind === "user") builder.startTurn(id, time);
    if (kind === "user" || kind === "assistant" || kind === "gemini" || kind === "tool" || kind === "system") {
      builder.addMessage(kind === "gemini" ? "assistant" : kind, time, id);
    } else { builder.countUnknown(); continue; }
    builder.setModel(stringValue(record.model));
    for (const call of arrayValue(source === "gemini" ? record.toolCalls : record.tool_calls)) {
      const tool = recordValue(call);
      const name = stringValue(tool?.name) ?? stringValue(recordValue(tool?.function)?.name);
      const callId = stringValue(tool?.id);
      builder.addToolCall(name, timestamp(tool?.timestamp) ?? time, callId);
      if (source === "gemini" && tool && (tool.result != null || ["success", "error", "cancelled"].includes(String(tool.status)))) {
        builder.addToolResult(name, timestamp(tool.timestamp) ?? time,
          tool.status === "success" ? false : tool.status === "error" ? true : null, callId);
      }
    }
    if (kind === "tool") {
      builder.addToolResult(stringValue(record.tool_name), time, toolResultFailed({ output: record.content }), stringValue(record.tool_call_id));
    }
  }
  const snapshot = JSON.stringify(value);
  const sha256 = sessionId === undefined ? await sha256File(path) : sha256Text(snapshot);
  const after = await fileMetadata(path);
  if (sessionId === undefined && (before.byteLength !== after.byteLength || before.modifiedAt !== after.modifiedAt)) {
    throw new Error("Transcript source changed while it was being parsed; retry the scan");
  }
  let bundle = builder.finish({
    id: `artifact-${sha256}`, source, sha256, sourcePathHash: sha256Text(path),
    byteLength: sessionId === undefined ? after.byteLength : Buffer.byteLength(snapshot),
    mediaType: "application/x-ndjson", parser: { id: `${source}-${archiveInput.kind}`, version: "1" },
    ...(sessionId === undefined ? { modifiedAt: after.modifiedAt } : {}),
    contentPolicy: "metadata-only", stored: false, redactionCount: 0,
  });
  const projectHash = stringValue(value.projectHash);
  if (source === "gemini" && projectHash && bundle.projects.length === 0) {
    const identityKeyHash = sha256Text(`gemini-project:${projectHash}`);
    const project = { id: `project-${identityKeyHash.slice(0, 24)}`, identityKeyHash,
      name: `Gemini project ${projectHash.slice(0, 12)}`, resolution: "estimated" as const, roots: [] };
    bundle = { ...bundle, projects: [project], run: { ...bundle.run, projectId: project.id, projectResolution: "estimated" } };
  }
  return { sourcePath: path, archiveInput, bundle, diagnostics: builder.diagnostics() };
}
