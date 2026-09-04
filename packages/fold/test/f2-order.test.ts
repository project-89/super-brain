import { describe, expect, it } from "vitest";

import {
  EventOrderError,
  continueFold,
  fold,
  forkAt,
  validateProducerOrder,
} from "../src/index.js";
import { canon, fixtureEvent } from "./fixtures.js";

describe("F2: deterministic event order and fork cursors", () => {
  const first = fixtureEvent({
    id: "event_001",
    at: { t: 42, worldDate: "2026-08-14" },
    changes: [
      {
        verb: "set",
        subject: "arc_one",
        component: "drama.state",
        before: "open",
        after: "turning",
      },
    ],
  });
  const second = fixtureEvent({
    id: "event_002",
    at: { t: 42, worldDate: "2026-08-14" },
    changes: [
      {
        verb: "set",
        subject: "arc_one",
        component: "drama.state",
        before: "turning",
        after: "closed",
      },
    ],
  });

  it("uses an inclusive composite cursor to split same-time Events", () => {
    const selected = forkAt([canon(second), canon(first)], {
      t: 42,
      eventId: "event_001",
    });
    expect(selected.map(({ event }) => event.id)).toEqual(["event_001"]);

    const state = fold([canon(second), canon(first)], {
      include: "canon",
      cursor: { t: 42, eventId: "event_001" },
    });
    expect(state.appliedEvents.map(({ id }) => id)).toEqual(["event_001"]);
  });

  it("rejects an ambiguous bare-t cursor", () => {
    expect(() => forkAt([canon(first), canon(second)], 42)).toThrow(EventOrderError);
  });

  it("allows a bare-t cursor only for a unique Event", () => {
    expect(forkAt([canon(first)], 42).map(({ event }) => event.id)).toEqual(["event_001"]);
  });

  it("rejects a composite cursor that does not name an Event", () => {
    expect(() =>
      forkAt([canon(first), canon(second)], { t: 42, eventId: "event_0015" }),
    ).toThrow(/does not identify an event/);
  });

  it("rejects non-monotonic same-time producer IDs", () => {
    const zulu = fixtureEvent({ id: "event_zulu", at: { t: 42, worldDate: "2026-08-14" } });
    const alpha = fixtureEvent({ id: "event_alpha", at: { t: 42, worldDate: "2026-08-14" } });

    expect(() => validateProducerOrder([zulu, alpha])).toThrow(/not lexicographically monotonic/);
  });

  it("continues a projection without retaining the applied event payloads", () => {
    const state = fold([canon(first)], { include: "canon", retainApplied: false });
    expect(state.appliedEvents).toEqual([]);
    expect(state.appliedChanges).toEqual([]);

    continueFold(state, [canon(second)], { include: "canon", retainApplied: false });
    expect(state.appliedEvents).toEqual([]);
    expect(state.appliedChanges).toEqual([]);
    expect([...state.values.values()]).toContain("closed");
  });
});
