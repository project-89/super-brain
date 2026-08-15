import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fold, type ComponentRegistry } from "@_89/fold";
import { describe, expect, it } from "vitest";

import {
  FoldJournal,
  JournalError,
  materializeFoldState,
  readJournal,
} from "../src/index.js";
import { counterEntries, makeEvent } from "./fixtures.js";

async function journalPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "fold-storage-checkpoint-"));
  return join(directory, "events.jsonl");
}

describe("checkpoints", () => {
  it("verifies a prefix checkpoint and preserves full-replay materialized state", async () => {
    const path = await journalPath();
    const journal = new FoldJournal(path);
    const entries = counterEntries();
    await journal.append(entries[0]!);
    await journal.append(entries[1]!);
    const checkpoint = await journal.checkpoint({ include: "canon" });
    await journal.append(entries[2]!);

    expect(checkpoint.eventCount).toBe(2);
    expect(checkpoint.through).toEqual({ t: 2, eventId: "event-002" });
    const reopened = await new FoldJournal(path).replay({ include: "canon" });
    const direct = fold(entries, { include: "canon" });
    expect(reopened.checkpoints).toHaveLength(1);
    expect(materializeFoldState(reopened.state)).toEqual(materializeFoldState(direct));
  });

  it("fails closed when a checkpoint digest is tampered", async () => {
    const path = await journalPath();
    const journal = new FoldJournal(path);
    await journal.append(counterEntries()[0]!);
    await journal.checkpoint({ include: "canon" });

    const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
    const record = JSON.parse(lines[1]!) as {
      checkpoint: { stateDigest: string };
    };
    record.checkpoint.stateDigest = "0".repeat(64);
    lines[1] = JSON.stringify(record);
    await writeFile(path, `${lines.join("\n")}\n`, "utf8");

    await expect(readJournal(path)).rejects.toMatchObject({
      name: "JournalError",
      kind: "checkpoint-mismatch",
      line: 2,
    });
  });

  it("requires the named component registry to verify custom checkpoints", async () => {
    const path = await journalPath();
    const components: ComponentRegistry = {
      "x.test.score": { kind: "clampedNumeric", min: 0, max: 10 },
    };
    const entries = [
      {
        status: "canon" as const,
        event: makeEvent("event-001", 1, [{
          verb: "adjust",
          subject: "subject",
          component: "x.test.score",
          before: 0,
          after: 4,
          amount: 4,
        }]),
      },
    ];
    const journal = new FoldJournal(path);
    await journal.append(entries[0]!);
    await journal.checkpoint({ include: "canon", components, componentSet: "test-v1" });

    await expect(readJournal(path)).rejects.toMatchObject({
      kind: "checkpoint-components-unavailable",
    });
    const read = await readJournal(path, {
      checkpointComponents: { "test-v1": components },
    });
    expect(read.checkpoints[0]?.componentSet).toBe("test-v1");
  });
});
