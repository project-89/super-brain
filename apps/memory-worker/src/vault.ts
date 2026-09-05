import { createHash } from "node:crypto";
import { createReadStream, type Stats } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import { createInterface } from "node:readline";
import type { TranscriptArtifact, TranscriptRun, TranscriptSource, TranscriptTurn } from "@_89/fold-transcript";
import { NativeTranscriptNormalizer, decryptVaultLine, nativeTextContent } from "@_89/super-brain-importer";
import type { VaultMessage } from "./types.js";

const recordValue = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

export interface VaultCoverage {
  readonly integrity: "verified" | "legacy-unverified";
  readonly records: number;
  readonly messages: number;
  readonly toolResults: number;
  readonly unknownRecords: number;
  readonly excludedMessages: number;
  readonly turnIds: readonly string[];
}
export type VaultReadResult =
  | { readonly status: "ready"; readonly messages: readonly VaultMessage[]; readonly coverage: VaultCoverage }
  | { readonly status: "waiting"; readonly reason: "artifact-unavailable" | "key-unavailable" | "metadata-unavailable" }
  | { readonly status: "retry"; readonly reason: "decryption-failed" | "io-error" | "artifact-changing"; readonly line?: number }
  | { readonly status: "excluded"; readonly reason: "artifact-identity-mismatch" | "artifact-integrity-mismatch" | "unsupported-parser" | "malformed-record" | "turn-identity-mismatch" | "nonregular-artifact" | "artifact-too-large"; readonly line?: number };

export interface VaultReadOptions {
  readonly artifact?: TranscriptArtifact;
  readonly encryptionKey?: Uint8Array;
  readonly canonicalTurns?: readonly TranscriptTurn[];
  readonly maxBytes?: number;
}
export interface VaultNormalizationOptions {
  readonly parserVersion?: "1" | "2";
  readonly canonicalTurns?: readonly TranscriptTurn[];
}

class VaultIdentityError extends Error {}

