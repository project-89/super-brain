import type { FoldEvent } from "./schema.js";

export interface EventCursor {
  readonly t: number;
  readonly eventId: string;
}

export type ForkCursor = EventCursor | number;

export interface FoldLogEntry {
  readonly event: FoldEvent;
  readonly status: "draft" | "canon";
}

export class EventOrderError extends Error {
  override readonly name = "EventOrderError";
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function compareEventKeys(left: FoldEvent, right: FoldEvent): number {
  const timeOrder = left.at.t - right.at.t;
  return timeOrder === 0 ? compareCodeUnits(left.id, right.id) : timeOrder;
}

export function compareEventToCursor(event: FoldEvent, cursor: EventCursor): number {
  const timeOrder = event.at.t - cursor.t;
  return timeOrder === 0 ? compareCodeUnits(event.id, cursor.eventId) : timeOrder;
}

export function sortLog(entries: readonly FoldLogEntry[]): FoldLogEntry[] {
  return [...entries].sort((left, right) => compareEventKeys(left.event, right.event));
}

/**
 * Checks a producer-authored sequence before canonical sorting. Equal-time IDs
 * must already be increasing, otherwise sorting would rewrite authoring order.
 */
export function validateProducerOrder(events: readonly FoldEvent[]): void {
  const previousIdAtTime = new Map<number, string>();
  const eventIds = new Set<string>();

  for (const event of events) {
    if (eventIds.has(event.id)) {
      throw new EventOrderError(`duplicate event id: ${event.id}`);
    }
    eventIds.add(event.id);

    const previousId = previousIdAtTime.get(event.at.t);
    if (previousId !== undefined && compareCodeUnits(previousId, event.id) >= 0) {
      throw new EventOrderError(
        `event ids at t=${event.at.t} are not lexicographically monotonic: ${previousId}, ${event.id}`,
      );
    }
    previousIdAtTime.set(event.at.t, event.id);
  }
}

export function resolveForkCursor(
  entries: readonly FoldLogEntry[],
  cursor: ForkCursor,
): EventCursor {
  if (typeof cursor !== "number") {
    const exists = entries.some(
      ({ event }) => event.at.t === cursor.t && event.id === cursor.eventId,
    );
    if (!exists) {
      throw new EventOrderError(
        `fork cursor does not identify an event: (${cursor.t}, ${cursor.eventId})`,
      );
    }
    return cursor;
  }

  const matches = entries.filter(({ event }) => event.at.t === cursor);
  if (matches.length !== 1) {
    throw new EventOrderError(
      `bare fork cursor t=${cursor} requires exactly one event; found ${matches.length}`,
    );
  }

  return { t: cursor, eventId: matches[0]!.event.id };
}

/** Inclusive cursor selection: ordering key <= cursor. */
export function forkAt(
  entries: readonly FoldLogEntry[],
  cursor: ForkCursor,
): FoldLogEntry[] {
  const resolved = resolveForkCursor(entries, cursor);
  return sortLog(entries).filter(({ event }) => compareEventToCursor(event, resolved) <= 0);
}
