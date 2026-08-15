import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  FoldJournal,
  readJournal,
  rewriteJournalAtomically,
} from "../src/index.js";
import { createEntry } from "./fixtures.js";

async function journalPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "fold-storage-jsonl-"));
  return join(directory, "events.jsonl");
}

describe("JSONL journal", () => {
  it("appends one complete JSON record per line and replays after reopen", async () => {
    const path = await journalPath();
    const journal = new FoldJournal(path);
    await journal.append(createEntry("event-001", 1));
    await journal.append(createEntry("event-002", 2));

    const bytes = await readFile(path, "utf8");
    expect(bytes.endsWith("\n")).toBe(true);
    expect(bytes.trimEnd().split("\n")).toHaveLength(2);

    const reopened = await new FoldJournal(path).replay({ include: "canon" });
    expect(reopened.entries.map(({ event }) => event.id)).toEqual(["event-001", "event-002"]);
    expect([...reopened.state.nodes.values()].filter(({ exists }) => exists)).toHaveLength(2);
  });

  it("serializes concurrent writes through one journal instance", async () => {
    const path = await journalPath();
    const journal = new FoldJournal(path);
    await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        journal.append(createEntry(`event-${String(index).padStart(3, "0")}`, index)),
      ),
    );

    const read = await readJournal(path);
    expect(read.entries).toHaveLength(25);
    expect(read.diagnostics).toEqual([]);
  });

  it("round-trips writer output byte-for-byte through an atomic rewrite", async () => {
    const source = await journalPath();
    const target = await journalPath();
    const journal = new FoldJournal(source);
    await journal.append(createEntry("event-001", 1));
    await journal.append(createEntry("event-002", 2, "draft"));
    await journal.checkpoint({ include: "canon+draft" });

    const read = await readJournal(source);
    await rewriteJournalAtomically(target, read.records);
    expect(await readFile(target)).toEqual(await readFile(source));
  });
});
