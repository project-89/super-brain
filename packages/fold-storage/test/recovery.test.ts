import { appendFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  appendEntry,
  JournalError,
  readJournal,
} from "../src/index.js";
import { createEntry } from "./fixtures.js";

async function journalPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "fold-storage-recovery-"));
  return join(directory, "events.jsonl");
}

async function expectJournalError(
  operation: Promise<unknown>,
  kind: JournalError["kind"],
  line?: number,
): Promise<void> {
  try {
    await operation;
    throw new Error("expected JournalError");
  } catch (error) {
    expect(error).toBeInstanceOf(JournalError);
    expect((error as JournalError).kind).toBe(kind);
    if (line !== undefined) expect((error as JournalError).line).toBe(line);
  }
}

describe("strict reopen and tail recovery", () => {
  it("recovers only invalid JSON in the final unterminated line", async () => {
    const path = await journalPath();
    await appendEntry(path, createEntry("event-001", 1));
    await appendFile(path, '{"formatVersion":1,"recordType":"event"', "utf8");

    await expectJournalError(readJournal(path), "invalid-json", 2);
    const recovered = await readJournal(path, { tailPolicy: "recover-truncated-tail" });
    expect(recovered.entries).toHaveLength(1);
    expect(recovered.diagnostics).toEqual([
      { kind: "truncated-tail-ignored", line: 2, byteLength: 39 },
    ]);
  });

  it("rejects a malformed final line when it is newline-terminated", async () => {
    const path = await journalPath();
    await appendEntry(path, createEntry("event-001", 1));
    await appendFile(path, "{broken}\n", "utf8");
    await expectJournalError(
      readJournal(path, { tailPolicy: "recover-truncated-tail" }),
      "invalid-json",
      2,
    );
  });

  it("rejects a schema-invalid unterminated tail instead of guessing it was torn", async () => {
    const path = await journalPath();
    await writeFile(path, '{"formatVersion":1,"recordType":"event"}', "utf8");
    await expectJournalError(
      readJournal(path, { tailPolicy: "recover-truncated-tail" }),
      "invalid-record",
      1,
    );
  });

  it("rejects interior blank lines", async () => {
    const path = await journalPath();
    await appendEntry(path, createEntry("event-001", 1));
    await appendFile(path, "\n", "utf8");
    await appendEntry(path, createEntry("event-002", 2));
    await expectJournalError(readJournal(path), "blank-line", 2);
  });

  it("enforces a maximum physical line size", async () => {
    const path = await journalPath();
    await appendEntry(path, createEntry("event-001", 1));
    await expectJournalError(readJournal(path, { maxLineBytes: 20 }), "line-too-large", 1);
  });

  it("rejects duplicate and non-monotonic same-time event ids", async () => {
    const duplicatePath = await journalPath();
    await appendEntry(duplicatePath, createEntry("event-a", 1));
    await appendEntry(duplicatePath, createEntry("event-a", 2));
    await expectJournalError(readJournal(duplicatePath), "invalid-record", 2);

    const orderPath = await journalPath();
    await appendEntry(orderPath, createEntry("event-b", 1));
    await appendEntry(orderPath, createEntry("event-a", 1));
    await expectJournalError(readJournal(orderPath), "invalid-record", 2);
  });

  it("refuses to append after an unterminated tail", async () => {
    const path = await journalPath();
    await writeFile(path, "partial", "utf8");
    await expectJournalError(appendEntry(path, createEntry("event-001", 1)), "torn-tail");
  });

  it("can treat a missing journal as empty only when requested", async () => {
    const path = await journalPath();
    await expectJournalError(readJournal(path), "missing-file");
    const empty = await readJournal(path, { missing: "empty" });
    expect(empty).toEqual({ records: [], entries: [], checkpoints: [], diagnostics: [] });
  });
});
