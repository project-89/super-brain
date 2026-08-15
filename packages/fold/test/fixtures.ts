import { parseEvent, type FoldEvent } from "../src/index.js";

export function fixtureEvent(overrides: Record<string, unknown> = {}): FoldEvent {
  return parseEvent({
    specVersion: "0.7",
    id: "event_0001",
    kind: "world.changed",
    title: "Fixture event",
    at: {
      t: 1,
      worldDate: "2026-08-14",
      granularity: "beat",
    },
    author: { kind: "agent", id: "agent:test" },
    capture: {
      scope: {
        workspace: "workspace_test",
        space: "space_test",
        creator: "creator_test",
      },
      identity: {
        agent: "agent_test",
        task: "task_test",
        repo: "super-brain",
        branch: "main",
      },
    },
    changes: [
      {
        verb: "set",
        subject: "node_test",
        component: "core.motivation",
        before: null,
        after: "continue",
      },
    ],
    ...overrides,
  });
}

export function canon(event: FoldEvent) {
  return { event, status: "canon" as const };
}
