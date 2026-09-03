import { createReadStream } from "node:fs";
import { chmod, link, mkdir, open, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

import { transcriptImportBundleSchema } from "@_89/fold-transcript";

import { fileMetadata, sha256File } from "./files.js";
import { isRecord } from "./json.js";
import type { ParsedTranscript } from "./types.js";
import { decryptedVaultSha256, encryptVaultLine } from "./encryption.js";

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

export function redactJsonValue(value: unknown): { readonly value: unknown; readonly count: number } {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) {
    let count = 0;
    const values = value.map((item) => {
      const result = redactJsonValue(item);
      count += result.count;
      return result.value;
    });
    return { value: values, count };
  }
  if (isRecord(value)) {
    let count = 0;
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === "encrypted_content") continue;
      const redacted = redactJsonValue(item);
      count += redacted.count;
      result[key] = redacted.value;
    }
    return { value: result, count };
  }
  return { value, count: 0 };
}

function withoutPrivateReasoning(record: Record<string, unknown>): Record<string, unknown> {
  if (record.type === "assistant") {
    const message = isRecord(record.message) ? record.message : undefined;
    if (message !== undefined && Array.isArray(message.content)) {
      return {
        ...record,
        message: {
          ...message,
          content: message.content.filter((block) => !isRecord(block) || block.type !== "thinking"),
        },
      };
    }
  }
  if (record.type === "response_item" && isRecord(record.payload) && record.payload.type === "reasoning") {
    return { ...record, payload: { type: "reasoning", excluded: true } };
  }
  if (
    record.type === "event_msg" &&
    isRecord(record.payload) &&
    typeof record.payload.type === "string" &&
    record.payload.type.includes("reasoning")
  ) {
    return { ...record, payload: { type: record.payload.type, excluded: true } };
  }
  return record;
}

export async function storeRedactedArtifact(
  transcript: ParsedTranscript,
  vaultRoot: string,
  options: { readonly reasoningPolicy?: "exclude" | "include"; readonly encryptionKey?: Uint8Array } = {},
): Promise<ParsedTranscript> {
  const { artifact } = transcript.bundle;
  const beforeHash = await fileMetadata(transcript.sourcePath);
  const sourceSha256 = await sha256File(transcript.sourcePath);
  const afterHash = await fileMetadata(transcript.sourcePath);
  if (
    sourceSha256 !== artifact.sha256 ||
    beforeHash.byteLength !== artifact.byteLength ||
    beforeHash.modifiedAt !== artifact.modifiedAt ||
    afterHash.byteLength !== artifact.byteLength ||
    afterHash.modifiedAt !== artifact.modifiedAt
  ) {
    throw new Error("Transcript source changed after it was scanned; retry the import");
  }
  await mkdir(vaultRoot, { recursive: true, mode: 0o700 });
  await chmod(vaultRoot, 0o700);
  const target = join(
    vaultRoot,
    artifact.source,
    artifact.sha256.slice(0, 2),
    `${artifact.sha256}.jsonl${options.encryptionKey === undefined ? "" : ".enc"}`,
  );
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.tmp`;
  const output = await open(temporary, "wx", 0o600);
  let redactionCount = 0;
  try {
    const lines = createInterface({ input: createReadStream(transcript.sourcePath), crlfDelay: Infinity });
    for await (const line of lines) {
      if (line.trim().length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        continue;
      }
      const safe = isRecord(parsed) && options.reasoningPolicy !== "include"
        ? withoutPrivateReasoning(parsed)
        : parsed;
      const redacted = redactJsonValue(safe);
      redactionCount += redacted.count;
      const serialized = JSON.stringify(redacted.value);
      await output.writeFile(`${options.encryptionKey === undefined ? serialized : encryptVaultLine(serialized, options.encryptionKey)}\n`, "utf8");
    }
    const storedMetadata = await fileMetadata(transcript.sourcePath);
    if (storedMetadata.byteLength !== artifact.byteLength || storedMetadata.modifiedAt !== artifact.modifiedAt) {
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
      stored: true,
      redactionCount,
    },
  });
  return { sourcePath: transcript.sourcePath, bundle };
}
