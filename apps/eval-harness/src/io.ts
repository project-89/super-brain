import { constants, type Stats } from "node:fs";
import { open } from "node:fs/promises";

/** Bounded regular-file reads; no symlink/FIFO traversal or size-race allocation. */
export async function readEvaluationText(path: string, maxBytes = 16 * 1024 * 1024, boundary?: { expected: Stats; validate: () => Promise<void> }): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (boundary !== undefined) {
      if (before.dev !== boundary.expected.dev || before.ino !== boundary.expected.ino || before.size !== boundary.expected.size || before.ctimeMs !== boundary.expected.ctimeMs) throw new Error("Evaluation artifact was replaced before opening");
      await boundary.validate();
    }
    if (!before.isFile() || before.size > maxBytes) throw new Error("Evaluation artifact exceeds regular-file bounds");
    const bytes = Buffer.alloc(before.size); let offset = 0;
    while (offset < bytes.length) { const read = await file.read(bytes, offset, bytes.length - offset, offset); if (read.bytesRead === 0) break; offset += read.bytesRead; }
    const after = await file.stat();
    if (offset !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("Evaluation artifact changed while reading");
    await boundary?.validate();
    return bytes.toString("utf8");
  } finally { await file.close(); }
}
