import { describe, expect, it } from "vitest";

import type { SerializedFoldNode } from "../types";
import { nodeDisplayLabel } from "./StatePage";

function node(properties: SerializedFoldNode["properties"]): SerializedFoldNode {
  return { id: "node-id", nodeKind: "concept", exists: true, properties };
}

describe("state node labels", () => {
  it("uses a personal-memory summary without discarding stable identity", () => {
    expect(
      nodeDisplayLabel(
        "0198c12e-0000-7000-8000-000000000001",
        node({ memory: { summary: "Repository-owned parity" } }),
      ),
    ).toBe("Repository-owned parity");
  });

  it("prefers common semantic labels and falls back to the node ID", () => {
    expect(nodeDisplayLabel("operator-view", node({ title: "Operator view" }))).toBe("Operator view");
    expect(nodeDisplayLabel("tree-revision-id", node({ tree: { taskId: "operator-view" } }))).toBe("operator-view");
    expect(nodeDisplayLabel("operator-view", node({}))).toBe("operator-view");
  });
});
