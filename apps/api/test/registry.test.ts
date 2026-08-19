import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  JournalSdkRegistry,
  workspaceJournalFilename,
} from "../src/index.js";
import { access, apiEvent } from "./helpers.js";

describe("workspace SDK registry", () => {
  it("maps arbitrary workspace IDs to opaque journal filenames", () => {
    const filename = workspaceJournalFilename("../../sensitive/workspace");
    expect(filename).toMatch(/^[a-f0-9]{64}\.jsonl$/);
    expect(filename).not.toContain("sensitive");
    expect(() => workspaceJournalFilename(" ")).toThrow(/must not be empty/);
  });

  it("returns one serialized SDK per workspace", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fold-api-registry-"));
    const registry = new JournalSdkRegistry(directory);
    expect(await registry.sdkFor("workspace-1")).toBe(await registry.sdkFor("workspace-1"));
    expect(await registry.sdkFor("workspace-2")).not.toBe(await registry.sdkFor("workspace-1"));
  });

  it("reopens fsynced journal state through a new registry", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fold-api-registry-"));
    const first = await new JournalSdkRegistry(directory).sdkFor("workspace-1");
    await first.append(access(), apiEvent({ id: "event-a", t: 1 }));

    const reopened = await new JournalSdkRegistry(directory).sdkFor("workspace-1");
    expect((await reopened.listEntries(access())).map((entry) => entry.event.id)).toEqual([
      "event-a",
    ]);
  });
});
