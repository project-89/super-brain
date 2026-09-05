import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import { createInterface } from "node:readline";
import type { TranscriptArtifact } from "@_89/fold-transcript";
import { decryptVaultLine } from "./encryption.js";

export type StoredTranscriptRead =
  | { readonly status: "ready"; readonly records: number; readonly storedSha256: string; readonly integrity: "verified" | "legacy-unverified" }
  | { readonly status: "waiting"; readonly reason: "artifact-unavailable" | "key-unavailable" }
  | { readonly status: "retry"; readonly reason: "decryption-failed" | "io-error" | "artifact-changing"; readonly line?: number }
  | { readonly status: "excluded"; readonly reason: "artifact-identity-mismatch" | "artifact-integrity-mismatch" | "malformed-record" | "nonregular-artifact" | "artifact-too-large"; readonly line?: number };

/** Reads only the published local artifact; source files and canonical metadata are never changed. */
export async function visitStoredTranscriptArtifact(options: {
  readonly vaultRoot: string;
  readonly artifact: TranscriptArtifact;
  readonly encryptionKey?: Uint8Array;
  readonly maxBytes?: number;
  /** Zero-based ordinal counts nonempty stored records, independently of parser turn allocation. */
  readonly onRecord: (record: Record<string, unknown>, ordinal: number) => void;
}): Promise<StoredTranscriptRead> {
  const { artifact, vaultRoot } = options;
  if (!/^[a-f0-9]{64}$/.test(artifact.sha256)) return { status: "excluded", reason: "artifact-identity-mismatch" };
  const base = join(vaultRoot, artifact.source, artifact.sha256.slice(0, 2), `${artifact.sha256}.jsonl`);
  let path: string | undefined;
  let before: Stats | undefined;
  try {
    for (const candidate of [`${base}.enc`, base]) {
      try { before = await lstat(candidate); path = candidate; break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    if (path === undefined || before === undefined) return { status: "waiting", reason: "artifact-unavailable" };
    if (!before.isFile()) return { status: "excluded", reason: "nonregular-artifact" };
    const resolved = relative(await realpath(vaultRoot), await realpath(path));
    if (resolved === ".." || resolved.startsWith("../")) return { status: "excluded", reason: "artifact-identity-mismatch" };
    if (before.size > (options.maxBytes ?? 128 * 1024 * 1024)) return { status: "excluded", reason: "artifact-too-large" };
    if (path.endsWith(".enc") && options.encryptionKey === undefined) return { status: "waiting", reason: "key-unavailable" };
  } catch { return { status: "retry", reason: "io-error" }; }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => undefined);
  if (handle === undefined) return { status: "retry", reason: "io-error" };
  const opened = await handle.stat();
  if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size || opened.mtimeMs !== before.mtimeMs) {
    await handle.close(); return { status: "retry", reason: "artifact-changing" };
  }
  const stream = handle.createReadStream({ autoClose: false, end: Math.max(0, before.size - 1) });
  const digest = createHash("sha256");
  stream.on("data", (chunk) => digest.update(chunk));
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let records = 0, lineNumber = 0;
  let visitorError: unknown;
  try {
    for await (const line of lines) {
      lineNumber++;
      if (!line.trim()) continue;
      let decoded: string;
      try {
        if (path.endsWith(".enc") && JSON.parse(line)?.$superBrainEncrypted !== 1) return { status: "excluded", reason: "malformed-record", line: lineNumber };
        decoded = decryptVaultLine(line, options.encryptionKey);
      }
      catch { return { status: "retry", reason: "decryption-failed", line: lineNumber }; }
      let record: unknown;
      try { record = JSON.parse(decoded); } catch { return { status: "excluded", reason: "malformed-record", line: lineNumber }; }
      if (record === null || typeof record !== "object" || Array.isArray(record)) return { status: "excluded", reason: "malformed-record", line: lineNumber };
      try { options.onRecord(record as Record<string, unknown>, records++); }
      catch (error) { visitorError = error; throw error; }
    }
    const after = await lstat(path);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino || before.dev !== after.dev) return { status: "retry", reason: "artifact-changing" };
    const storedSha256 = digest.digest("hex");
    if (artifact.storedSha256 !== undefined && storedSha256 !== artifact.storedSha256) return { status: "excluded", reason: "artifact-integrity-mismatch" };
    return { status: "ready", records, storedSha256, integrity: artifact.storedSha256 === undefined ? "legacy-unverified" : "verified" };
  } catch (error) {
    if (visitorError !== undefined && error === visitorError) throw error;
    return { status: "retry", reason: "io-error", line: lineNumber };
  } finally { lines.close(); stream.destroy(); await handle.close(); }
}
