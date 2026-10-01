import { createReadStream } from "node:fs";
import { chmod, link, mkdir, open, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

import { transcriptImportBundleSchema } from "@_89/fold-transcript";

import { fileMetadata, sha256File, sha256Text } from "./files.js";
import { isRecord } from "./json.js";
import { RecordAnonymizer } from "./privacy.js";
import type { ParsedTranscript } from "./types.js";
import { decryptedVaultSha256, encryptVaultLine } from "./encryption.js";
import { archiveRecords, readArchiveDocument } from "./native-archives.js";

const SECRET_PATTERNS: readonly { readonly pattern: RegExp; readonly preservePrefix?: boolean }[] = [
  { pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { pattern: /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}\b/gi },
  { pattern: /((?:api[_-]?key|token|password|secret)\s*[:=]\s*["']?)[^\s"',}]{8,}/gi, preservePrefix: true },
  { pattern: /-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+ PRIVATE KEY-----/g },
];

function redactString(value: string): { readonly value: string; readonly count: number } {
  let redacted = value;
  let count = 0;
  for (const { pattern, preservePrefix } of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, (...args: unknown[]) => {
      count += 1;
      const prefix = preservePrefix && typeof args[1] === "string" ? args[1] : "";
      return `${prefix}[REDACTED]`;
    });
  }
  return { value: redacted, count };
}

export function redactJsonValue(
  value: unknown,
  options: { readonly retainEncryptedContent?: boolean } = {},
): { readonly value: unknown; readonly count: number } {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) {
    let count = 0;
    const values = value.map((item) => {
      const result = redactJsonValue(item, options);
      count += result.count;
      return result.value;
    });
    return { value: values, count };
  }
  if (isRecord(value)) {
    let count = 0;
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === "encrypted_content") {
        if (options.retainEncryptedContent === true) result[key] = item;
        continue;
      }
      const redacted = redactJsonValue(item, options);
      count += redacted.count;
      result[key] = redacted.value;
    }
    return { value: result, count };
  }
  return { value, count: 0 };
}

function filterProviderReasoning(record: Record<string, unknown>, include: boolean, retainOpaque: boolean): Record<string, unknown> {
  // Only inspect provider envelopes, never recurse into user text, tool arguments or results.
  const without = (value: Record<string, unknown>, keys: readonly string[]) => Object.fromEntries(
    Object.entries(value).filter(([key]) => !keys.includes(key)),
  );
  const opaqueKeys = ["encrypted_content", "thoughtSignature", "thought_signature", "signature"];
  const opaque = (value: Record<string, unknown>) => retainOpaque ? value : without(value, opaqueKeys);
  const parts = (value: unknown): unknown => !Array.isArray(value) ? value : value.flatMap((part) => {
    if (!isRecord(part)) return [part];
    const reasoning = part.thought === true || ["thinking", "redacted_thinking", "reasoning"].includes(String(part.type));
    if (reasoning && !include) return [];
    if (part.type === "redacted_thinking" && !retainOpaque) return [];
    return [opaque(part)];
  });
  if (record.type === "response_item" && isRecord(record.payload) && record.payload.type === "reasoning") {
    return { ...record, payload: include ? opaque(record.payload) : { type: "reasoning", excluded: true } };
  }
  if (!include && record.type === "event_msg" && isRecord(record.payload)
    && typeof record.payload.type === "string" && record.payload.type.includes("reasoning")) {
    return { ...record, payload: { type: record.payload.type, excluded: true } };
  }
  if (record.type === "assistant" && isRecord(record.message)) {
    return { ...record, message: { ...record.message, content: parts(record.message.content) } };
  }
  if (record.type !== "gemini" && record.role !== "assistant") return record;
  let result = include ? { ...record } : without(record, ["reasoning", "reasoning_content", "reasoning_details", "codex_reasoning_items", "thoughts"]);
  result = opaque(result);
  if (typeof result.content === "string" && record.role === "assistant" && !include) {
    result.content = result.content.replace(/<(?:think|REASONING_SCRATCHPAD)>[\s\S]*?(?:<\/(?:think|REASONING_SCRATCHPAD)>|$)/gi, "");
  } else if (Array.isArray(result.content)) result.content = parts(result.content);
  if (Array.isArray(result.api_content)) result.api_content = parts(result.api_content);
  for (const key of ["codex_reasoning_items", "reasoning_details"]) {
    if (Array.isArray(result[key])) result[key] = result[key].flatMap((item) =>
      isRecord(item) && item.type === "reasoning.encrypted" && !retainOpaque ? [] : [isRecord(item) ? opaque(item) : item]);
  }
  if (record.type === "gemini" && Array.isArray(result.toolCalls)) {
    result.toolCalls = result.toolCalls.map((call) => !isRecord(call) ? call : {
      ...opaque(call), ...(Array.isArray(call.result) ? { result: parts(call.result) } : {}),
    });
  }
  return result;
}

