import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FoldJournal } from "@_89/fold-storage";
import { describe, expect, it } from "vitest";

import { FoldSdk } from "../src/index.js";
import { access, event } from "./helpers.js";

describe("FoldJournal integration", () => {
  it("opens an absent journal, appends, and reads through a new SDK instance", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fold-sdk-"));
    const path = join(directory, "events.jsonl");
    const sdk = new FoldSdk(new FoldJournal(path));
    await sdk.append(access(), event({ id: "event-a", t: 1 }));

    const reopened = new FoldSdk(new FoldJournal(path));
    expect((await reopened.listEntries(access())).map((entry) => entry.event.id)).toEqual([
      "event-a",
    ]);
  });
});
