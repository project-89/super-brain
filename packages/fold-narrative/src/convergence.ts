import type { NarrativeStore } from "./store.js";
import type { CurvePoint, EntityId } from "./types.js";

export interface ConvergencePoint extends CurvePoint {
  readonly intensities: readonly { arc: EntityId; intensity: number }[];
  readonly variance: number;
}

export function convergenceSeries(store: NarrativeStore): ConvergencePoint[] {
  return store.events.map((event) => {
    const state = store.foldToEvent(event.id);
    const intensities = [...state.arcs]
      .filter(([, arc]) => arc.state === "open")
      .map(([arc, runtime]) => ({ arc, intensity: runtime.tension * runtime.stakes }));
    for (const peak of state.resolvedPeaks.get(event.id) ?? []) {
      intensities.push({ arc: peak.arc, intensity: peak.tension * peak.stakes });
    }

    const squares = intensities.map(({ intensity }) => intensity ** 2);
    const value = squares.length
      ? squares.reduce((sum, square) => sum + square, 0) / squares.length
      : 0;
    const mean = intensities.length
      ? intensities.reduce((sum, { intensity }) => sum + intensity, 0) / intensities.length
      : 0;
    const variance = intensities.length
      ? intensities.reduce((sum, { intensity }) => sum + (intensity - mean) ** 2, 0) /
        intensities.length
      : 0;

    return {
      t: event.at.t,
      worldDate: event.at.worldDate,
      event: event.id,
      value,
      intensities,
      variance,
    };
  });
}

export interface Climax {
  readonly event: EntityId;
  readonly worldDate: string;
  readonly value: number;
}

export function findClimaxes(
  store: NarrativeStore,
  series: readonly CurvePoint[] = convergenceSeries(store),
  threshold = store.definition.convergenceThreshold ?? 0.15,
): Climax[] {
  const climaxes: Climax[] = [];
  for (let index = 0; index < series.length; index += 1) {
    const point = series[index]!;
    const previous = index === 0 ? -Infinity : series[index - 1]!.value;
    const next = index === series.length - 1 ? -Infinity : series[index + 1]!.value;
    if (point.value >= threshold && point.value >= previous && point.value > next) {
      climaxes.push({ event: point.event, worldDate: point.worldDate, value: point.value });
    }
  }
  return climaxes;
}

export interface Cascade {
  readonly event: EntityId;
  readonly resolves: readonly EntityId[];
  readonly spikes: readonly { arc: EntityId; delta: number }[];
}

export function findCascades(store: NarrativeStore, minSpike = 0.15): Cascade[] {
  const cascades: Cascade[] = [];
  for (const event of store.events) {
    const resolves = event.changes
      .filter(
        (change) =>
          change.verb === "set" &&
          change.component === "drama.state" &&
          change.after === "closed",
      )
      .map((change) => change.subject);
    if (resolves.length === 0) continue;

    const spikes: { arc: EntityId; delta: number }[] = [];
    for (const change of event.changes) {
      if (
        change.verb === "adjust" &&
        change.component === "drama.tension" &&
        change.amount >= minSpike &&
        !resolves.includes(change.subject)
      ) {
        spikes.push({ arc: change.subject, delta: change.amount });
      }
    }
    if (spikes.length > 0) cascades.push({ event: event.id, resolves, spikes });
  }
  return cascades;
}

export interface Counterpoint {
  readonly event: EntityId;
  readonly worldDate: string;
  readonly variance: number;
  readonly high: { arc: EntityId; intensity: number };
  readonly low: { arc: EntityId; intensity: number };
}

export function findCounterpoints(
  store: NarrativeStore,
  minVariance = 0.04,
): Counterpoint[] {
  return convergenceSeries(store)
    .filter((point) => point.variance >= minVariance && point.intensities.length >= 2)
    .map((point) => {
      const sorted = [...point.intensities].sort((left, right) => right.intensity - left.intensity);
      return {
        event: point.event,
        worldDate: point.worldDate,
        variance: point.variance,
        high: sorted[0]!,
        low: sorted[sorted.length - 1]!,
      };
    });
}
