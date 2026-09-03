import { describe, expect, it } from "vitest";

import {
  eventFromTerminalManagerSignal,
  makeTerminalClassificationEvent,
  type ActivityEventStamp,
  type TerminalManagerSignal,
  type TerminalSensorContext,
} from "@_89/fold-activity";
import { parseEvent, type FoldEvent } from "@_89/fold";

import {
  FleetProjectionError,
  listFleetSessions,
  planOrphanRecovery,
  rebuildFleet,
} from "../src/index.js";

const epoch = Date.parse("2026-08-15T06:00:00.000Z");

function context(session = "session-1", overrides: Partial<Record<string, string>> = {}): TerminalSensorContext {
  return {
    sensor: `urn:sensor:terminal:${session}`,
    sessionId: session,
    heartbeatWindowMs: 1_000,
    capture: {
      scope: { workspace: "super-brain", space: "fleet", creator: "jakob" },
      identity: {
        agent: `agent-${session}`,
        task: "fleet-test",
        repo: "super-brain",
        branch: "main",
        session,
        runtime: "local",
        ...overrides,
      },
    },
  };
}

function stamp(sequence: number, offsetMs: number): ActivityEventStamp {
  return {
    id: `event-${sequence.toString().padStart(3, "0")}`,
    t: sequence,
    observedAt: new Date(epoch + offsetMs).toISOString(),
  };
}

function signal(
  sequence: number,
  offsetMs: number,
  value: TerminalManagerSignal,
  source = context(),
): FoldEvent {
  return eventFromTerminalManagerSignal(source, stamp(sequence, offsetMs), value);
}

describe("fleet boot reconstruction", () => {
  it("rebuilds lifecycle, heartbeat freshness, and activity status", () => {
    const events = [
      signal(1, 0, { type: "session_started" }),
      signal(2, 500, { type: "heartbeat" }),
      signal(3, 600, { type: "session_ready" }),
      signal(4, 700, { type: "tool_running", toolName: "test" }),
    ];
    const session = rebuildFleet(events, epoch + 1_000).sessions.get("session-1")!;
    expect(session).toMatchObject({
      agentId: "agent-session-1",
      taskId: "fleet-test",
      repo: "super-brain",
      branch: "main",
      runtime: "local",
      status: "busy",
      lastKnownStatus: "busy",
      availability: "available",
      freshness: "current",
      orphaned: false,
      lastLifecyclePhase: "heartbeat",
      lastDeclaredLifecyclePhase: "online",
    });
  });

  it("is deterministic for unordered replay input", () => {
    const events = [
      signal(1, 0, { type: "session_started" }),
      signal(2, 200, { type: "session_ready" }),
      signal(3, 300, { type: "tool_running", toolName: "build" }),
      signal(4, 400, { type: "task_complete", output: "done" }),
    ];
    const ordered = listFleetSessions(rebuildFleet(events, epoch + 500));
    const reversed = listFleetSessions(rebuildFleet([...events].reverse(), epoch + 500));
    expect(reversed).toEqual(ordered);
    expect(ordered[0]!.status).toBe("ready");
  });

  it("maps classifier assertions but retains them as replayable evidence", () => {
    const events = [
      signal(1, 0, { type: "session_started" }),
      makeTerminalClassificationEvent(
        context(),
        stamp(2, 100),
        { state: "awaiting_approval", confidence: 0.8, ruleId: "approval" },
        "terminal-state/v1",
        "Approve access?",
      ),
    ];
    expect(rebuildFleet(events, epoch + 200).sessions.get("session-1")?.status).toBe("blocked");
    expect(events[1]!.changes[0]!.provenance?.method?.kind).toBe("classifier");
  });

  it("keeps degraded and explicit offline distinct", () => {
    const degraded = rebuildFleet(
      [
        signal(1, 0, { type: "session_started" }),
        signal(2, 100, { type: "session_ready" }),
        signal(3, 200, { type: "sensor_degraded", detail: "capture lag" }),
      ],
      epoch + 300,
    ).sessions.get("session-1")!;
    expect(degraded).toMatchObject({ status: "ready", availability: "degraded", freshness: "current" });

    const stopped = rebuildFleet(
      [
        signal(1, 0, { type: "session_started" }),
        signal(2, 200, { type: "session_stopped", reason: "normal exit" }),
      ],
      epoch + 300,
    ).sessions.get("session-1")!;
    expect(stopped).toMatchObject({ status: "stopped", availability: "unavailable", orphaned: false });
  });

  it("sorts multiple reconstructed sessions by stable session identity", () => {
    const a = context("a");
    const b = context("b");
    const snapshot = rebuildFleet(
      [signal(2, 0, { type: "session_started" }, b), signal(1, 0, { type: "session_started" }, a)],
      epoch,
    );
    expect(listFleetSessions(snapshot).map((session) => session.sessionId)).toEqual(["a", "b"]);
  });

  it("does not trust observations when no lifecycle coverage exists", () => {
    const observationOnly = signal(1, 100, { type: "session_ready" });
    expect(rebuildFleet([observationOnly], epoch + 200).sessions.get("session-1")).toMatchObject({
      status: "unknown",
      lastKnownStatus: "ready",
      availability: "unknown",
      freshness: "unknown",
    });
  });
});

