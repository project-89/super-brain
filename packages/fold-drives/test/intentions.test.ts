import { describe, expect, it } from "vitest";

import type { FoldEvent } from "@_89/fold";

import {
  createDriveSystem,
  currentIntentions,
  eligibleToSurface,
  makeIntentionActedEvent,
  makeIntentionCommittedEvent,
  makeIntentionDeclinedEvent,
  makeIntentionEndedEvent,
  makeIntentionSurfacedEvent,
  rebuildIntentions,
  recentDeclines,
  sourcePressure,
  urgency,
  type DriveEventContext,
  type DriveEventStamp,
  type Satisfier,
} from "../src/index.js";

const HOUR = 3_600_000;
const HEARTH: Satisfier = { kind: "affordance", ref: "hearth", params: { action: "light" } };

const context: DriveEventContext = {
  actorId: "poe",
  author: { kind: "agent", id: "poe-runtime" },
  capture: {
    scope: { workspace: "super-brain", space: "drives" },
    identity: { actor: "poe" },
  },
};

function stamp(sequence: number, t = sequence): DriveEventStamp {
  return { id: `event-${sequence.toString().padStart(3, "0")}`, t, worldDate: "2026-08-16" };
}

function surfaced(sequence: number, candidateId: string, driveId = "connection", satisfier = HEARTH) {
  return makeIntentionSurfacedEvent(context, stamp(sequence), {
    id: candidateId,
    sourceDriveId: driveId,
    satisfier,
    aim: `pursue ${candidateId}`,
    trigger: { kind: "quiet" },
  });
}

function driveState() {
  return createDriveSystem({
    actorId: "poe",
    tierCount: 1,
    drives: [
      {
        id: "connection",
        name: "Connection",
        description: "",
        tier: 1,
        weight: 1,
        initialLevel: 0.1,
        target: 0.8,
        drift: { kind: "linear", ratePerHour: 0 },
        satiatedBy: [],
        pursuableBy: [{ satisfier: HEARTH, hint: "the fire" }],
      },
      {
        id: "esteem",
        name: "Esteem",
        description: "",
        tier: 1,
        weight: 1,
        initialLevel: 0.7,
        target: 0.8,
        drift: { kind: "linear", ratePerHour: 0 },
        satiatedBy: [],
        pursuableBy: [{ satisfier: { kind: "affordance", ref: "desk" } }],
      },
    ],
  });
}

describe("intention replay", () => {
  it("reconstructs surfaced, committed, acted, and ended state from unordered events", () => {
    const events = [
      surfaced(1, "candidate-1"),
      makeIntentionCommittedEvent(context, stamp(2), "candidate-1", "intention-1", ["event-001"]),
      makeIntentionActedEvent(context, stamp(3), "intention-1", ["world-action"]),
      makeIntentionEndedEvent(context, stamp(4), "intention-1", { kind: "satisfied" }),
    ];
    const ordered = rebuildIntentions(events, "poe");
    const reversed = rebuildIntentions([...events].reverse(), "poe");
    expect(reversed).toEqual(ordered);
    expect(ordered.intentions.size).toBe(0);
    expect(ordered.pendingCandidates).toHaveLength(0);
    expect(events[0]!.changes[0]!.provenance?.basis).toBe("authored");
  });

  it("keeps unresolved candidates pending and records declines", () => {
    const events = [
      surfaced(1, "pending"),
      surfaced(2, "declined"),
      makeIntentionDeclinedEvent(context, stamp(3), "declined", "not now"),
    ];
    const projection = rebuildIntentions(events, "poe");
    expect(projection.pendingCandidates.map((item) => item.id)).toEqual(["pending"]);
    expect(recentDeclines(projection)).toMatchObject([
      { candidate: { id: "declined" }, reason: "not now" },
    ]);
  });

  it("fails closed on unknown, duplicate, and inactive lifecycle references", () => {
    expect(() =>
      rebuildIntentions([makeIntentionCommittedEvent(context, stamp(1), "missing", "i")], "poe"),
    ).toThrow(/unknown candidate/);
    expect(() => rebuildIntentions([surfaced(1, "same"), surfaced(2, "same")], "poe")).toThrow(
      /more than once/,
    );
    expect(() =>
      rebuildIntentions([makeIntentionActedEvent(context, stamp(1), "inactive")], "poe"),
    ).toThrow(/inactive intention/);
  });

  it("enforces the live commitment cap without silently dropping state", () => {
    const events: FoldEvent[] = [];
    for (let index = 0; index < 4; index++) {
      const base = index * 2 + 1;
      events.push(surfaced(base, `candidate-${index}`));
      events.push(
        makeIntentionCommittedEvent(
          context,
          stamp(base + 1),
          `candidate-${index}`,
          `intention-${index}`,
        ),
      );
    }
    expect(() => rebuildIntentions(events, "poe")).toThrow(/cap of 3/);
  });
});

