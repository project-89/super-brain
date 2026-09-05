import { describe, expect, it } from "vitest";

import { makeMemoryFeedbackEvent, memoryFeedbackRecordsFromEvent } from "../src/index.js";
import { context, memory, stamp } from "./helpers.js";

describe("memory feedback", () => {
  it("records an authored, scoped signal with task context", () => {
    const event = makeMemoryFeedbackEvent(
      context(),
      stamp("feedback-event", 200),
      memory(),
      { version: 2, memoryRevision: 0, recallId: "recall-a", signal: "judged", judgment: "helpful", taskId: "task-a" },
    );
    expect(event).toMatchObject({
      kind: "memory.feedback-recorded",
      capture: { scope: { workspace: "workspace-1", creator: "user-a" } },
    });
    expect(memoryFeedbackRecordsFromEvent(event)).toEqual([expect.objectContaining({
      memoryId: memory().id,
      signal: "judged",
      memoryRevision: 0,
      judgment: "helpful",
      taskId: "task-a",
      actorId: "user-a",
    })]);
  });

  it("rejects mismatched memory scope and empty details", () => {
    expect(() => makeMemoryFeedbackEvent(context(), stamp("feedback-event", 200), memory({ workspaceId: "other" }), { version: 2, memoryRevision: 0, recallId: "recall-a", signal: "offered" }))
      .toThrow(/unavailable/);
    expect(() => makeMemoryFeedbackEvent(context(), stamp("feedback-event", 200), memory(), { version: 2, memoryRevision: 0, recallId: "recall-a", signal: "judged", judgment: "unhelpful", detail: " " }))
      .toThrow(/detail/);
  });
});
