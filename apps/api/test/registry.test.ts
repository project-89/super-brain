import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  JournalSdkRegistry,
  DataDirectoryLockedError,
  workspaceJournalFilename,
} from "../src/index.js";
import { access, apiEvent } from "./helpers.js";

describe("workspace SDK registry", () => {
  const local = (workspaceId: string) => ({ organizationId: "local", workspaceId });
  it("maps arbitrary workspace IDs to opaque journal filenames", () => {
    const filename = workspaceJournalFilename("../../sensitive/workspace");
    expect(filename).toMatch(/^[a-f0-9]{64}\.jsonl$/);
    expect(filename).not.toContain("sensitive");
    expect(() => workspaceJournalFilename(" ")).toThrow(/must not be empty/);
  });

  it("returns one serialized SDK per workspace", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fold-api-registry-"));
    const registry = new JournalSdkRegistry(directory);
    expect(await registry.sdkFor(local("workspace-1"))).toBe(await registry.sdkFor(local("workspace-1")));
    expect(await registry.sdkFor(local("workspace-2"))).not.toBe(await registry.sdkFor(local("workspace-1")));
    expect(await registry.sdkFor({ organizationId: "other", workspaceId: "workspace-1" }))
      .not.toBe(await registry.sdkFor(local("workspace-1")));
    await registry.close();
  });

  it("reopens fsynced journal state through a new registry", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fold-api-registry-"));
    const firstRegistry = new JournalSdkRegistry(directory);
    const first = await firstRegistry.sdkFor(local("workspace-1"));
    await first.append(access(), apiEvent({ id: "event-a", t: 1 }));
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(directory, workspaceJournalFilename("workspace-1")))).mode & 0o777)
      .toBe(0o600);
    await firstRegistry.close();

    const reopenedRegistry = new JournalSdkRegistry(directory);
    const reopened = await reopenedRegistry.sdkFor(local("workspace-1"));
    expect((await reopened.listEntries(access())).map((entry) => entry.event.id)).toEqual([
      "event-a",
    ]);
    await reopenedRegistry.close();
  });

  it("allows only one process-level writer lease per data directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fold-api-registry-"));
    const first = new JournalSdkRegistry(directory);
    await first.sdkFor(local("workspace-1"));
    const second = new JournalSdkRegistry(directory);
    await expect(second.sdkFor(local("workspace-1"))).rejects.toBeInstanceOf(DataDirectoryLockedError);
    await second.close();
    await first.close();

    const successor = new JournalSdkRegistry(directory);
    await expect(successor.sdkFor(local("workspace-1"))).resolves.toBeDefined();
    await successor.close();
  });

  it("recovers a writer lease whose process no longer exists", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fold-api-registry-"));
    await writeFile(
      join(directory, ".fold-writer.lock"),
      JSON.stringify({ pid: 2_147_483_647, token: "stale", acquiredAt: "2026-08-01T00:00:00.000Z" }),
      "utf8",
    );
    const first = new JournalSdkRegistry(directory);
    const second = new JournalSdkRegistry(directory);
    const attempts = await Promise.allSettled([
      first.sdkFor(local("workspace-1")),
      second.sdkFor(local("workspace-1")),
    ]);
    expect(attempts.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter(({ status }) => status === "rejected")).toHaveLength(1);
    const rejection = attempts.find(({ status }) => status === "rejected");
    expect(rejection).toMatchObject({ reason: expect.any(DataDirectoryLockedError) });
    await first.close();
    await second.close();
  });
});
