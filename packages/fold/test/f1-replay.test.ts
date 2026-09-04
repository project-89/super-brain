import { describe, expect, it } from "vitest";

import {
  fold,
  readComponent,
  serializeFoldState,
  type FoldEvent,
} from "../src/index.js";
import { canon, fixtureEvent } from "./fixtures.js";

describe("F1: canonical Change replay", () => {
  it("replays the Embers threshold fixture incrementally", () => {
    const events: FoldEvent[] = [
      fixtureEvent({
        id: "event_0000",
        at: { t: 0, worldDate: "2026-08-14", granularity: "beat" },
        changes: [
          {
            verb: "create",
            subject: "drive_connection",
            nodeKind: "concept",
            after: { "drama.tension": 0.8 },
          },
        ],
      }),
    ];

    let level = 0.8;
    for (let step = 1; step <= 30; step += 1) {
      const next = Math.max(0, Math.min(1, level + -0.02));
      events.push(
        fixtureEvent({
          id: `event_${String(step).padStart(4, "0")}`,
          at: { t: step, worldDate: "2026-08-14", granularity: "beat" },
          changes: [
            {
              verb: "adjust",
              subject: "drive_connection",
              component: "drama.tension",
              before: level,
              after: next,
              amount: -0.02,
            },
          ],
        }),
      );
      level = next;
    }

    const state = fold(events.map(canon), { include: "canon" });
    const replayed = readComponent(state, "drive_connection", "drama.tension");

    expect(replayed).toBe(0.19999999999999959);
    expect(replayed).toBeLessThan(0.2);
    expect(0.8 - 0.02 * 30).toBe(0.20000000000000007);
    expect(serializeFoldState(state)).toContain("0.1999999999999996");
    expect(state.diagnostics).toEqual([]);
  });

  it("clamps after each Change instead of clamping a closed-form sum", () => {
    const events = [
      fixtureEvent({
        id: "event_0000",
        at: { t: 0, worldDate: "2026-08-14" },
        changes: [
          {
            verb: "create",
            subject: "arc_test",
            nodeKind: "narrative-node",
            after: { "drama.tension": 0 },
          },
        ],
      }),
      fixtureEvent({
        id: "event_0001",
        at: { t: 1, worldDate: "2026-08-14" },
        changes: [
          {
            verb: "adjust",
            subject: "arc_test",
            component: "drama.tension",
            before: 0,
            after: 1,
            amount: 2,
          },
        ],
      }),
      fixtureEvent({
        id: "event_0002",
        at: { t: 2, worldDate: "2026-08-14" },
        changes: [
          {
            verb: "adjust",
            subject: "arc_test",
            component: "drama.tension",
            before: 1,
            after: 0.5,
            amount: -0.5,
          },
        ],
      }),
    ];

    const state = fold(events.map(canon), { include: "canon" });
    expect(readComponent(state, "arc_test", "drama.tension")).toBe(0.5);
  });

  it("rejects coalescible duplicate targets inside one Event", () => {
    const event = fixtureEvent({
      changes: [
        {
          verb: "adjust",
          subject: "arc_test",
          component: "drama.tension",
          before: 0,
          after: 0.2,
          amount: 0.2,
        },
        {
          verb: "adjust",
          subject: "arc_test",
          component: "drama.tension",
          before: 0.2,
          after: 0.3,
          amount: 0.1,
        },
      ],
    });

    expect(() => fold([canon(event)], { include: "canon" })).toThrow(
      /multiple changes for target/,
    );
  });

  it("can replace an existing create for bounded inspection projections", () => {
    const first = fixtureEvent({
      id: "event_0001",
      at: { t: 1, worldDate: "2026-08-14" },
      changes: [{ verb: "create", subject: "revision", nodeKind: "concept", after: { old: true } }],
    });
    const second = fixtureEvent({
      id: "event_0002",
      at: { t: 2, worldDate: "2026-08-14" },
      changes: [{ verb: "create", subject: "revision", nodeKind: "concept", after: { current: true } }],
    });

    const state = fold([canon(first), canon(second)], {
      include: "canon",
      existingCreate: "replace",
    });

    expect(state.nodes.get("revision")?.properties).toEqual({ current: true });
    expect(state.values.has('["revision","old",null,null]')).toBe(false);
    expect(state.diagnostics).toEqual([{
      kind: "existing-create-replaced",
      eventId: "event_0002",
      changeIndex: 0,
      subject: "revision",
    }]);
  });
});
