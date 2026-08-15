import type { NarrativeStore } from "./store.js";
import type { CurvePoint, EntityId } from "./types.js";

function curve(
  store: NarrativeStore,
  arcId: EntityId,
  select: "tension" | "stakes",
): CurvePoint[] {
  if (!store.arcById.has(arcId)) throw new Error(`Unknown arc: ${arcId}`);
  return store.events.map((event) => {
    const arc = store.foldToEvent(event.id).arcs.get(arcId)!;
    return {
      t: event.at.t,
      worldDate: event.at.worldDate,
      event: event.id,
      value: arc[select],
    };
  });
}

export function tensionCurve(store: NarrativeStore, arcId: EntityId): CurvePoint[] {
  return curve(store, arcId, "tension");
}

export function stakesCurve(store: NarrativeStore, arcId: EntityId): CurvePoint[] {
  return curve(store, arcId, "stakes");
}

export function feltIntensityCurve(store: NarrativeStore, arcId: EntityId): CurvePoint[] {
  const tension = tensionCurve(store, arcId);
  const stakes = stakesCurve(store, arcId);
  return tension.map((point, index) => ({
    ...point,
    value: point.value * stakes[index]!.value,
  }));
}
