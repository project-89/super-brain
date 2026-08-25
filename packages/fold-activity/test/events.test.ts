import { describe, expect, it } from "vitest";
import { parseEvent } from "@_89/fold";

import {
  eventFromTerminalManagerSignal,
  makeSensorLifecycleEvent,
  makeTerminalClassificationEvent,
  makeTerminalObservationEvent,
  validateActivityEventEnvelope,
  type TerminalSensorContext,
} from "../src/index.js";

const context: TerminalSensorContext = {
  sensor: "urn:sensor:terminal:session-7",
  sessionId: "session-7",
  heartbeatWindowMs: 1_000,
  capture: {
    scope: { workspace: "super-brain", space: "implementation", creator: "jakob" },
    identity: {
      agent: "codex",
      task: "activity-fleet",
      repo: "super-brain",
      branch: "main",
      session: "session-7",
      runtime: "local",
    },
  },
};

const stamp = { id: "event-1", t: 41, observedAt: "2026-08-15T06:00:00.000Z" };

describe("canonical activity events", () => {
  it("emits lifecycle metadata and observed sensor provenance", () => {
    const event = makeSensorLifecycleEvent(context, stamp, "online");
    expect(event).toMatchObject({
      kind: "lifecycle",
      at: { t: 41, worldDate: "2026-08-15" },
      author: { kind: "sensor", id: context.sensor },
      lifecycle: { phase: "online", heartbeatWindowMs: 1_000 },
      capture: context.capture,
    });
    expect(event.changes[0]!.provenance).toEqual({
      basis: "observed",
      method: { kind: "sensor", id: context.sensor },
    });
  });

  it("retains normalized output as an observation rather than a belief", () => {
    const event = makeTerminalObservationEvent(context, stamp, {
      kind: "output",
      output: "Working\nWorking\nDone",
    });
    expect(event.kind).toBe("terminal.observation");
    expect(event.changes[0]).toMatchObject({
      verb: "create",
      nodeKind: "x.fold.activity-observation",
      after: {
        sessionId: "session-7",
        observation: "output",
        output: { sampleCount: 3 },
      },
      provenance: { basis: "observed", method: { kind: "sensor" } },
    });
  });

  it("records classifier mechanism separately without widening basis", () => {
    const event = makeTerminalClassificationEvent(
      context,
      stamp,
      { state: "awaiting_input", confidence: 0.82, ruleId: "prompt-v1" },
      "terminal-state/v1",
      "Continue? (Y/n)",
    );
    expect(event.kind).toBe("terminal.classification");
    expect(event.changes[0]!.provenance).toEqual({
      basis: "observed",
      confidence: 0.82,
      method: { kind: "classifier", id: "terminal-state/v1" },
    });
  });

  it("requires stable sensor and complete source identity", () => {
    expect(() =>
      makeSensorLifecycleEvent({ ...context, sensor: "terminal-7" }, stamp, "online"),
    ).toThrow(/stable urn:sensor/);
    expect(() =>
      makeSensorLifecycleEvent(
        {
          ...context,
          capture: { ...context.capture, identity: { ...context.capture.identity, task: "" } },
        },
        stamp,
        "online",
      ),
    ).toThrow(/requires task/);
  });

  it("maps the tmux-manager transition vocabulary without host dependencies", () => {
    expect(eventFromTerminalManagerSignal(context, stamp, { type: "session_started" }).lifecycle?.phase).toBe(
      "online",
    );
    expect(eventFromTerminalManagerSignal(context, stamp, { type: "heartbeat" }).lifecycle?.phase).toBe(
      "heartbeat",
    );
    const blocked = eventFromTerminalManagerSignal(context, stamp, {
      type: "blocking_prompt",
      promptType: "approval",
      prompt: "Continue?",
      autoResponded: false,
    });
    expect(blocked.changes[0]).toMatchObject({
      after: { observation: "blocking_prompt", data: { autoResponded: false } },
    });
  });

  it("rejects generic or human-authored activity records", () => {
    const event = makeTerminalObservationEvent(context, stamp, {
      kind: "tool_running",
      data: { toolName: "vitest" },
    });
    expect(() =>
      validateActivityEventEnvelope(parseEvent({ ...event, kind: "generic.event" })),
    ).toThrow(/requires an activity event kind/);
    expect(() =>
      validateActivityEventEnvelope(
        parseEvent({ ...event, author: { kind: "human", id: context.sensor } }),
      ),
    ).toThrow(/sensor-authored/);

    const change = event.changes[0]!;
    if (change.verb !== "create") throw new TypeError("expected create change");
    expect(() =>
      validateActivityEventEnvelope(parseEvent({
        ...event,
        changes: [{ ...change, after: { ...change.after, observation: "invented_state" } }],
      })),
    ).toThrow(/unknown observation/);
  });
});
