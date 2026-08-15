import {
  fold,
  sortLog,
  validateProducerOrder,
  type FoldEvent,
  type FoldLogEntry,
  type FoldState,
} from "@_89/fold";

import type {
  ArcRuntime,
  EntityId,
  KnowledgeCell,
  NarrativeDefinition,
  NarrativeState,
} from "./types.js";

export const NARRATIVE_EVENT_KIND = "narrative.event";
export const NARRATIVE_BOOTSTRAP_KIND = "narrative.bootstrap";
export const MEMBERSHIP_EDGE_TYPE = "core.membership";

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function getKnowledgeCell(
  knowledge: Map<EntityId, KnowledgeCell>,
  id: EntityId,
): KnowledgeCell {
  let cell = knowledge.get(id);
  if (cell === undefined) {
    cell = { known: new Set(), shielded: new Set() };
    knowledge.set(id, cell);
  }
  return cell;
}

function expandMembers(
  id: EntityId,
  memberships: ReadonlyMap<EntityId, ReadonlySet<EntityId>>,
  seen: ReadonlySet<EntityId> = new Set(),
): EntityId[] {
  if (seen.has(id)) return [];
  const members = memberships.get(id);
  if (members === undefined || members.size === 0) return [id];

  const nextSeen = new Set(seen);
  nextSeen.add(id);
  return [...members].flatMap((member) => expandMembers(member, memberships, nextSeen));
}

function projectNarrativeState(
  definition: NarrativeDefinition,
  foldState: FoldState,
): NarrativeState {
  const eventById = new Map(foldState.appliedEvents.map((event) => [event.id, event]));
  const arcs = new Map<EntityId, ArcRuntime>(
    definition.arcs.map((arc) => [
      arc.id,
      {
        state: "open",
        resolvedBy: null,
        tension: 0,
        stakes: clamp01(arc.stakesBaseline ?? 0),
        openedAt: null,
      },
    ]),
  );
  const knowledge = new Map<EntityId, KnowledgeCell>();
  const memberships = new Map<EntityId, Set<EntityId>>();
  const resolvedPeaks = new Map<EntityId, { arc: EntityId; tension: number; stakes: number }[]>();

  for (const applied of foldState.appliedChanges) {
    const { change, eventId } = applied;
    const event = eventById.get(eventId);
    if (event === undefined) continue;

    if (change.verb === "link" && change.edgeType === MEMBERSHIP_EDGE_TYPE) {
      const members = memberships.get(change.subject) ?? new Set<EntityId>();
      members.add(change.object);
      memberships.set(change.subject, members);
      continue;
    }
    if (change.verb === "unlink" && change.edgeType === MEMBERSHIP_EDGE_TYPE) {
      memberships.get(change.subject)?.delete(change.object);
      continue;
    }

    if (change.verb === "reveal" || change.verb === "conceal") {
      for (const audience of expandMembers(change.audience, memberships)) {
        const cell = getKnowledgeCell(knowledge, audience);
        if (change.verb === "reveal") cell.known.add(change.subject);
        else cell.shielded.add(change.subject);
      }
      continue;
    }

    const arc = arcs.get(change.subject);
    if (arc === undefined) continue;

    if (change.verb === "adjust" && change.component === "drama.tension") {
      arc.tension = clamp01(arc.tension + change.amount);
      if (arc.openedAt === null) arc.openedAt = event.at.t;
      continue;
    }
    if (change.verb === "adjust" && change.component === "drama.stakes") {
      arc.stakes = clamp01(arc.stakes + change.amount);
      if (arc.openedAt === null) arc.openedAt = event.at.t;
      continue;
    }
    if (change.verb !== "set" || change.component !== "drama.state") continue;

    if (change.after === "closed") {
      const peaks = resolvedPeaks.get(eventId) ?? [];
      peaks.push({ arc: change.subject, tension: arc.tension, stakes: arc.stakes });
      resolvedPeaks.set(eventId, peaks);
      arc.state = "closed";
      arc.resolvedBy = eventId;
      arc.tension = 0;
    } else if (change.after === "open") {
      arc.state = "open";
      arc.resolvedBy = null;
    }
  }

  return {
    foldState,
    arcs,
    knowledge,
    memberships,
    resolvedPeaks,
    applied: foldState.appliedEvents.filter((event) => event.kind === NARRATIVE_EVENT_KIND),
  };
}

export class NarrativeStore {
  readonly definition: NarrativeDefinition;
  readonly entries: readonly FoldLogEntry[];
  readonly events: readonly FoldEvent[];
  readonly arcById: ReadonlyMap<EntityId, NarrativeDefinition["arcs"][number]>;

  constructor(definition: NarrativeDefinition, entries: readonly FoldLogEntry[]) {
    this.definition = definition;
    this.entries = [...entries];
    validateProducerOrder(entries.map(({ event }) => event));
    this.events = sortLog(entries)
      .filter(({ status, event }) => status === "canon" && event.kind === NARRATIVE_EVENT_KIND)
      .map(({ event }) => event);
    this.arcById = new Map(definition.arcs.map((arc) => [arc.id, arc]));
  }

  event(eventId: EntityId): FoldEvent {
    const event = this.events.find(({ id }) => id === eventId);
    if (event === undefined) throw new Error(`Unknown narrative event: ${eventId}`);
    return event;
  }

  timeOf(eventId: EntityId): number {
    return this.event(eventId).at.t;
  }

  foldToEvent(eventId: EntityId): NarrativeState {
    const event = this.event(eventId);
    const foldState = fold(this.entries, {
      include: "canon",
      cursor: { t: event.at.t, eventId: event.id },
    });
    return projectNarrativeState(this.definition, foldState);
  }

  latest(): NarrativeState {
    return projectNarrativeState(this.definition, fold(this.entries, { include: "canon" }));
  }
}