function isBoilerplate(text: string): boolean {
  return /^(?:You are (?:Codex|Claude)|# AGENTS\.md instructions|<permissions instructions>|<environment_context>|<collaboration_mode>|Hello memory agent)/i.test(text.trimStart().slice(0, 160));
}

class VaultMessageProjection {
  readonly messages: VaultMessage[] = [];
  private readonly decoder: NativeTranscriptNormalizer;
  private readonly seen = new Set<string>();
  private readonly turnIds = new Set<string>();
  private readonly observedOrdinals = new Set<number>();
  private readonly turns: ReadonlyMap<number, TranscriptTurn> | undefined;
  private projectPath: string | undefined;
  private recordCount = 0;
  private unknownCount = 0;
  private excludedCount = 0;
  private resultCount = 0;
  constructor(readonly source: TranscriptSource, nativeId: string, options: VaultNormalizationOptions) {
    this.decoder = new NativeTranscriptNormalizer(source, nativeId, { parserVersion: options.parserVersion ?? "1" });
    this.turns = options.canonicalTurns === undefined ? undefined : new Map(options.canonicalTurns.map((turn) => [turn.ordinal, turn]));
    if (this.turns !== undefined && this.turns.size !== options.canonicalTurns!.length) throw new VaultIdentityError("duplicate canonical ordinal");
  }
  push(record: Record<string, unknown>): void {
    const normalized = this.decoder.push(record);
    this.recordCount++;
    if (normalized.unknown) this.unknownCount++;
    if (normalized.cwd !== undefined) this.projectPath = normalized.cwd;
    if (this.source === "claude-code") {
      const text = nativeTextContent(recordValue(record.message)?.content);
      const observed = text.match(/<working_directory>([^<]+)<\/working_directory>/i)?.[1]?.trim();
      if (observed?.startsWith("/") === true) this.projectPath = observed;
    }
    if (normalized.turn === undefined) return;
    const canonical = this.turns?.get(normalized.turn.ordinal);
    if (this.turns !== undefined && canonical === undefined) throw new VaultIdentityError("native turn has no canonical identity");
    const turnId = canonical?.id ?? normalized.turn.id;
    this.turnIds.add(turnId);
    this.observedOrdinals.add(normalized.turn.ordinal);
    for (const message of normalized.messages) {
      if (message.role !== "user" && message.role !== "assistant") { this.excludedCount++; continue; }
      const text = message.text.trim();
      if (text.length === 0 || isBoilerplate(text)) { this.excludedCount++; continue; }
      const key = message.nativeId === undefined ? undefined : JSON.stringify([message.role, message.nativeId, text]);
      if (key !== undefined && this.seen.has(key)) { this.excludedCount++; continue; }
      if (key !== undefined) this.seen.add(key);
      this.messages.push({ role: message.role, text, turnId,
        ...(normalized.at === undefined ? {} : { at: normalized.at }), ...(this.projectPath === undefined ? {} : { projectPath: this.projectPath }),
        ...(message.nativeId === undefined ? {} : { nativeId: message.nativeId }), evidenceKind: "message" });
    }
    for (const action of normalized.actions) {
      if (action.kind !== "result") continue;
      const result = action.result ?? "unknown";
      const text = action.text?.trim() ?? "";
      const key = action.nativeId === undefined ? undefined : JSON.stringify(["tool-result", action.nativeId, result, text]);
      if (key !== undefined && this.seen.has(key)) { this.excludedCount++; continue; }
      if (key !== undefined) this.seen.add(key);
      this.resultCount++;
      this.messages.push({ role: "tool", evidenceKind: "tool-result", result,
        text: `Tool result (${result})${action.name === undefined ? "" : `: ${action.name}`}${text.length === 0 ? "" : `\n${text}`}`, turnId,
        ...(normalized.at === undefined ? {} : { at: normalized.at }), ...(this.projectPath === undefined ? {} : { projectPath: this.projectPath }),
        ...(action.nativeId === undefined ? {} : { nativeId: action.nativeId }), ...(action.name === undefined ? {} : { toolName: action.name }) });
    }
  }
  finish(integrity: VaultCoverage["integrity"] = "legacy-unverified"): Extract<VaultReadResult, { status: "ready" }> {
    if (this.turns !== undefined && [...this.turns.keys()].some((ordinal) => !this.observedOrdinals.has(ordinal))) throw new VaultIdentityError("canonical turn has no native evidence");
    return { status: "ready", messages: this.messages, coverage: { integrity, records: this.recordCount, messages: this.messages.length,
      toolResults: this.resultCount, unknownRecords: this.unknownCount, excludedMessages: this.excludedCount, turnIds: [...this.turnIds] } };
  }
}

export function messagesFromVaultRecords(source: TranscriptSource, nativeId: string, records: readonly Record<string, unknown>[], options: VaultNormalizationOptions = {}): VaultMessage[] {
  const projection = new VaultMessageProjection(source, nativeId, options);
  for (const record of records) projection.push(record);
  return [...projection.finish().messages];
}

export function vaultPath(vaultRoot: string, run: TranscriptRun, encrypted = false, artifact?: TranscriptArtifact): string | undefined {
  const sha256 = artifact?.sha256 ?? run.artifactId.replace(/^artifact-/, "");
  if (!/^[0-9a-f]{64}$/.test(sha256)) return undefined;
  return join(vaultRoot, run.source, sha256.slice(0, 2), `${sha256}.jsonl${encrypted ? ".enc" : ""}`);
}

export async function readVaultEvidence(vaultRoot: string, run: TranscriptRun, options: VaultReadOptions): Promise<VaultReadResult> {
  const artifact = options.artifact;
  if (artifact === undefined) return { status: "waiting", reason: "metadata-unavailable" };
  if (artifact.id !== run.artifactId || artifact.source !== run.source || !/^[0-9a-f]{64}$/.test(artifact.sha256)) return { status: "excluded", reason: "artifact-identity-mismatch" };
  const parserVersion = artifact.parser.version;
  if ((parserVersion !== "1" && parserVersion !== "2") || artifact.parser.id !== (run.source === "codex" ? "codex-jsonl" : "claude-jsonl")) return { status: "excluded", reason: "unsupported-parser" };
  if (artifact.anonymizationPolicy !== undefined && artifact.anonymizationPolicy !== "none" && options.canonicalTurns === undefined) return { status: "waiting", reason: "metadata-unavailable" };
  const encryptedPath = vaultPath(vaultRoot, run, true, artifact)!;
  const plainPath = vaultPath(vaultRoot, run, false, artifact)!;
  let path: string | undefined;
  let before: Stats | undefined;
  try {
    for (const candidate of [encryptedPath, plainPath]) {
      try { before = await lstat(candidate); path = candidate; break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    if (path === undefined || before === undefined) return { status: "waiting", reason: "artifact-unavailable" };
    if (!before.isFile()) return { status: "excluded", reason: "nonregular-artifact" };
    if (relative(await realpath(vaultRoot), await realpath(path)).startsWith("..")) return { status: "excluded", reason: "artifact-identity-mismatch" };
    if (before.size > (options.maxBytes ?? 128 * 1024 * 1024)) return { status: "excluded", reason: "artifact-too-large" };
    if (path === encryptedPath && options.encryptionKey === undefined) return { status: "waiting", reason: "key-unavailable" };
    const projection = new VaultMessageProjection(run.source, run.nativeId, { parserVersion, ...(options.canonicalTurns === undefined ? {} : { canonicalTurns: options.canonicalTurns }) });
    // Read only the size inspected above; appenders cannot make this pass unbounded.
    const stream = createReadStream(path, { end: Math.max(0, before.size - 1) });
    const storedHash = createHash("sha256");
    stream.on("data", (chunk) => storedHash.update(chunk));
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    let lineNumber = 0;
    try {
      for await (const line of lines) {
        lineNumber++;
        if (line.trim().length === 0) continue;
        let decrypted: string;
        try {
          if (path === encryptedPath && recordValue(JSON.parse(line))?.$superBrainEncrypted !== 1) return { status: "excluded", reason: "malformed-record", line: lineNumber };
          decrypted = decryptVaultLine(line, options.encryptionKey);
        }
        catch { return { status: "retry", reason: "decryption-failed", line: lineNumber }; }
        let record: Record<string, unknown> | undefined;
        try { record = recordValue(JSON.parse(decrypted)); } catch { /* Corruption is reported, not skipped. */ }
        if (record === undefined) return { status: "excluded", reason: "malformed-record", line: lineNumber };
        projection.push(record);
      }
    } finally { lines.close(); stream.destroy(); }
    const after = await lstat(path);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) return { status: "retry", reason: "artifact-changing" };
    if (artifact.storedSha256 !== undefined && artifact.storedSha256 !== storedHash.digest("hex")) return { status: "excluded", reason: "artifact-integrity-mismatch" };
    return projection.finish(artifact.storedSha256 === undefined ? "legacy-unverified" : "verified");
  } catch (error) {
    if (error instanceof VaultIdentityError) return { status: "excluded", reason: "turn-identity-mismatch" };
    return { status: "retry", reason: "io-error" };
  }
}

/** Legacy convenience API. Durable workers use readVaultEvidence with canonical metadata. */
export async function readVaultMessages(vaultRoot: string, run: TranscriptRun, encryptionKey?: Uint8Array): Promise<readonly VaultMessage[] | undefined> {
  const sha256 = run.artifactId.replace(/^artifact-/, "");
  const result = await readVaultEvidence(vaultRoot, run, { artifact: {
    id: run.artifactId, source: run.source, sha256, sourcePathHash: "0".repeat(64), byteLength: 0,
    mediaType: "application/x-ndjson", parser: { id: run.source === "codex" ? "codex-jsonl" : "claude-jsonl", version: "1" },
    contentPolicy: "redacted", stored: true, redactionCount: 0,
  }, ...(encryptionKey === undefined ? {} : { encryptionKey }) });
  if (result.status === "ready") return result.messages;
  if (result.status === "waiting") return undefined;
  throw new Error(result.status === "retry" && result.reason === "decryption-failed" ? "encrypted vault content failed authentication" : `vault evidence unavailable: ${result.reason}`);
}
