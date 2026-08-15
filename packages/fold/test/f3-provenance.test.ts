import { describe, expect, it } from "vitest";

import {
  eventSchema,
  fold,
  projectChanges,
  sensorStatusAt,
  type FoldEvent,
} from "../src/index.js";
import { canon, fixtureEvent } from "./fixtures.js";

const sensor = "urn:sensor:terminal:session-7";
const capture = {
  scope: {
    workspace: "workspace_alpha",
    space: "venture_7",
    creator: "creator_12",
  },
  identity: {
    agent: "codex",
    task: "implement-fold",
    repo: "super-brain",
    branch: "main",
  },
};

function lifecycle(
  id: string,
  t: number,
  phase: "online" | "heartbeat" | "degraded" | "offline",
  observedAt: string,
): FoldEvent {
  return fixtureEvent({
    id,
    kind: "lifecycle",
    title: `Sensor ${phase}`,
    at: { t, worldDate: "2026-08-14", granularity: "session" },
    author: { kind: "sensor", id: sensor },
    capture,
    lifecycle: {
      sensor,
      phase,
      observedAt,
      heartbeatWindowMs: 1_000,
    },
    changes: [
      {
        verb: "set",
        subject: sensor,
        component: phase === "heartbeat" ? "core.sensorHeartbeat" : "core.sensorStatus",
        before: null,
        after: phase === "heartbeat" ? observedAt : phase,
        provenance: {
          basis: "observed",
          method: { kind: "sensor", id: sensor },
        },
      },
    ],
  });
}

describe("F3: sensed provenance and lifecycle", () => {
  it("represents the complete sensed lifecycle without promoting classifications", () => {
    const events = [
      lifecycle("event_001", 1, "online", "2026-08-14T12:00:00.000Z"),
      lifecycle("event_002", 2, "heartbeat", "2026-08-14T12:00:00.500Z"),
      fixtureEvent({
        id: "event_003",
        kind: "terminal.observation",
        at: { t: 3, worldDate: "2026-08-14" },
        author: { kind: "sensor", id: sensor },
        capture,
        changes: [
          {
            verb: "set",
            subject: "session_7",
            component: "terminal.status",
            before: "running",
            after: "quiet",
            provenance: {
              basis: "observed",
              method: { kind: "sensor", id: sensor },
            },
          },
        ],
      }),
      fixtureEvent({
        id: "event_004",
        kind: "terminal.classification",
        at: { t: 4, worldDate: "2026-08-14" },
        author: { kind: "sensor", id: sensor },
        capture,
        changes: [
          {
            verb: "set",
            subject: "session_7",
            component: "terminal.stallClassification",
            before: null,
            after: "possibly-stalled",
            provenance: {
              basis: "observed",
              confidence: 0.72,
              method: { kind: "classifier", id: "tmux-manager/stall-v1" },
            },
          },
        ],
      }),
      lifecycle("event_005", 5, "degraded", "2026-08-14T12:00:00.700Z"),
      lifecycle("event_006", 6, "offline", "2026-08-14T12:00:00.900Z"),
    ];

    expect(events.every((event) => eventSchema.safeParse(event).success)).toBe(true);
    expect(sensorStatusAt(events, sensor, Date.parse("2026-08-14T12:00:01.000Z"))).toMatchObject({
      status: "offline",
      freshness: "current",
      lastDeclaredStatus: "offline",
    });
  });

  it("keeps provenance per assertion within one Event", () => {
    const event = fixtureEvent({
      capture,
      changes: [
        {
          verb: "set",
          subject: "session_7",
          component: "terminal.rawStatus",
          before: null,
          after: "quiet",
          provenance: {
            basis: "observed",
            method: { kind: "sensor", id: sensor },
          },
        },
        {
          verb: "set",
          subject: "session_7",
          component: "terminal.stallClassification",
          before: null,
          after: "possibly-stalled",
          provenance: {
            basis: "observed",
            confidence: 0.72,
            method: { kind: "classifier", id: "stall-v1" },
          },
        },
      ],
    });

    const state = fold([canon(event)], { include: "canon" });
    expect(state.appliedChanges[0]?.change.provenance?.method?.kind).toBe("sensor");
    expect(state.appliedChanges[1]?.change.provenance?.method?.kind).toBe("classifier");
  });

  it("turns expired silence into unknown/stale, never offline", () => {
    const events = [
      lifecycle("event_001", 1, "online", "2026-08-14T12:00:00.000Z"),
      lifecycle("event_002", 2, "heartbeat", "2026-08-14T12:00:00.500Z"),
    ];

    expect(sensorStatusAt(events, sensor, Date.parse("2026-08-14T12:00:01.501Z"))).toEqual({
      sensor,
      status: "unknown",
      freshness: "stale",
      lastSeenAt: "2026-08-14T12:00:00.500Z",
      lastDeclaredStatus: "online",
      heartbeatWindowMs: 1_000,
    });
  });

  it("rejects classifier as a basis instead of silently widening the enum", () => {
    const candidate = {
      ...fixtureEvent(),
      changes: [
        {
          verb: "set",
          subject: "session_7",
          component: "terminal.status",
          before: null,
          after: "stalled",
          provenance: {
            basis: "classifier",
            method: { kind: "classifier", id: "stall-v1" },
          },
        },
      ],
    };

    expect(eventSchema.safeParse(candidate).success).toBe(false);
  });

  it("preserves capture scope through projection and replay", () => {
    const event = fixtureEvent({ capture });
    const projected = projectChanges(event, (change) => change);
    const state = fold([canon(projected)], { include: "canon" });

    expect(projected.capture).toEqual(capture);
    expect(state.appliedEvents[0]?.capture).toEqual(capture);
  });

  it("requires a capture envelope and matching lifecycle author", () => {
    const withoutCapture = { ...fixtureEvent() } as Record<string, unknown>;
    delete withoutCapture.capture;
    expect(eventSchema.safeParse(withoutCapture).success).toBe(false);

    const mismatched = {
      ...lifecycle("event_001", 1, "online", "2026-08-14T12:00:00.000Z"),
      author: { kind: "sensor", id: "urn:sensor:other" },
    };
    expect(eventSchema.safeParse(mismatched).success).toBe(false);

    const nonUrnSensor = {
      ...fixtureEvent(),
      author: { kind: "sensor", id: "terminal-session-7" },
    };
    expect(eventSchema.safeParse(nonUrnSensor).success).toBe(false);
  });
});
