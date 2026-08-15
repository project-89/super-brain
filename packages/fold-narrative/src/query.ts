import type { NarrativeStore } from "./store.js";
import type { EntityId, NarrativeState, ResolvedPeak } from "./types.js";

function expandCurrentMembers(
  state: NarrativeState,
  id: EntityId,
  seen: ReadonlySet<EntityId> = new Set(),
): EntityId[] {
  if (seen.has(id)) return [];
  const members = state.memberships.get(id);
  if (members === undefined || members.size === 0) return [id];
  const nextSeen = new Set(seen);
  nextSeen.add(id);
  return [...members].flatMap((member) => expandCurrentMembers(state, member, nextSeen));
}

export function knows(state: NarrativeState, who: EntityId, fact: EntityId): boolean {
  return expandCurrentMembers(state, who).some((id) => {
    const cell = state.knowledge.get(id);
    return cell?.known.has(fact) === true && cell.shielded.has(fact) === false;
  });
}

export function whoKnows(state: NarrativeState, fact: EntityId): EntityId[] {
  return [...state.knowledge]
    .filter(([, cell]) => cell.known.has(fact) && !cell.shielded.has(fact))
    .map(([id]) => id);
}

export function peaksResolvedAt(state: NarrativeState, eventId: EntityId): readonly ResolvedPeak[] {
  return state.resolvedPeaks.get(eventId) ?? [];
}

export interface JourneyBeat {
  readonly event: EntityId;
  readonly title: string;
  readonly worldDate: string;
  readonly touch: readonly ("tension" | "stakes" | "resolves" | "reopens")[];
}

export function arcJourney(
  store: NarrativeStore,
  arcId: EntityId,
  round = -1,
): JourneyBeat[] {
  const rounds: JourneyBeat[][] = [[]];
  for (const event of store.events) {
    const touch: ("tension" | "stakes" | "resolves" | "reopens")[] = [];
    if (
      event.changes.some(
        (change) =>
          change.verb === "adjust" &&
          change.subject === arcId &&
          change.component === "drama.tension",
      )
    ) touch.push("tension");
    if (
      event.changes.some(
        (change) =>
          change.verb === "adjust" &&
          change.subject === arcId &&
          change.component === "drama.stakes",
      )
    ) touch.push("stakes");
    const stateChanges = event.changes.filter(
      (change) =>
        change.verb === "set" &&
        change.subject === arcId &&
        change.component === "drama.state",
    );
    if (stateChanges.some((change) => change.verb === "set" && change.after === "closed")) {
      touch.push("resolves");
    }
    if (stateChanges.some((change) => change.verb === "set" && change.after === "open")) {
      touch.push("reopens");
    }
    if (touch.length === 0) continue;

    const currentRound = rounds[rounds.length - 1]!;
    if (
      touch.includes("reopens") &&
      currentRound.some((beat) => beat.touch.includes("resolves"))
    ) {
      rounds.push([]);
    }
    rounds[rounds.length - 1]!.push({
      event: event.id,
      title: event.title,
      worldDate: event.at.worldDate,
      touch,
    });
  }

  return round < 0 ? rounds[rounds.length - 1]! : rounds[round] ?? [];
}
