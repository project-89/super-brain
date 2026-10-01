import { join } from "node:path";
import type { TranscriptArtifact, TranscriptRun, TranscriptSource, TranscriptTurn } from "@_89/fold-transcript";
import { NativeTranscriptNormalizer, nativeTextContent, visitStoredTranscriptArtifact } from "@_89/super-brain-importer";
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

type ArchiveSource = Extract<TranscriptSource, "gemini" | "hermes">;
const isArchiveSource = (source: TranscriptSource): source is ArchiveSource => source === "gemini" || source === "hermes";
const archiveText = (source: ArchiveSource, content: unknown): string => source === "gemini" && Array.isArray(content)
  // Gemini thought parts are private model reasoning, never dialogue evidence.
  ? content.flatMap((part) => { const value = recordValue(part); return value?.thought !== true && typeof value?.text === "string" ? [value.text] : []; }).join("\n")
  : nativeTextContent(content);

/** Gemini/Hermes JSON archives: mirrors the importer's turn allocation so citations keep canonical identity. */
class NativeArchiveTurns {
  private readonly byNativeId = new Map<string, { id: string; ordinal: number }>();
  private current: { id: string; ordinal: number } | undefined;
  private count = 0;
  constructor(private readonly source: ArchiveSource, private readonly nativeId: string) {}
  private start(nativeId?: string): void {
    const known = nativeId === undefined ? undefined : this.byNativeId.get(nativeId);
    if (known !== undefined) { this.current = known; return; }
    const ordinal = this.count++;
    this.current = { id: `${this.source}:${this.nativeId}:turn:${ordinal}`, ordinal };
    if (nativeId !== undefined) this.byNativeId.set(nativeId, this.current);
  }
  push(record: Record<string, unknown>): { unknown: boolean; cwd?: string; at?: string; turn?: { id: string; ordinal: number }; message?: { role: "user" | "assistant"; text: string; nativeId?: string } } {
    const type = typeof record.type === "string" ? record.type : undefined;
    if (type === "archive_metadata") {
      const cwd = recordValue(record.metadata)?.cwd;
      return { unknown: false, ...(typeof cwd === "string" && cwd.trim().length > 0 ? { cwd } : {}) };
    }
    const kind = this.source === "gemini" ? type : typeof record.role === "string" ? record.role : undefined;
    const nativeId = typeof record.id === "number" ? String(record.id) : typeof record.id === "string" && record.id.length > 0 ? record.id : undefined;
    const at = typeof record.timestamp === "string" && /(?:Z|[+-]\d\d:\d\d)$/.test(record.timestamp) ? record.timestamp : undefined;
    if (kind !== "user" && kind !== "assistant" && kind !== "gemini" && kind !== "tool" && kind !== "system") return { unknown: true };
    if (kind === "user") this.start(nativeId);
    if (this.current === undefined) this.start();
    const role = kind === "gemini" ? "assistant" : kind;
    return { unknown: false, ...(at === undefined ? {} : { at }), turn: this.current!,
      ...(role === "user" || role === "assistant" ? { message: { role, text: archiveText(this.source, record.content), ...(nativeId === undefined ? {} : { nativeId }) } } : {}) };
  }
}

function isBoilerplate(text: string): boolean {
  return /^(?:You are (?:Codex|Claude)|# AGENTS\.md instructions|<permissions instructions>|<environment_context>|<collaboration_mode>|Hello memory agent)/i.test(text.trimStart().slice(0, 160));
}

class VaultMessageProjection {
  readonly messages: VaultMessage[] = [];
  private readonly decoder: NativeTranscriptNormalizer | undefined;
  private readonly archive: NativeArchiveTurns | undefined;
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
    if (isArchiveSource(source)) this.archive = new NativeArchiveTurns(source, nativeId);
    else this.decoder = new NativeTranscriptNormalizer(source, nativeId, { parserVersion: options.parserVersion ?? "1" });
    this.turns = options.canonicalTurns === undefined ? undefined : new Map(options.canonicalTurns.map((turn) => [turn.ordinal, turn]));
    if (this.turns !== undefined && this.turns.size !== options.canonicalTurns!.length) throw new VaultIdentityError("duplicate canonical ordinal");
  }
  private pushArchive(record: Record<string, unknown>): void {
    const normalized = this.archive!.push(record);
    this.recordCount++;
    if (normalized.unknown) this.unknownCount++;
    if (normalized.cwd !== undefined) this.projectPath = normalized.cwd;
    if (normalized.turn === undefined) return;
    const canonical = this.turns?.get(normalized.turn.ordinal);
    if (this.turns !== undefined && canonical === undefined) throw new VaultIdentityError("native turn has no canonical identity");
    const turnId = canonical?.id ?? normalized.turn.id;
    this.turnIds.add(turnId);
    this.observedOrdinals.add(normalized.turn.ordinal);
    const message = normalized.message;
    if (message === undefined) { this.excludedCount++; return; }
    const text = message.text.trim();
    if (text.length === 0 || isBoilerplate(text)) { this.excludedCount++; return; }
    this.messages.push({ role: message.role, text, turnId, evidenceKind: "message",
      ...(normalized.at === undefined ? {} : { at: normalized.at }), ...(this.projectPath === undefined ? {} : { projectPath: this.projectPath }),
      ...(message.nativeId === undefined ? {} : { nativeId: message.nativeId }) });
  }
  push(record: Record<string, unknown>): void {
    if (this.archive !== undefined) { this.pushArchive(record); return; }
    const normalized = this.decoder!.push(record);
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

function expectedParsers(source: TranscriptSource): readonly string[] {
  if (source === "codex") return ["codex-jsonl"];
  if (source === "claude-code") return ["claude-jsonl"];
  return source === "hermes" ? ["hermes-json", "hermes-hermes-sqlite"] : ["gemini-json"];
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
  if ((parserVersion !== "1" && parserVersion !== "2") || !expectedParsers(run.source).includes(artifact.parser.id)) return { status: "excluded", reason: "unsupported-parser" };
  if (artifact.anonymizationPolicy !== undefined && artifact.anonymizationPolicy !== "none" && options.canonicalTurns === undefined) return { status: "waiting", reason: "metadata-unavailable" };
  try {
    const projection = new VaultMessageProjection(run.source, run.nativeId, { parserVersion, ...(options.canonicalTurns === undefined ? {} : { canonicalTurns: options.canonicalTurns }) });
    const result = await visitStoredTranscriptArtifact({ vaultRoot, artifact,
      ...(options.encryptionKey === undefined ? {} : { encryptionKey: options.encryptionKey }),
      ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
      onRecord: (record) => projection.push(record),
    });
    return result.status === "ready" ? projection.finish(result.integrity) : result;
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
    mediaType: "application/x-ndjson", parser: { id: expectedParsers(run.source)[0]!, version: "1" },
    contentPolicy: "redacted", stored: true, redactionCount: 0,
  }, ...(encryptionKey === undefined ? {} : { encryptionKey }) });
  if (result.status === "ready") return result.messages;
  if (result.status === "waiting") return undefined;
  throw new Error(result.status === "retry" && result.reason === "decryption-failed" ? "encrypted vault content failed authentication" : `vault evidence unavailable: ${result.reason}`);
}
