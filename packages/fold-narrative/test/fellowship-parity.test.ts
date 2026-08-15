import { describe, expect, it } from "vitest";

import {
  convergenceSeries,
  findCascades,
  findClimaxes,
  knows,
  peaksResolvedAt,
  stakesCurve,
  tensionCurve,
} from "../src/index.js";
import { loadMythopiaFixture } from "./compat/mythopia.js";

const fixtureUrl = new URL("./fixtures/mythopia/fellowship-reference-canon.yaml", import.meta.url);
const { store } = loadMythopiaFixture(fixtureUrl);

describe("pinned Mythopia Fellowship parity", () => {
  it("preserves event count and group knowledge behavior", () => {
    expect(store.events).toHaveLength(15);
    expect(store.latest().foldState.diagnostics).toEqual([]);
    expect(knows(store.foldToEvent("evt_001"), "chr_sam", "fct_ring_is_the_one")).toBe(true);
    expect(knows(store.foldToEvent("evt_005"), "chr_boromir", "fct_ring_is_the_one")).toBe(false);
    expect(knows(store.foldToEvent("evt_007"), "chr_boromir", "fct_ring_is_the_one")).toBe(true);
  });

  it("retains explicit concealment as a shielded assertion", () => {
    const end = store.foldToEvent("evt_015");
    expect(end.knowledge.get("chr_frodo")?.shielded.has("fct_gandalf_survives")).toBe(true);
    expect(knows(end, "chr_frodo", "fct_gandalf_survives")).toBe(false);
  });

  it("matches tension persistence, de-escalation, and clamping", () => {
    const tension = new Map(
      tensionCurve(store, "arc_frodo_burden").map((point) => [point.event, point.value]),
    );
    expect(tension.get("evt_005")).toBeCloseTo(0.8, 5);
    expect(tension.get("evt_006")).toBeCloseTo(0.6, 5);
    expect(tension.get("evt_015")).toBeCloseTo(1, 5);

    const stakes = stakesCurve(store, "arc_frodo_burden").map(({ value }) => value);
    for (let index = 1; index < stakes.length; index += 1) {
      expect(stakes[index]).toBeGreaterThanOrEqual(stakes[index - 1]!);
    }
    expect(stakes[stakes.length - 1]).toBe(1);
  });

  it("captures a resolving arc at peak intensity before zeroing it", () => {
    const before = store.foldToEvent("evt_010").arcs.get("arc_gandalf_stand")!;
    expect(before.state).toBe("open");
    expect(before.tension).toBeCloseTo(0.4, 5);

    const after = store.foldToEvent("evt_011");
    const resolved = after.arcs.get("arc_gandalf_stand")!;
    expect(resolved).toMatchObject({ state: "closed", resolvedBy: "evt_011", tension: 0 });
    const peak = peaksResolvedAt(after, "evt_011")[0]!;
    expect(peak.arc).toBe("arc_gandalf_stand");
    expect(peak.tension).toBe(0.9);
    expect(peak.stakes).toBe(0.8999999999999999);
  });

  it("reproduces the Moria twin peak and Amon Hen maximum", () => {
    const series = convergenceSeries(store);
    const byEvent = new Map(series.map((point) => [point.event, point.value]));
    expect(byEvent.get("evt_011")!).toBeCloseTo(0.37, 1);
    expect(byEvent.get("evt_015")).toBe(Math.max(...series.map(({ value }) => value)));
    expect(findClimaxes(store).map(({ event }) => event)).toEqual(["evt_011", "evt_015"]);
  });

  it("detects the bridge resolution cascade", () => {
    const bridge = findCascades(store).find(({ event }) => event === "evt_011")!;
    expect(bridge.resolves).toContain("arc_gandalf_stand");
    expect(bridge.spikes.map(({ arc }) => arc)).toContain("arc_fellowship_unity");
  });
});
