import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { encryptVaultLine } from "@_89/super-brain-importer";
import { describe, expect, it } from "vitest";

import { readTranscriptArtifactPage } from "../src/transcript-vault.js";

describe("transcript vault paging", () => {
  it("decrypts complete records and resumes with an opaque cursor", async () => {
    const root = await mkdtemp(join(tmpdir(), "super-brain-transcript-vault-"));
    const sha256 = "a".repeat(64);
    const directory = join(root, "codex", "aa");
    const key = new Uint8Array(32).fill(7);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, `${sha256}.jsonl.enc`),
      [0, 1, 2].map((index) => encryptVaultLine(JSON.stringify({ index, content: `record ${index}` }), key)).join("\n") + "\n",
    );

    const first = await readTranscriptArtifactPage({
      vaultRoot: root,
      encryptionKey: key,
      source: "codex",
      sha256,
      limit: 2,
      rawCursor: null,
    });
    expect(first).toMatchObject({
      records: [
        { ordinal: 0, value: { index: 0, content: "record 0" } },
        { ordinal: 1, value: { index: 1, content: "record 1" } },
      ],
      total: 3,
    });
    expect(first.nextCursor).toBeTypeOf("string");

    const second = await readTranscriptArtifactPage({
      vaultRoot: root,
      encryptionKey: key,
      source: "codex",
      sha256,
      limit: 2,
      rawCursor: first.nextCursor!,
    });
    expect(second).toEqual({ records: [{ ordinal: 2, value: { index: 2, content: "record 2" } }], total: 3 });
  });
});
