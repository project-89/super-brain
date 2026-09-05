import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { encryptVaultLine } from "@_89/super-brain-importer";
import { readBoundedPrivateText, readCompletedCaptureReceipt, readHookVaultArtifact } from "../src/index.js";

it("bounds private evidence reads and rejects symlink substitution", async () => {
  const root = await mkdtemp(join(tmpdir(), "capture-private-read-")); const path = join(root, "record");
  const file = await open(path, "w"); await file.truncate(33 * 1024 * 1024); await file.close();
  await expect(readBoundedPrivateText(path, 32 * 1024 * 1024)).rejects.toThrow("bounded regular file");
  const target = join(root, "target"); await writeFile(target, "private"); await unlink(path); await symlink(target, path);
  await expect(readBoundedPrivateText(path, 100)).rejects.toBeDefined();
});

it("requires authenticated encryption at hook and receipt .enc paths without plaintext fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "capture-private-envelope-")); const id = "a".repeat(64); const key = new Uint8Array(32).fill(7);
  const hooks = join(root, "hooks", "codex", id.slice(0, 2)); await mkdir(hooks, { recursive: true });
  const record = { id, source: "codex", receivedAt: "2026-09-04T00:00:00.000Z", eventTime: 1, payload: {} };
  await writeFile(join(hooks, `${id}.json.enc`), JSON.stringify(record)); await writeFile(join(hooks, `${id}.json`), JSON.stringify(record));
  await expect(readHookVaultArtifact({ vaultRoot: root, source: "codex", artifactId: id, encryptionKey: key })).rejects.toThrow("authenticated envelope");
  await writeFile(join(hooks, `${id}.json.enc`), encryptVaultLine(JSON.stringify(record), key));
  expect(await readHookVaultArtifact({ vaultRoot: root, source: "codex", artifactId: id, encryptionKey: key })).toMatchObject(record);
  const completed = join(root, "receipts", "receiver", "completed"); await mkdir(completed, { recursive: true });
  const receiptId = "receipt"; const path = join(completed, `${createHash("sha256").update(receiptId).digest("hex")}.json.enc`);
  await symlink(join(hooks, `${id}.json.enc`), path);
  await expect(readCompletedCaptureReceipt({ stateRoot: root, receiptId, encryptionKey: key })).rejects.toBeDefined();
  await unlink(path); const file = await open(path, "w"); await file.truncate(17 * 1024 * 1024); await file.close();
  await expect(readCompletedCaptureReceipt({ stateRoot: root, receiptId, encryptionKey: key })).rejects.toThrow("bounded regular file");
});
