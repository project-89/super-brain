import { createHash, createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, link, mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";

const ENVELOPE_MARKER = "$superBrainEncrypted";

interface EncryptedEnvelope {
  readonly $superBrainEncrypted: 1;
  readonly algorithm: "aes-256-gcm";
  readonly iv: string;
  readonly tag: string;
  readonly ciphertext: string;
}

export function parseVaultKey(value: string): Uint8Array {
  const normalized = value.trim();
  const bytes = /^[0-9a-f]{64}$/i.test(normalized)
    ? Buffer.from(normalized, "hex")
    : Buffer.from(normalized, "base64");
  if (bytes.byteLength !== 32) throw new TypeError("vault key must decode to exactly 32 bytes");
  return bytes;
}

export async function readVaultKey(pathInput: string): Promise<Uint8Array> {
  const path = resolve(pathInput);
  const metadata = await stat(path);
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error(`vault key must not be accessible by group or others: ${path}`);
  }
  return parseVaultKey(await readFile(path, "utf8"));
}

export async function ensureVaultKey(pathInput: string): Promise<{ readonly path: string; readonly key: Uint8Array }> {
  const path = resolve(pathInput);
  const created = await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  if (created !== undefined) {
    const boundary = dirname(resolve(created));
    let current = dirname(path);
    while (true) {
      const directory = await open(current, "r");
      try { await directory.sync(); } finally { await directory.close(); }
      if (current === boundary || current === dirname(current)) break;
      current = dirname(current);
    }
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(`${randomBytes(32).toString("base64")}\n`, "utf8");
    await file.sync();
    await file.close();
    try {
      await link(temporary, path);
      const directory = await open(dirname(path), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } finally {
    await file.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
  return { path, key: await readVaultKey(path) };
}

export function encryptVaultLine(plaintext: string, key: Uint8Array): string {
  if (key.byteLength !== 32) throw new TypeError("vault key must contain exactly 32 bytes");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const envelope: EncryptedEnvelope = {
    [ENVELOPE_MARKER]: 1,
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
  return JSON.stringify(envelope);
}

export function decryptVaultLine(line: string, key?: Uint8Array): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    return line;
  }
  if (
    typeof parsed !== "object" || parsed === null || Array.isArray(parsed) ||
    !(ENVELOPE_MARKER in parsed)
  ) return line;
  if (key === undefined) throw new Error("encrypted vault content requires a vault key");
  const envelope = parsed as Partial<EncryptedEnvelope>;
  if (
    envelope.$superBrainEncrypted !== 1 || envelope.algorithm !== "aes-256-gcm" ||
    typeof envelope.iv !== "string" || typeof envelope.tag !== "string" || typeof envelope.ciphertext !== "string"
  ) throw new Error("encrypted vault envelope is invalid");
  const iv = Buffer.from(envelope.iv, "base64");
  const tag = Buffer.from(envelope.tag, "base64");
  if (iv.byteLength !== 12 || tag.byteLength !== 16 || key.byteLength !== 32) {
    throw new Error("encrypted vault envelope has invalid key material");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("encrypted vault content failed authentication");
  }
}

export async function decryptedVaultSha256(path: string, key: Uint8Array): Promise<string> {
  const digest = createHash("sha256");
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim().length === 0) continue;
    digest.update(decryptVaultLine(line, key));
    digest.update("\n");
  }
  return digest.digest("hex");
}