describe("orphan sweep", () => {
  const activeEvents = [
    signal(1, 0, { type: "session_started" }),
    signal(2, 500, { type: "heartbeat" }),
    signal(3, 600, { type: "session_status_changed", status: "busy" }),
  ];

  it("turns stale silence into unknown, never synthetic offline", () => {
    const session = rebuildFleet(activeEvents, epoch + 2_001, { orphanAfterMs: 2_000 }).sessions.get(
      "session-1",
    )!;
    expect(session).toMatchObject({
      status: "unknown",
      lastKnownStatus: "busy",
      availability: "unknown",
      freshness: "stale",
      orphaned: false,
    });
  });

  it("plans reconciliation only after the configured orphan timeout", () => {
    const snapshot = rebuildFleet(activeEvents, epoch + 2_501, { orphanAfterMs: 2_000 });
    expect(snapshot.sessions.get("session-1")?.orphaned).toBe(true);
    expect(planOrphanRecovery(snapshot)).toEqual([
      {
        kind: "reconcile_orphan",
        sessionId: "session-1",
        sensor: "urn:sensor:terminal:session-1",
        detectedAt: new Date(epoch + 2_501).toISOString(),
        lastSeenAt: new Date(epoch + 500).toISOString(),
        lastKnownStatus: "busy",
        reason: `sensor stale since ${new Date(epoch + 500).toISOString()}; last known session status busy`,
      },
    ]);
  });

  it("does not classify an explicitly stopped session as orphaned", () => {
    const stopped = [
      ...activeEvents,
      signal(4, 700, { type: "session_stopped", reason: "normal exit" }),
    ];
    const snapshot = rebuildFleet(stopped, epoch + 10_000, { orphanAfterMs: 2_000 });
    expect(snapshot.sessions.get("session-1")).toMatchObject({
      status: "unknown",
      lastKnownStatus: "stopped",
      orphaned: false,
    });
    expect(planOrphanRecovery(snapshot)).toEqual([]);
  });
});

describe("fleet identity validation", () => {
  it("refines and never regresses a provisional capture identity", () => {
    const provisional = context("session-1", {
      agent: "unknown",
      task: "capture-session:unknown:session-1",
      runtime: "unknown",
      branch: "unknown",
    });
    const concrete = context("session-1", {
      agent: "codex",
      task: "capture-session:codex:session-1",
      runtime: "codex",
      branch: "main",
    });
    const session = rebuildFleet([
      signal(1, 0, { type: "session_started" }, provisional),
      signal(2, 100, { type: "session_ready" }, concrete),
      signal(3, 200, { type: "heartbeat" }, provisional),
    ], epoch + 300).sessions.get("session-1");
    expect(session).toMatchObject({
      agentId: "codex",
      taskId: "capture-session:codex:session-1",
      runtime: "codex",
      branch: "main",
    });
  });

  it("tracks an ordered branch change as live session context", () => {
    const session = rebuildFleet([
      signal(1, 0, { type: "session_started" }, context("session-1", { branch: "dev" })),
      signal(2, 100, { type: "tool_running", toolName: "git" }, context("session-1", { branch: "feature" })),
    ], epoch + 200).sessions.get("session-1");
    expect(session?.branch).toBe("feature");
  });

  it("fails closed when a session changes its stamped identity", () => {
    const first = signal(1, 0, { type: "session_started" });
    const conflicting = signal(
      2,
      100,
      { type: "session_ready" },
      context("session-1", { task: "different-task" }),
    );
    expect(() => rebuildFleet([first, conflicting], epoch + 200)).toThrow(FleetProjectionError);
  });

  it("rejects invalid orphan timeouts", () => {
    expect(() => rebuildFleet([], epoch, { orphanAfterMs: 0 })).toThrow(/orphanAfterMs/);
  });

  it("rejects activity records carried by a generic event", () => {
    const activity = signal(1, 0, { type: "session_started" });
    const spoofed = parseEvent({ ...activity, kind: "generic.event", lifecycle: undefined });
    expect(() => rebuildFleet([spoofed], epoch)).toThrow(FleetProjectionError);
  });

  it("ignores lifecycle records owned by non-terminal sensors", () => {
    const terminal = signal(1, 0, { type: "session_started" });
    const unrelated = parseEvent({
      ...terminal,
      author: { kind: "sensor", id: "urn:sensor:temperature:room-a" },
      lifecycle: { ...terminal.lifecycle!, sensor: "urn:sensor:temperature:room-a" },
      capture: {
        scope: { workspace: "super-brain" },
        identity: { room: "room-a" },
      },
      changes: [{
        ...terminal.changes[0],
        subject: "urn:fold:lifecycle:temperature",
        nodeKind: "x.fold.temperature-sensor-lifecycle",
      }],
    });
    expect(listFleetSessions(rebuildFleet([unrelated], epoch))).toEqual([]);
  });
});
