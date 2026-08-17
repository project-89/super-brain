import { parseEvent } from "@_89/fold";
import { describe, expect, it } from "vitest";

import {
  makeMemoryForgottenEvent,
  makeMemoryRecordedEvent,
  makeMemoryRevisedEvent,
  memoryLogRecordsFromEvent,
  normalizeMemoryTags,
  summarizeMemoryContent,
} from "../src/index.js";
import { MEMORY_A, context, recordedMemory, stamp } from "./helpers.js";

describe("personal memory evidence", () => {
  it("emits a canonical scoped record with explicit personal ownership", () => {
    const event = makeMemoryRecordedEvent(
      context({ spaceId: "space-a" }),
      stamp("memory-record-001", 100),
      {
        id: MEMORY_A,
        spaceId: "space-a",
        source: "conversation",
        content: { z: 2, a: 1 },
        tags: ["person", "decision", "person"],
        entities: [{ id: "person-1", type: "person", name: "Ada" }],
      },
      ["conversation-turn-12"],
    );

    expect(event).toMatchObject({
      kind: "memory.recorded",
      participants: ["user-a"],
      causedBy: ["conversation-turn-12"],
      capture: {
        scope: { workspace: "workspace-1", space: "space-a", creator: "user-a" },
        identity: { principal: "user-a", workspace: "workspace-1" },
      },
    });
    expect(event.changes[0]).toMatchObject({
      verb: "create",
      subject: MEMORY_A,
      nodeKind: "x.fold.personal-memory",
      provenance: { basis: "authored" },
    });
    expect(recordedMemory(event)).toMatchObject({
      id: MEMORY_A,
      workspaceId: "workspace-1",
      spaceId: "space-a",
      creatorId: "user-a",
      summary: '{"a":1,"z":2}',
      tags: ["decision", "person"],
      createdAt: 100,
      updatedAt: 100,
      revision: 0,
    });
  });

  it("normalizes summaries and tags deterministically", () => {
    expect(summarizeMemoryContent(null)).toBe("Memory");
    expect(summarizeMemoryContent({ z: 1, a: [true, "x"] })).toBe('{"a":[true,"x"],"z":1}');
    expect(summarizeMemoryContent("x".repeat(200))).toBe(`${"x".repeat(157)}...`);
    expect(normalizeMemoryTags([" z ", "a", "z"])).toEqual(["a", "z"]);
    expect(() => normalizeMemoryTags([" "])).toThrow(/must not be empty/);
  });

  it("rejects inaccessible spaces and inconsistent capture identity", () => {
    expect(() =>
      makeMemoryRecordedEvent(context(), stamp("denied-space", 1), {
        id: MEMORY_A,
        spaceId: "space-a",
        source: "conversation",
      }),
    ).toThrow(/space/);

    const mismatched = context();
    expect(() =>
      makeMemoryRecordedEvent(
        {
          ...mismatched,
          capture: { ...mismatched.capture, identity: { principal: "user-b", workspace: "workspace-1" } },
        },
        stamp("denied-identity", 1),
        { id: MEMORY_A, source: "conversation" },
      ),
    ).toThrow(/principal/);
  });

  it("requires the event capture scope to match the memory scope", () => {
    expect(() =>
      makeMemoryRecordedEvent(
        context({ spaceId: "space-a", spaceRoles: { "space-a": "reader", "space-b": "reader" } }),
        stamp("scope-ok", 1),
        { id: MEMORY_A, spaceId: "space-b", source: "conversation" },
      ),
    ).toThrow(/capture.scope.space/);
  });

  it("validates identifiers and bounded memory fields", () => {
    const base = context();
    expect(() =>
      makeMemoryRecordedEvent(base, stamp("bad-id", 1), { id: "not-v7", source: "conversation" }),
    ).toThrow(/UUIDv7/);
    expect(() =>
      makeMemoryRecordedEvent(base, stamp("bad-source", 1), { id: MEMORY_A, source: " " }),
    ).toThrow(/source/);
    expect(() =>
      makeMemoryRecordedEvent(base, stamp("bad-summary", 1), {
        id: MEMORY_A,
        source: "conversation",
        summary: "x".repeat(501),
      }),
    ).toThrow(/500/);
    expect(() =>
      makeMemoryRecordedEvent(base, stamp("bad-entity", 1), {
        id: MEMORY_A,
        source: "conversation",
        entities: [{ id: "", type: "person", name: "Ada" }],
      }),
    ).toThrow(/entity id/);
  });

  it("emits normalized revision and forget records with causal evidence", () => {
    const eventContext = context({ spaceId: "space-a" });
    const current = recordedMemory(
      makeMemoryRecordedEvent(eventContext, stamp("record", 100), {
        id: MEMORY_A,
        spaceId: "space-a",
        source: "conversation",
      }),
    );
    const revision = makeMemoryRevisedEvent(
      eventContext,
      stamp("revision", 110),
      current,
      { summary: "Updated", tags: ["z", "a", "z"] },
      ["review-1"],
    );
    const forgotten = makeMemoryForgottenEvent(
      eventContext,
      stamp("forget", 120),
      current,
      "superseded",
      [revision.id],
    );

    expect(memoryLogRecordsFromEvent(revision)[0]).toEqual({
      recordType: "revised",
      actorId: "user-a",
      workspaceId: "workspace-1",
      spaceId: "space-a",
      atMs: 110,
      memoryId: MEMORY_A,
      patch: { summary: "Updated", tags: ["a", "z"] },
    });
    expect(revision.causedBy).toEqual(["review-1"]);
    expect(memoryLogRecordsFromEvent(forgotten)[0]).toMatchObject({
      recordType: "forgotten",
      spaceId: "space-a",
      memoryId: MEMORY_A,
      reason: "superseded",
    });
    expect(forgotten.causedBy).toEqual(["revision"]);
  });

  it("rejects empty, unknown, stale, and non-owner mutations", () => {
    const owner = context();
    const current = recordedMemory(
      makeMemoryRecordedEvent(owner, stamp("record", 100), { id: MEMORY_A, source: "conversation" }),
    );
    expect(() => makeMemoryRevisedEvent(owner, stamp("empty", 110), current, {})).toThrow(/empty/);
    expect(() =>
      makeMemoryRevisedEvent(owner, stamp("unknown", 110), current, { other: true } as never),
    ).toThrow(/unknown memory revision field/);
    expect(() =>
      makeMemoryRevisedEvent(owner, stamp("stale", 99), current, { summary: "Old" }),
    ).toThrow(/predate/);
    expect(() => makeMemoryForgottenEvent(owner, stamp("empty-reason", 110), current, " ")).toThrow(
      /reason/,
    );
    expect(() =>
      makeMemoryRevisedEvent(context({ principalId: "user-b" }), stamp("other", 110), current, {
        summary: "Mine",
      }),
    ).toThrow(/creator-mismatch/);
  });

  it("fails closed when an imported memory record has a mismatched envelope", () => {
    const valid = makeMemoryRecordedEvent(context(), stamp("record", 100), {
      id: MEMORY_A,
      source: "conversation",
    });
    const altered = parseEvent({ ...valid, kind: "memory.revised" });
    expect(() => memoryLogRecordsFromEvent(altered)).toThrow(/event kind/);
  });

  it("fails closed when required imported memory fields are missing", () => {
    const valid = makeMemoryRecordedEvent(context(), stamp("record", 100), {
      id: MEMORY_A,
      source: "conversation",
    });
    const change = valid.changes[0]!;
    if (change.verb !== "create") throw new Error("expected a create change");
    const memory = change.after.memory;
    if (memory === null || typeof memory !== "object" || Array.isArray(memory)) {
      throw new Error("expected a memory object");
    }
    const { summary: _summary, ...withoutSummary } = memory;
    const altered = parseEvent({
      ...valid,
      changes: [{ ...change, after: { ...change.after, memory: withoutSummary } }],
    });
    expect(() => memoryLogRecordsFromEvent(altered)).toThrow(/memory summary/);
  });
});
