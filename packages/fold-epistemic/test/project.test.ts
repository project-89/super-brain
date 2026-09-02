import { parseEvent, type FoldEvent } from "@_89/fold";
import { describe, expect, it } from "vitest";

import {
  makeMemoryForgottenEvent,
  makeMemoryRevisedEvent,
  rebuildMemories,
} from "../src/index.js";
import {
  MEMORY_A,
  MEMORY_B,
  context,
  recordEvent,
  recordedMemory,
  stamp,
} from "./helpers.js";

function forgeActor(event: FoldEvent, actorId: string): FoldEvent {
  return parseEvent({
    ...event,
    participants: [actorId],
    capture: {
      ...event.capture,
      scope: { ...event.capture.scope, creator: actorId },
      identity: { ...event.capture.identity, principal: actorId },
    },
    changes: event.changes.map((change) =>
      change.verb === "create" ? { ...change, after: { ...change.after, actorId } } : change,
    ),
  });
}

describe("memory projection", () => {
  it("rebuilds revisions in canonical event order", () => {
    const eventContext = context();
    const recorded = recordEvent({ eventId: "event-a", t: 100, id: MEMORY_A });
    const original = recordedMemory(recorded);
    const first = makeMemoryRevisedEvent(
      eventContext,
      stamp("event-b", 110),
      original,
      { summary: "First", tags: ["one"] },
    );
    const onceRevised = { ...original, summary: "First", tags: ["one"], updatedAt: 110, revision: 1 };
    const second = makeMemoryRevisedEvent(
      eventContext,
      stamp("event-c", 120),
      onceRevised,
      { content: { answer: 42 } },
    );

    const projected = rebuildMemories([second, recorded, first]);
    expect(projected.memories.get(MEMORY_A)).toMatchObject({
      summary: "First",
      content: { answer: 42 },
      tags: ["one"],
      updatedAt: 120,
      revision: 2,
    });
  });

  it("removes forgotten memories and retains an auditable tombstone", () => {
    const eventContext = context({ spaceId: "space-a" });
    const recorded = recordEvent({ eventId: "event-a", t: 100, id: MEMORY_A, spaceId: "space-a" });
    const current = recordedMemory(recorded);
    const forgotten = makeMemoryForgottenEvent(
      eventContext,
      stamp("event-b", 120),
      current,
      "user request",
    );
    const projected = rebuildMemories([forgotten, recorded]);

    expect(projected.memories.has(MEMORY_A)).toBe(false);
    expect(projected.forgotten.get(MEMORY_A)).toEqual({
      memoryId: MEMORY_A,
      workspaceId: "workspace-1",
      spaceId: "space-a",
      creatorId: "user-a",
      audience: "personal",
      forgottenAt: 120,
      reason: "user request",
    });
  });

  it("keeps independent workspace and creator records", () => {
    const events = [
      recordEvent({ eventId: "event-a", t: 100, id: MEMORY_A }),
      recordEvent({
        eventId: "event-b",
        t: 101,
        id: MEMORY_B,
        principalId: "user-b",
        workspaceId: "workspace-2",
      }),
    ];
    const projected = rebuildMemories(events.reverse());
    expect([...projected.memories.values()].map((item) => item.creatorId).sort()).toEqual([
      "user-a",
      "user-b",
    ]);
  });

  it("fails closed on duplicate records, including after forgetting", () => {
    const recorded = recordEvent({ eventId: "event-a", t: 100, id: MEMORY_A });
    expect(() => rebuildMemories([recorded, recorded])).toThrow(/more than once/);

    const current = recordedMemory(recorded);
    const forgotten = makeMemoryForgottenEvent(context(), stamp("event-b", 110), current, "gone");
    const rerecorded = recordEvent({ eventId: "event-c", t: 120, id: MEMORY_A });
    expect(() => rebuildMemories([recorded, forgotten, rerecorded])).toThrow(/more than once/);
  });

  it("fails closed when a mutation predates or outlives the active memory", () => {
    const recorded = recordEvent({ eventId: "event-b", t: 100, id: MEMORY_A });
    const current = recordedMemory(recorded);
    const validRevision = makeMemoryRevisedEvent(
      context(),
      stamp("event-c", 110),
      current,
      { summary: "Later" },
    );
    const earlyRevision = parseEvent({
      ...validRevision,
      id: "event-a",
      at: { ...validRevision.at, t: 90 },
      changes: validRevision.changes.map((change) =>
        change.verb === "create"
          ? { ...change, subject: "urn:fold-record:event-a", after: { ...change.after, atMs: 90 } }
          : change,
      ),
    });
    expect(() => rebuildMemories([recorded, earlyRevision])).toThrow(/inactive memory/);

    const forgotten = makeMemoryForgottenEvent(context(), stamp("event-d", 120), current, "gone");
    const lateRevision = makeMemoryRevisedEvent(
      context(),
      stamp("event-e", 130),
      current,
      { summary: "Too late" },
    );
    expect(() => rebuildMemories([recorded, forgotten, lateRevision])).toThrow(/inactive memory/);
  });

  it("rejects a structurally valid mutation by another principal", () => {
    const recorded = recordEvent({ eventId: "event-a", t: 100, id: MEMORY_A });
    const revision = makeMemoryRevisedEvent(
      context(),
      stamp("event-b", 110),
      recordedMemory(recorded),
      { summary: "Changed" },
    );
    expect(() => rebuildMemories([recorded, forgeActor(revision, "user-b")])).toThrow(/does not own/);
  });
});
