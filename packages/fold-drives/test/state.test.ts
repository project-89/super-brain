import { describe, expect, it } from "vitest";

import {
  advanceDriveSystem,
  applyDrift,
  createDriveSystem,
  integrateDriveEntry,
  restoreDriveSystem,
  snapshotDriveSystem,
  summarizeDrives,
  type DriveConfig,
  type DriveSystemConfig,
} from "../src/index.js";

const HOUR = 3_600_000;

function drive(overrides: Partial<DriveConfig> = {}): DriveConfig {
  return {
    id: "connection",
    name: "Connection",
    description: "The need to be met.",
    tier: 1,
    weight: 1,
    initialLevel: 0.8,
    target: 0.8,
    drift: { kind: "linear", ratePerHour: -0.02 },
    satiatedBy: [{ matches: { kind: "event", type: "greeted" }, amount: 0.1 }],
    ...overrides,
  };
}

function config(drives: readonly DriveConfig[] = [drive()]): DriveSystemConfig {
  return { actorId: "poe", tierCount: Math.max(...drives.map((item) => item.tier)), drives };
}

describe("drive drift", () => {
  it("applies linear and exponential drift with clamping", () => {
    expect(applyDrift({ kind: "linear", ratePerHour: -0.1 }, 0.8, HOUR)).toBeCloseTo(0.7);
    expect(applyDrift({ kind: "exponential", halfLifeHours: 24 }, 0.8, 24 * HOUR)).toBeCloseTo(0.4);
    expect(applyDrift({ kind: "linear", ratePerHour: 1 }, 0.9, HOUR)).toBe(1);
    expect(applyDrift({ kind: "linear", ratePerHour: -1 }, 0.1, HOUR)).toBe(0);
  });

  it("supports identified pure custom drift and rejects non-finite output", () => {
    expect(
      applyDrift({ kind: "custom", id: "halve", compute: (current) => current / 2 }, 0.8, HOUR),
    ).toBe(0.4);
    expect(() =>
      applyDrift({ kind: "custom", id: "bad", compute: () => Number.NaN }, 0.8, HOUR),
    ).toThrow(/finite/);
  });

  it("keeps non-positive time as a no-op", () => {
    expect(applyDrift({ kind: "linear", ratePerHour: -0.5 }, 0.5, 0)).toBe(0.5);
    const state = createDriveSystem(config());
    expect(advanceDriveSystem(state, -1)).toEqual({ state, wearTransitions: [] });
  });
});

describe("incremental state", () => {
  it("pins the float-sensitive 48-hour hourly trajectory", () => {
    let state = createDriveSystem(config());
    const samples: number[] = [];
    const transitions: string[] = [];
    for (let hour = 1; hour <= 48; hour++) {
      const result = advanceDriveSystem(state, HOUR);
      state = result.state;
      transitions.push(...result.wearTransitions.map((value) => `${value.from}->${value.to}`));
      if (hour % 12 === 0) samples.push(Number(state.drives.get("connection")!.level.toFixed(12)));
    }
    expect(samples).toEqual([0.56, 0.32, 0.08, 0]);
    expect(state.wear.chronicLoad).toBe(19 / 24);
    expect(transitions).toEqual(["above->between", "between->below"]);
  });

  it("preserves tick granularity instead of substituting closed-form replay", () => {
    let incremental = createDriveSystem(config());
    for (let index = 0; index < 30; index++) {
      incremental = advanceDriveSystem(incremental, HOUR).state;
    }
    const combined = advanceDriveSystem(createDriveSystem(config()), 30 * HOUR).state;
    expect(incremental.drives.get("connection")!.level).toBeLessThan(0.2);
    expect(combined.drives.get("connection")!.level).toBeGreaterThan(0.2);
    expect(incremental.wear.chronicLoad).toBe(1 / 24);
    expect(combined.wear.chronicLoad).toBe(0);
  });

  it("ticks wear against the post-drift level", () => {
    const state = createDriveSystem(
      config([drive({ initialLevel: 0.21, drift: { kind: "linear", ratePerHour: -0.02 } })]),
    );
    const next = advanceDriveSystem(state, HOUR);
    expect(next.state.drives.get("connection")!.level).toBeCloseTo(0.19);
    expect(next.state.wear.perDrive.get("connection")!.sustainedBelowMs).toBe(HOUR);
    expect(next.wearTransitions.map((item) => `${item.from}->${item.to}`)).toEqual([
      "between->below",
    ]);
  });

  it("keeps satiation and drift order noncommutative near a clamp", () => {
    const starting = createDriveSystem(
      config([drive({ initialLevel: 0.95, drift: { kind: "linear", ratePerHour: -0.2 } })]),
    );
    const satiateThenDrift = advanceDriveSystem(
      integrateDriveEntry(starting, { kind: "event", type: "greeted" }).state,
      HOUR,
    ).state;
    const driftThenSatiate = integrateDriveEntry(
      advanceDriveSystem(starting, HOUR).state,
      { kind: "event", type: "greeted" },
    ).state;
    expect(satiateThenDrift.drives.get("connection")!.level).toBe(0.8);
    expect(driftThenSatiate.drives.get("connection")!.level).toBe(0.85);
  });
});

