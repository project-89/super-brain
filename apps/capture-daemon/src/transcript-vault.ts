import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { decryptVaultLine } from "@_89/super-brain-importer";

export type TranscriptVaultSource = "claude-code" | "codex";

interface VaultCursor {
  readonly sha256: string;
  readonly line: number;
}

function cursor(value: string | null, sha256: string): VaultCursor | undefined {
  if (value === null) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<VaultCursor>;
    if (parsed.sha256 !== sha256 || !Number.isInteger(parsed.line) || (parsed.line ?? -1) < 0) throw new Error();
    return parsed as VaultCursor;
  } catch {
    throw new TypeError("artifact cursor is invalid");
  }
}

function encodedCursor(value: VaultCursor): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

async function artifactPath(vaultRoot: string, source: TranscriptVaultSource, sha256: string): Promise<string> {
  for (const suffix of [".jsonl.enc", ".jsonl"]) {
    const candidate = join(vaultRoot, source, sha256.slice(0, 2), `${sha256}${suffix}`);
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next supported vault representation.
    }
  }
  throw new Error("transcript artifact is unavailable in the local vault");
}

export async function readTranscriptArtifactPage(options: {
  readonly vaultRoot: string;
  readonly encryptionKey?: Uint8Array;
  readonly source: TranscriptVaultSource;
  readonly sha256: string;
  readonly limit: number;
  readonly rawCursor: string | null;
}): Promise<{
  readonly records: readonly { readonly ordinal: number; readonly value: unknown }[];
  readonly total: number;
  readonly nextCursor?: string;
}> {
  if (!/^[a-f0-9]{64}$/i.test(options.sha256)) throw new TypeError("artifact sha256 is invalid");
  const start = cursor(options.rawCursor, options.sha256)?.line ?? 0;
  const path = await artifactPath(options.vaultRoot, options.source, options.sha256);
  const records: { readonly ordinal: number; readonly value: unknown }[] = [];
  let total = 0;
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim().length === 0) continue;
    const ordinal = total++;
    if (ordinal < start || records.length >= options.limit) continue;
    records.push({ ordinal, value: JSON.parse(decryptVaultLine(line, options.encryptionKey)) as unknown });
  }
  const nextLine = start + records.length;
  return {
    records,
    total,
    ...(nextLine < total ? { nextCursor: encodedCursor({ sha256: options.sha256, line: nextLine }) } : {}),
  };
}
