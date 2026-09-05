import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSyntheticMemoryService } from "../src/memory.js";
import { DEFAULT_FIXTURE_DIRECTORY } from "../src/oracle.js";
import { submissionPrompt } from "../src/harness.js";

describe("real synthetic canonical memory retrieval", () => {
  it("retrieves revision zero through the actual API and injects only the returned lesson", async () => {
    const lesson = await readFile(join(DEFAULT_FIXTURE_DIRECTORY, "synthetic-memory.md"), "utf8");
    const service = await createSyntheticMemoryService(lesson);
    try {
      const first = await service.retrieve(), second = await service.retrieve();
      expect(first.source.revision).toBe(0); expect(first.recallId).not.toBe(second.recallId);
      expect(first.content).toBe(lesson); expect(first.approval.kind).toBe("synthetic-human-record");
      const baseline = submissionPrompt("TASK", "[]", "INITIAL", undefined, []);
      const memory = submissionPrompt("TASK", "[]", "INITIAL", first, []);
      expect(baseline).not.toContain(lesson); expect(memory).toContain(lesson); expect(memory).toContain("exact revision 0");
      expect(memory).not.toContain("synthetic-local-evaluation-only"); expect(memory).not.toContain("garden");
    } finally { await service.close(); }
  });
});