describe("causal integration", () => {
  it("records unclamped requested satiation and does not mutate input", () => {
    const state = createDriveSystem(
      config([
        drive({
          initialLevel: 0.95,
          satiatedBy: [
            { matches: { kind: "event", type: "greeted" }, amount: 0.1 },
            { matches: { kind: "event", type: "greeted" }, amount: 0.1 },
          ],
        }),
      ]),
    );
    const result = integrateDriveEntry(state, { kind: "event", type: "greeted" }, "world-17");
    expect(state.drives.get("connection")!.level).toBe(0.95);
    expect(result.state.drives.get("connection")!.level).toBe(1);
    expect(result.satiations[0]).toMatchObject({
      before: 0.95,
      after: 1,
      requested: 0.2,
      causeEventId: "world-17",
    });
  });

  it("honors kind, type, and predicate matchers", () => {
    const state = createDriveSystem(
      config([
        drive({
          initialLevel: 0.5,
          satiatedBy: [
            {
              matches: {
                kind: "event",
                type: "drink",
                predicate: (entry) => entry.payload?.liquid === "water",
              },
              amount: 0.2,
            },
          ],
        }),
      ]),
    );
    expect(
      integrateDriveEntry(state, { kind: "action", type: "drink", payload: { liquid: "water" } })
        .satiations,
    ).toHaveLength(0);
    expect(
      integrateDriveEntry(state, { kind: "event", type: "drink", payload: { liquid: "soda" } })
        .satiations,
    ).toHaveLength(0);
    expect(
      integrateDriveEntry(state, { kind: "event", type: "drink", payload: { liquid: "water" } })
        .satiations,
    ).toHaveLength(1);
  });

  it("attributes satiation-driven wear crossings immediately", () => {
    const state = createDriveSystem(config([drive({ initialLevel: 0.19, drift: { kind: "linear", ratePerHour: 0 } })]));
    const result = integrateDriveEntry(state, { kind: "event", type: "greeted" }, "greeting");
    expect(result.wearTransitions).toEqual([
      {
        atMs: 0,
        driveId: "connection",
        from: "below",
        to: "between",
        level: 0.29000000000000004,
        causeEventId: "greeting",
      },
    ]);
  });

  it("models asymmetric wear recovery", () => {
    let state = createDriveSystem(
      config([drive({ initialLevel: 0.1, drift: { kind: "linear", ratePerHour: 0 }, satiatedBy: [{ matches: { kind: "event", type: "restore" }, amount: 0.5 }] })]),
    );
    state = advanceDriveSystem(state, 24 * HOUR).state;
    expect(state.wear.chronicLoad).toBe(1);
    state = integrateDriveEntry(state, { kind: "event", type: "restore" }).state;
    state = advanceDriveSystem(state, 6 * HOUR).state;
    expect(state.wear.chronicLoad).toBe(0.5);
    state = advanceDriveSystem(state, 6 * HOUR).state;
    expect(state.wear.chronicLoad).toBe(0);
  });
});

describe("snapshots and summaries", () => {
  it("round-trips an explicit sample without replaying silent time", () => {
    const source = advanceDriveSystem(createDriveSystem(config()), 3 * HOUR).state;
    const restored = restoreDriveSystem(config(), snapshotDriveSystem(source));
    expect(snapshotDriveSystem(restored)).toEqual(snapshotDriveSystem(source));
  });

  it("fails closed when snapshot drive identity changes", () => {
    const snapshot = snapshotDriveSystem(createDriveSystem(config()));
    expect(() => restoreDriveSystem(config(), { ...snapshot, levels: { other: 0.5 } })).toThrow(
      /drive ids/,
    );
  });

  it("returns structured drive pressure ordered by pressure", () => {
    const state = createDriveSystem(
      config([
        drive({ id: "mild", name: "Mild", initialLevel: 0.7 }),
        drive({ id: "urgent", name: "Urgent", initialLevel: 0.1 }),
      ]),
    );
    expect(summarizeDrives(state).map((item) => item.id)).toEqual(["urgent", "mild"]);
  });
});

describe("configuration", () => {
  it("rejects duplicate drives and invalid hysteresis", () => {
    expect(() => createDriveSystem(config([drive(), drive()]))).toThrow(/duplicate/);
    expect(() =>
      createDriveSystem({
        ...config(),
        wear: { criticalThreshold: 0.5, recoveryThreshold: 0.4 },
      }),
    ).toThrow(/less than/);
  });
});
