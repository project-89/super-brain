import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { HookInbox, HookInboxProcessor } from "../src/index.js";

describe("durable hook inbox", () => {
  it("encrypts queued hook payloads and restores them for processing", async () => {
    const root = await mkdtemp(join(tmpdir(), "super-brain-inbox-"));
    const key = new Uint8Array(32).fill(17);
    const inbox = new HookInbox(root, key);

    await inbox.enqueue("codex", { session_id: "session-a", secret: "private-value" });
    const [queued] = await inbox.list();

    expect(queued?.item).toMatchObject({ source: "codex", payload: { session_id: "session-a" } });
    expect(await readFile(queued!.path, "utf8")).not.toContain("private-value");
  });

  it("redacts secrets when legacy configuration has no inbox encryption key", async () => {
    const root = await mkdtemp(join(tmpdir(), "super-brain-inbox-"));
    const inbox = new HookInbox(root);

    await inbox.enqueue("codex", { session_id: "session-a", detail: "token=secret-value-1234" });
    const [queued] = await inbox.list();

    expect(queued?.item.payload).toEqual({ session_id: "session-a", detail: "token=[REDACTED]" });
  });

  it("processes a bounded batch and leaves later hooks durable", async () => {
    const root = await mkdtemp(join(tmpdir(), "super-brain-inbox-"));
    const inbox = new HookInbox(root);
    await Promise.all(Array.from({ length: 3 }, (_, index) => inbox.enqueue("codex", { session_id: `session-${index}` })));
    const ingest = vi.fn(async () => ({ artifactId: "artifact" }));
    const processor = new HookInboxProcessor(inbox, { ingest }, 2, 0);

    await processor.flush();

    expect(ingest).toHaveBeenCalledTimes(2);
    await expect(inbox.snapshot()).resolves.toMatchObject({ pendingHooks: 1, failedHooks: 0 });
  });

  it("quarantines invalid hooks without blocking later records", async () => {
    const root = await mkdtemp(join(tmpdir(), "super-brain-inbox-"));
    const inbox = new HookInbox(root);
    await inbox.enqueue("codex", { session_id: "invalid" });
    await inbox.enqueue("codex", { session_id: "valid" });
    const ingest = vi.fn(async (_source, payload: unknown) => {
      if ((payload as { session_id?: string }).session_id === "invalid") throw new TypeError("invalid hook");
      return { artifactId: "artifact" };
    });
    const processor = new HookInboxProcessor(inbox, { ingest }, 2, 0);

    await processor.flush();

    expect(ingest).toHaveBeenCalledTimes(2);
    await expect(inbox.snapshot()).resolves.toMatchObject({ pendingHooks: 0, failedHooks: 1 });
  });
});
