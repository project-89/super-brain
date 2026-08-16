import { describe, expect, it } from "vitest";

import {
  advanceDriveSystem,
  createDriveSystem,
  integrateDriveEntry,
  latestDriveSample,
  makeDriveSampleEvent,
  makeDriveSatiationEvent,
  makeWearTransitionEvent,
  snapshotDriveSystem,
  type DriveEventContext,
  type DriveEventStamp,
} from "../src/index.js";

const context: DriveEventContext = {
  actorId: "poe",
  author: { kind: "simulation", id: "super-brain" },
  capture: {
    scope: { workspace: "super-brain", space: "drives", creator: "jakob" },
    identity: { actor: "poe", runtime: "local" },
  },
};

function stamp(id: string, t: number): DriveEventStamp {
  return { id, t, worldDate: "2026-08-16" };
}

function state() {
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
        initialLevel: 0.21,
        target: 0.8,
        drift: { kind: "linear", ratePerHour: -0.02 },
        satiatedBy: [{ matches: { kind: "event", type: "greeted" }, amount: 0.1 }],
      },
    ],
  });
}

describe("canonical drive evidence", () => {
  it("emits and reads explicit samples with derived provenance", () => {
    const first = snapshotDriveSystem(state());
    const laterState = advanceDriveSystem(state(), 3_600_000).state;
    const later = snapshotDriveSystem(laterState);
    const events = [
      makeDriveSampleEvent(context, stamp("sample-002", later.elapsedMs), later),
      makeDriveSampleEvent(context, stamp("sample-001", first.elapsedMs), first),
    ];
    expect(latestDriveSample(events, "poe")).toEqual(later);
    expect(events[0]!.changes[0]!.provenance).toEqual({
      basis: "derived",
      method: { kind: "system", id: "@_89/fold-drives" },
    });
  });

  it("retains causal entry and clamping evidence", () => {
    const result = integrateDriveEntry(state(), { kind: "event", type: "greeted" }, "world-event");
    const event = makeDriveSatiationEvent(context, stamp("sat-001", 0), result.satiations[0]!);
    expect(event.causedBy).toEqual(["world-event"]);
    expect(event.changes[0]).toMatchObject({
      verb: "create",
      nodeKind: "x.fold.drive-satiation",
      after: { actorId: "poe", driveId: "connection", before: 0.21, requested: 0.1 },
    });
  });

  it("emits threshold transitions separately from samples", () => {
    const result = advanceDriveSystem(state(), 3_600_000);
    const event = makeWearTransitionEvent(
      context,
      stamp("wear-001", 3_600_000),
      result.wearTransitions[0]!,
    );
    expect(event.kind).toBe("drive.wear-transition");
    expect(event.changes[0]).toMatchObject({
      nodeKind: "x.fold.drive-wear-transition",
      after: { from: "between", to: "below", level: 0.19 },
    });
  });

  it("requires actor identity and logical time to agree", () => {
    const sample = snapshotDriveSystem(state());
    expect(() =>
      makeDriveSampleEvent(
        { ...context, capture: { ...context.capture, identity: { actor: "other" } } },
        stamp("bad-actor", 0),
        sample,
      ),
    ).toThrow(/must match actorId/);
    expect(() => makeDriveSampleEvent(context, stamp("bad-time", 1), sample)).toThrow(/must match event t/);
  });
});
