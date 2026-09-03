import { describe, expect, it } from "vitest";

import { makeMemoryFeedbackEvent, memoryFeedbackRecordsFromEvent } from "../src/index.js";
import { context, memory, stamp } from "./helpers.js";

describe("memory feedback", () => {
  it("records an authored, scoped signal with task context", () => {
    const event = makeMemoryFeedbackEvent(
      context(),
      stamp("feedback-event", 200),
      memory(),
      { signal: "helpful", query: "Which database is canonical?", taskId: "task-a" },
    );
    expect(event).toMatchObject({
      kind: "memory.feedback-recorded",
      capture: { scope: { workspace: "workspace-1", creator: "user-a" } },
    });
    expect(memoryFeedbackRecordsFromEvent(event)).toEqual([expect.objectContaining({
      memoryId: memory().id,
      signal: "helpful",
      query: "Which database is canonical?",
      taskId: "task-a",
      actorId: "user-a",
    })]);
  });

  it("rejects mismatched memory scope and empty details", () => {
    expect(() => makeMemoryFeedbackEvent(context(), stamp("feedback-event", 200), memory({ workspaceId: "other" }), { signal: "recalled" }))
      .toThrow(/workspace/);
    expect(() => makeMemoryFeedbackEvent(context(), stamp("feedback-event", 200), memory(), { signal: "unhelpful", detail: " " }))
      .toThrow(/detail/);
  });
});
