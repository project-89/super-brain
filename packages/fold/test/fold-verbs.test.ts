import { describe, expect, it } from "vitest";

import { fold, readComponent } from "../src/index.js";
import { canon, fixtureEvent } from "./fixtures.js";

describe("core Change verbs", () => {
  it("applies all twelve verbs through the generic fold", () => {
    const changes = [
      {
        verb: "create",
        subject: "character_main",
        nodeKind: "character",
        after: { "core.regard": 0.1 },
      },
      {
        verb: "adjust",
        subject: "character_main",
        component: "core.regard",
        before: 0.1,
        after: 0.3,
        amount: 0.2,
      },
      {
        verb: "set",
        subject: "character_main",
        component: "core.motivation",
        before: null,
        after: "protect the archive",
      },
      {
        verb: "mark",
        subject: "character_main",
        component: "core.alive",
        before: false,
        after: true,
      },
      {
        verb: "link",
        subject: "character_main",
        object: "organization_fold",
        edgeType: "member-of",
        edgeId: "edge_membership_1",
      },
      {
        verb: "transfer",
        subject: "world_main",
        object: "artifact_key",
        before: null,
        after: "character_main",
      },
      {
        verb: "reveal",
        subject: "fact_secret",
        audience: "character_main",
        before: false,
        after: true,
      },
      {
        verb: "conceal",
        subject: "fact_other",
        audience: "character_main",
        before: false,
        after: true,
      },
      {
        verb: "merge",
        subject: "character_main",
        object: "character_alias",
        before: {},
        after: null,
      },
      {
        verb: "unlink",
        subject: "character_main",
        object: "organization_fold",
        edgeType: "member-of",
        edgeId: "edge_membership_1",
      },
      {
        verb: "unmark",
        subject: "character_main",
        component: "core.alive",
        before: true,
        after: false,
      },
      {
        verb: "destroy",
        subject: "character_main",
        before: { "core.regard": 0.1 },
      },
    ] as const;

    const events = changes.map((change, index) =>
      fixtureEvent({
        id: `event_${String(index).padStart(3, "0")}`,
        at: { t: index, worldDate: "2026-08-14" },
        changes: [change],
      }),
    );
    const state = fold(events.map(canon), { include: "canon" });

    expect(readComponent(state, "character_main", "core.regard")).toBeCloseTo(0.3);
    expect(readComponent(state, "artifact_key", "core.possession")).toBe("character_main");
    expect(readComponent(state, "character_main", "core.knowledge", "known", "fact_secret")).toBe(true);
    expect(readComponent(state, "character_main", "core.knowledge", "shielded", "fact_other")).toBe(true);
    expect(state.redirects.get("character_alias")).toBe("character_main");
    expect(state.edges.size).toBe(0);
    expect(state.nodes.get("character_main")?.exists).toBe(false);
    expect(state.appliedChanges).toHaveLength(12);
    expect(state.diagnostics).toEqual([]);
  });
});

