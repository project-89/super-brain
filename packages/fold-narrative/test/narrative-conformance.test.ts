import {
  parseEvent,
  type Change,
  type FoldEvent,
  type FoldLogEntry,
} from "@_89/fold";
import { describe, expect, it } from "vitest";

import {
  arcJourney,
  convergenceSeries,
  knows,
  MEMBERSHIP_EDGE_TYPE,
  NARRATIVE_BOOTSTRAP_KIND,
  NARRATIVE_EVENT_KIND,
  NarrativeStore,
  peaksResolvedAt,
  tensionCurve,
  type NarrativeDefinition,
} from "../src/index.js";

const definition: NarrativeDefinition = {
  arcs: [
    { id: "arc-a", question: "Will A?", stakesBaseline: 0.5 },
    { id: "arc-b", question: "Will B?", stakesBaseline: 0.2 },
  ],
};

function event(
  id: string,
  t: number,
  changes: readonly Change[],
  kind = NARRATIVE_EVENT_KIND,
): FoldEvent {
  return parseEvent({
    specVersion: "0.7",
    id,
    kind,
    title: id,
    at: { t, worldDate: `3000-01-${String(Math.max(1, t)).padStart(2, "0")}` },
    author: { kind: "human", id: "test-author" },
    capture: { scope: { workspace: "narrative-tests" } },
    changes,
  });
}

function entry(value: FoldEvent): FoldLogEntry {
  return { event: value, status: "canon" };
}

function bootstrap(extra: readonly Change[] = []): FoldLogEntry {
  return entry(
    event(
      "bootstrap",
      0,
      [
        {
          verb: "create",
          subject: "arc-a",
          nodeKind: "narrative-node",
          after: { "drama.tension": 0, "drama.stakes": 0.5, "drama.state": "open" },
        },
        {
          verb: "create",
          subject: "arc-b",
          nodeKind: "narrative-node",
          after: { "drama.tension": 0, "drama.stakes": 0.2, "drama.state": "open" },
        },
        ...extra,
      ],
      NARRATIVE_BOOTSTRAP_KIND,
    ),
  );
}

describe("narrative conformance", () => {
  it("uses the inclusive event cursor for same-time narrative states", () => {
    const store = new NarrativeStore(definition, [
      bootstrap(),
      entry(event("event-a", 1, [{
        verb: "adjust",
        subject: "arc-a",
        component: "drama.tension",
        before: 0,
        after: 0.8,
        amount: 0.8,
      }])),
      entry(event("event-b", 1, [{
        verb: "adjust",
        subject: "arc-a",
        component: "drama.tension",
        before: 0.8,
        after: 0.5,
        amount: -0.3,
      }])),
    ]);

    expect(store.foldToEvent("event-a").arcs.get("arc-a")?.tension).toBeCloseTo(0.8);
    expect(store.foldToEvent("event-b").arcs.get("arc-a")?.tension).toBeCloseTo(0.5);
  });

  it("makes concealment win when a fact is both known and shielded", () => {
    const store = new NarrativeStore(definition, [
      bootstrap(),
      entry(event("event-a", 1, [
        { verb: "reveal", subject: "fact-a", audience: "alice", before: false, after: true },
        { verb: "conceal", subject: "fact-a", audience: "alice", before: false, after: true },
      ])),
    ]);

    const state = store.latest();
    expect(state.knowledge.get("alice")?.known.has("fact-a")).toBe(true);
    expect(state.knowledge.get("alice")?.shielded.has("fact-a")).toBe(true);
    expect(knows(state, "alice", "fact-a")).toBe(false);
  });

  it("does not reveal old group knowledge to a late-joining member", () => {
    const store = new NarrativeStore(definition, [
      bootstrap([{
        verb: "link",
        subject: "group",
        object: "alice",
        edgeType: MEMBERSHIP_EDGE_TYPE,
        edgeId: "member-alice",
      }]),
      entry(event("event-a", 1, [
        { verb: "reveal", subject: "fact-a", audience: "group", before: false, after: true },
      ])),
      entry(event("event-b", 2, [{
        verb: "link",
        subject: "group",
        object: "bob",
        edgeType: MEMBERSHIP_EDGE_TYPE,
        edgeId: "member-bob",
      }])),
    ]);

    const state = store.latest();
    expect(knows(state, "alice", "fact-a")).toBe(true);
    expect(knows(state, "bob", "fact-a")).toBe(false);
  });

  it("pins a bare reopen at zero tension while preserving the prior peak", () => {
    const store = new NarrativeStore(definition, [
      bootstrap(),
      entry(event("event-a", 1, [
        {
          verb: "adjust",
          subject: "arc-a",
          component: "drama.tension",
          before: 0,
          after: 0.8,
          amount: 0.8,
        },
        {
          verb: "set",
          subject: "arc-a",
          component: "drama.state",
          before: "open",
          after: "closed",
        },
      ])),
      entry(event("event-b", 2, [{
        verb: "set",
        subject: "arc-a",
        component: "drama.state",
        before: "closed",
        after: "open",
      }])),
    ]);

    const closed = store.foldToEvent("event-a");
    expect(peaksResolvedAt(closed, "event-a")).toContainEqual({
      arc: "arc-a",
      tension: 0.8,
      stakes: 0.5,
    });
    expect(store.foldToEvent("event-b").arcs.get("arc-a")).toMatchObject({
      state: "open",
      tension: 0,
      resolvedBy: null,
    });
    expect(convergenceSeries(store).at(-1)?.value).toBe(0);
  });

  it("splits arc journeys into resolution rounds", () => {
    const store = new NarrativeStore(definition, [
      bootstrap(),
      entry(event("event-a", 1, [{
        verb: "adjust",
        subject: "arc-a",
        component: "drama.tension",
        before: 0,
        after: 0.2,
        amount: 0.2,
      }])),
      entry(event("event-b", 2, [{
        verb: "set",
        subject: "arc-a",
        component: "drama.state",
        before: "open",
        after: "closed",
      }])),
      entry(event("event-c", 3, [
        {
          verb: "adjust",
          subject: "arc-a",
          component: "drama.tension",
          before: 0.2,
          after: 0.5,
          amount: 0.3,
        },
        {
          verb: "set",
          subject: "arc-a",
          component: "drama.state",
          before: "closed",
          after: "open",
        },
      ])),
    ]);

    expect(arcJourney(store, "arc-a", 0).map(({ event: id }) => id)).toEqual([
      "event-a",
      "event-b",
    ]);
    expect(arcJourney(store, "arc-a").map(({ event: id }) => id)).toEqual(["event-c"]);
    expect(arcJourney(store, "arc-b")).toEqual([]);
  });

  it("rejects an unknown arc curve", () => {
    const store = new NarrativeStore(definition, [bootstrap()]);
    expect(() => tensionCurve(store, "missing")).toThrow("Unknown arc: missing");
  });
});