describe("urgency", () => {
  function committed(attempts = 0) {
    const events = [
      surfaced(1, "candidate"),
      makeIntentionCommittedEvent(context, stamp(2), "candidate", "intention"),
    ];
    for (let index = 0; index < attempts; index++) {
      events.push(makeIntentionActedEvent(context, stamp(3 + index), "intention"));
    }
    return rebuildIntentions(events, "poe");
  }

  it("reads current source pressure and decays with age", () => {
    const state = driveState();
    const intention = committed().intentions.get("intention")!;
    const fresh = urgency(state, intention, intention.formedAtMs);
    expect(urgency(state, intention, intention.formedAtMs + 6 * HOUR)).toBeCloseTo(fresh * 0.5);
    expect(sourcePressure(state, intention)).toBeCloseTo(0.7);
  });

  it("decays by 0.8 per recorded action", () => {
    const state = driveState();
    const before = committed().intentions.get("intention")!;
    const after = committed(1).intentions.get("intention")!;
    expect(urgency(state, after, after.formedAtMs)).toBeCloseTo(
      urgency(state, before, before.formedAtMs) * 0.8,
    );
  });

  it("orders live intentions by current urgency", () => {
    const events = [
      surfaced(1, "connection-candidate"),
      makeIntentionCommittedEvent(context, stamp(2), "connection-candidate", "connection-intention"),
      surfaced(3, "esteem-candidate", "esteem", { kind: "affordance", ref: "desk" }),
      makeIntentionCommittedEvent(context, stamp(4), "esteem-candidate", "esteem-intention"),
    ];
    expect(currentIntentions(rebuildIntentions(events, "poe"), driveState(), 4).map((item) => item.id)).toEqual([
      "connection-intention",
      "esteem-intention",
    ]);
  });
});

describe("surfacing eligibility", () => {
  it("signals pressure without surfacing or committing on its own", () => {
    const projection = rebuildIntentions([], "poe");
    const eligible = eligibleToSurface(driveState(), projection);
    expect(eligible).toMatchObject([
      { driveId: "connection", satisfier: HEARTH, hint: "the fire", threshold: 0.2 },
    ]);
    expect(eligible[0]!.pressure).toBeCloseTo(0.7);
    expect(projection.candidates.size).toBe(0);
  });

  it("suppresses a committed drive+satisfier pairing", () => {
    const projection = rebuildIntentions(
      [surfaced(1, "candidate"), makeIntentionCommittedEvent(context, stamp(2), "candidate", "intention")],
      "poe",
    );
    expect(eligibleToSurface(driveState(), projection)).toHaveLength(0);
  });

  it("normalizes nested satisfier params during decline cooldown", () => {
    const reversedParams: Satisfier = {
      kind: "affordance",
      ref: "hearth",
      params: { action: "light" },
    };
    const events = [
      surfaced(1, "candidate", "connection", reversedParams),
      makeIntentionDeclinedEvent(context, stamp(2), "candidate", "not now"),
    ];
    const projection = rebuildIntentions(events, "poe");
    expect(eligibleToSurface(driveState(), projection, { nowMs: 2 + HOUR })).toHaveLength(0);
    expect(eligibleToSurface(driveState(), projection, { nowMs: 2 + 3 * HOUR })).toHaveLength(1);
  });

  it("rejects actor mismatches between state and projection", () => {
    expect(() =>
      eligibleToSurface(
        driveState(),
        { ...rebuildIntentions([], "poe"), actorId: "other" },
      ),
    ).toThrow(/does not match/);
  });
});
