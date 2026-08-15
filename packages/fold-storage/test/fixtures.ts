import {
  parseEvent,
  type Change,
  type FoldEvent,
  type FoldLogEntry,
} from "@_89/fold";

export function makeEvent(
  id: string,
  t: number,
  changes: readonly Change[],
): FoldEvent {
  return parseEvent({
    specVersion: "0.7",
    id,
    kind: "storage.test",
    title: id,
    at: { t, worldDate: "3000-01-01" },
    author: { kind: "human", id: "storage-test" },
    capture: { scope: { workspace: "storage-tests" } },
    changes,
  });
}

export function createEntry(
  id: string,
  t: number,
  status: FoldLogEntry["status"] = "canon",
): FoldLogEntry {
  return {
    status,
    event: makeEvent(id, t, [
      {
        verb: "create",
        subject: `node-${id}`,
        nodeKind: "concept",
        after: { label: id },
      },
    ]),
  };
}

export function counterEntries(): FoldLogEntry[] {
  return [
    {
      status: "canon",
      event: makeEvent("event-001", 1, [
        {
          verb: "create",
          subject: "counter",
          nodeKind: "concept",
          after: { "drama.tension": 0 },
        },
      ]),
    },
    {
      status: "canon",
      event: makeEvent("event-002", 2, [
        {
          verb: "adjust",
          subject: "counter",
          component: "drama.tension",
          before: 0,
          after: 0.75,
          amount: 0.75,
        },
      ]),
    },
    {
      status: "canon",
      event: makeEvent("event-003", 3, [
        {
          verb: "adjust",
          subject: "counter",
          component: "drama.tension",
          before: 0.75,
          after: 0.5,
          amount: -0.25,
        },
      ]),
    },
  ];
}
