import { mkdtemp, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readExposedReasoningDelta } from "../src/index.js";

describe("incremental exposed reasoning", () => {
  it("reads only complete new Codex reasoning summaries", async () => {
    const root = await mkdtemp(join(tmpdir(), "super-brain-reasoning-"));
    const path = join(root, "session.jsonl");
    const first = JSON.stringify({
      type: "response_item",
      payload: { type: "reasoning", id: "reason-a", summary: [{ type: "summary_text", text: "Inspect the cache" }], encrypted_content: "opaque" },
    });
    await writeFile(path, `${first}\n{\"type\":`, "utf8");
    const initial = await readExposedReasoningDelta(path, "codex");
    expect(initial.items.map(({ text }) => text)).toEqual(["Inspect the cache"]);
    expect(initial.records).toHaveLength(1);
    expect(initial.startCursor).toBe(0);

    await appendFile(path, `\"ignored\"}\n${JSON.stringify({ type: "event_msg", payload: { type: "agent_reasoning", text: "Verify the fix" } })}\n`, "utf8");
    const next = await readExposedReasoningDelta(path, "codex", initial.cursor);
    expect(next.items.map(({ text }) => text)).toEqual(["Verify the fix"]);
    expect(next.records).toHaveLength(2);
    expect(next.cursor).toBeGreaterThan(initial.cursor);
  });

  it("reads Claude thinking blocks when the source exposes them", async () => {
    const root = await mkdtemp(join(tmpdir(), "super-brain-reasoning-claude-"));
    const path = join(root, "session.jsonl");
    await writeFile(path, `${JSON.stringify({
      type: "assistant",
      uuid: "message-a",
      message: { content: [{ type: "thinking", thinking: "Compare both implementations" }] },
    })}\n`, "utf8");
    const result = await readExposedReasoningDelta(path, "claude-code");
    expect(result.items.map(({ text }) => text)).toEqual(["Compare both implementations"]);
  });

  it("leaves a complete record after the byte window for a later checkpoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "super-brain-reasoning-window-"));
    const path = join(root, "session.jsonl");
    const first = `${JSON.stringify({ type: "message", payload: { text: "first" } })}\n`;
    const second = `${JSON.stringify({ type: "message", payload: { text: "second" } })}\n`;
    await writeFile(path, `${first}${second}`, "utf8");

    const initial = await readExposedReasoningDelta(path, "codex", 0, { maxBytes: first.length + 5 });
    expect(initial.records).toHaveLength(1);
    expect(initial.cursor).toBe(Buffer.byteLength(first));
    const next = await readExposedReasoningDelta(path, "codex", initial.cursor, { maxBytes: 1024 });
    expect(next.records).toHaveLength(1);
    expect(next.cursor).toBe(Buffer.byteLength(first + second));
  });
});