export function redactTranscriptRecord(
  record: unknown,
  options: {
    readonly reasoningPolicy?: "exclude" | "include";
    readonly retainEncryptedReasoning?: boolean;
    readonly anonymizer?: RecordAnonymizer;
  } = {},
): { readonly value: unknown; readonly count: number } {
  const safe = isRecord(record)
    ? filterProviderReasoning(record, options.reasoningPolicy === "include", options.reasoningPolicy === "include" && options.retainEncryptedReasoning === true)
    : record;
  const anonymized = options.anonymizer?.value(safe) ?? safe;
  return redactJsonValue(anonymized, {
    retainEncryptedContent: true,
  });
}

export async function storeRedactedArtifact(
  transcript: ParsedTranscript,
  vaultRoot: string,
  options: {
    readonly reasoningPolicy?: "exclude" | "include";
    readonly retainEncryptedReasoning?: boolean;
    readonly encryptionKey?: Uint8Array;
    readonly anonymizer?: RecordAnonymizer;
  } = {},
): Promise<ParsedTranscript> {
  const { artifact } = transcript.bundle;
  const nativeDocument = transcript.archiveInput === undefined ? undefined : await readArchiveDocument(transcript);
  const sqliteSnapshot = transcript.archiveInput?.kind === "hermes-sqlite";
  const beforeHash = await fileMetadata(transcript.sourcePath);
  const sourceSha256 = sqliteSnapshot ? sha256Text(JSON.stringify(nativeDocument)) : await sha256File(transcript.sourcePath);
  const afterHash = await fileMetadata(transcript.sourcePath);
  if (
    sourceSha256 !== artifact.sha256 ||
    (!sqliteSnapshot && (beforeHash.byteLength !== artifact.byteLength ||
    beforeHash.modifiedAt !== artifact.modifiedAt ||
    afterHash.byteLength !== artifact.byteLength ||
    afterHash.modifiedAt !== artifact.modifiedAt))
  ) {
    throw new Error("Transcript source changed after it was scanned; retry the import");
  }
  await mkdir(vaultRoot, { recursive: true, mode: 0o700 });
  await chmod(vaultRoot, 0o700);
  const privateArtifactHash = options.anonymizer?.digest("artifact-content", artifact.sha256) ?? artifact.sha256;
  const target = join(
    vaultRoot,
    artifact.source,
    privateArtifactHash.slice(0, 2),
    `${privateArtifactHash}.jsonl${options.encryptionKey === undefined ? "" : ".enc"}`,
  );
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.tmp`;
  const output = await open(temporary, "wx", 0o600);
  let redactionCount = 0;
  try {
    const lines = nativeDocument === undefined
      ? createInterface({ input: createReadStream(transcript.sourcePath), crlfDelay: Infinity })
      : archiveRecords(nativeDocument).map((record) => JSON.stringify(record));
    for await (const line of lines) {
      if (line.trim().length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        continue;
      }
      const redacted = redactTranscriptRecord(parsed, options);
      redactionCount += redacted.count;
      const serialized = JSON.stringify(redacted.value);
      await output.writeFile(`${options.encryptionKey === undefined ? serialized : encryptVaultLine(serialized, options.encryptionKey)}\n`, "utf8");
    }
    const storedMetadata = await fileMetadata(transcript.sourcePath);
    if (!sqliteSnapshot && (storedMetadata.byteLength !== artifact.byteLength || storedMetadata.modifiedAt !== artifact.modifiedAt)) {
      throw new Error("Transcript source changed while it was being stored; retry the import");
    }
    await output.sync();
    await output.close();
    await link(temporary, target).then(
      () => unlink(temporary),
      async (error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const [existingHash, pendingHash] = options.encryptionKey === undefined
          ? await Promise.all([sha256File(target), sha256File(temporary)])
          : await Promise.all([
              decryptedVaultSha256(target, options.encryptionKey),
              decryptedVaultSha256(temporary, options.encryptionKey),
            ]);
        if (existingHash !== pendingHash) {
          throw new Error(
            "Transcript artifact already exists with different redaction or reasoning content; use a separate vault",
          );
        }
        await unlink(temporary);
      },
    );
    await chmod(target, 0o600);
  } catch (error) {
    await output.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  const bundle = transcriptImportBundleSchema.parse({
    ...transcript.bundle,
    artifact: {
      ...artifact,
      contentPolicy: "redacted",
      reasoningPolicy: options.reasoningPolicy === "include" ? "included" : "excluded",
      encryptedReasoningPolicy:
        options.reasoningPolicy === "include" && options.retainEncryptedReasoning === true ? "retained" : "excluded",
      anonymizationPolicy: options.anonymizer?.policy ?? "none",
      stored: true,
      redactionCount,
    },
  });
  return {
    sourcePath: transcript.sourcePath,
    bundle: options.anonymizer?.transcriptBundle(bundle) ?? bundle,
  };
}
