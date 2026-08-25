import { describe, expect, it } from "vitest";

import { FoldSdk, type FoldSdkActivityContext } from "../src/index.js";
import { access, MemoryStore } from "./helpers.js";

const epoch = Date.parse("2026-08-20T12:00:00.000Z");

function activityContext(): FoldSdkActivityContext {
  const currentAccess = access({ spaces: ["space-a"] });
  return {
    access: currentAccess,
    sensor: "urn:sensor:terminal:session-a",
    sessionId: "session-a",
    heartbeatWindowMs: 1_000,
    capture: {
      scope: { workspace: currentAccess.workspaceId, space: "space-a" },
      identity: {
        principal: currentAccess.principalId,
        workspace: currentAccess.workspaceId,
        agent: "agent-a",
        task: "sdk-fleet",
        repo: "super-brain",
        branch: "main",
        session: "session-a",
        runtime: "simulation",
      },
    },
  };
}

function stamp(sequence: number, offsetMs: number) {
  return {
    id: `activity-event-${sequence}`,
    t: epoch + offsetMs,
    observedAt: new Date(epoch + offsetMs).toISOString(),
  };
}

describe("SDK fleet API", () => {
  it("records sensor signals and rebuilds current fleet state", async () => {
    const sdk = new FoldSdk(new MemoryStore());
    const context = activityContext();
    await sdk.recordActivitySignal(context, stamp(1, 0), { type: "session_started" });
    await sdk.recordActivitySignal(context, stamp(2, 400), { type: "heartbeat" });
    await sdk.recordActivitySignal(context, stamp(3, 500), {
      type: "tool_running",
      toolName: "vitest",
    });

    const fleet = await sdk.fleetSnapshot(context.access, epoch + 900, {
      orphanAfterMs: 2_000,
    });
    expect(fleet.sessions).toEqual([
      expect.objectContaining({
        sessionId: "session-a",
        agentId: "agent-a",
        status: "busy",
        availability: "available",
        freshness: "current",
        orphaned: false,
      }),
    ]);
    expect(fleet.recoveryActions).toEqual([]);
  });

  it("surfaces stale active sessions as recovery plans without inventing offline", async () => {
    const sdk = new FoldSdk(new MemoryStore());
    const context = activityContext();
    await sdk.recordActivitySignal(context, stamp(1, 0), { type: "session_started" });
    await sdk.recordActivitySignal(context, stamp(2, 400), { type: "heartbeat" });
    await sdk.recordActivitySignal(context, stamp(3, 500), {
      type: "session_status_changed",
      status: "busy",
    });

    const fleet = await sdk.fleetSnapshot(context.access, epoch + 2_501, {
      orphanAfterMs: 2_000,
    });
    expect(fleet.sessions[0]).toMatchObject({
      status: "unknown",
      lastKnownStatus: "busy",
      freshness: "stale",
      orphaned: true,
      lastDeclaredLifecyclePhase: "online",
    });
    expect(fleet.recoveryActions).toEqual([
      expect.objectContaining({ kind: "reconcile_orphan", sessionId: "session-a" }),
    ]);
  });

  it("removes space-scoped fleet evidence when access is absent", async () => {
    const sdk = new FoldSdk(new MemoryStore());
    const context = activityContext();
    const result = await sdk.recordActivitySignal(
      context,
      stamp(1, 0),
      { type: "session_started" },
    );
    expect(result.event).toMatchObject({
      author: { kind: "sensor", id: "urn:sensor:terminal:session-a" },
      capture: { scope: { workspace: "workspace-1", space: "space-a" } },
    });

    const fleet = await sdk.fleetSnapshot(access(), epoch + 100);
    expect(fleet.sessions).toEqual([]);
  });
});
