import { eventSchema, type Change, type FoldEvent } from "./schema.js";

/**
 * Projects assertions while treating source identity and capture scope as
 * immutable metadata. The result is revalidated as a complete v0.7 Event.
 */
export function projectChanges(
  event: FoldEvent,
  project: (change: Change, index: number) => Change,
): FoldEvent {
  return eventSchema.parse({
    ...event,
    changes: event.changes.map(project),
  });
}

