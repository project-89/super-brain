import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  FoldJournal,
  replayJournal,
} from "../src/index.js";
import { createEntry, counterEntries } from "./fixtures.js";

async function journalPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "fold-storage-replay-"));
  return join(directory, "events.jsonl");
}

describe("Fold replay", () => {
  it("keeps draft inclusion explicit", async () => {
    const path = await journalPath();
    const journal = new FoldJournal(path);
    await journal.append(createEntry("event-001", 1, "canon"));
    await journal.append(createEntry("event-002", 2, "draft"));

    const canon = await replayJournal(path, { include: "canon" });
    const withDrafts = await replayJournal(path, { include: "canon+draft" });
    expect(canon.state.appliedEvents.map(({ id }) => id)).toEqual(["event-001"]);
    expect(withDrafts.state.appliedEvents.map(({ id }) => id)).toEqual([
      "event-001",
      "event-002",
    ]);
  });

  it("passes an explicit event cursor through to inclusive Fold replay", async () => {
    const path = await journalPath();
    const journal = new FoldJournal(path);
    const entries = counterEntries();
    for (const entry of entries) await journal.append(entry);

    const replay = await replayJournal(path, {
      include: "canon",
      cursor: { t: 2, eventId: "event-002" },
    });
    expect(replay.state.appliedEvents.map(({ id }) => id)).toEqual([
      "event-001",
      "event-002",
    ]);
  });
});
