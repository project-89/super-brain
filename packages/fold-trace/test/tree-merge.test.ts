import { describe, expect, it } from "vitest";

import { isAdditiveTreeRevision, mergeSharedDecisionTrees, type SharedDecisionTree } from "../src/index.js";

const first: SharedDecisionTree = {
  taskId: "task-a",
  rootNodeId: "root",
  nodes: [
    { id: "root", kind: "observation", label: "Start" },
    { id: "pass", kind: "outcome", label: "Pass" },
  ],
  edges: [{ id: "root-pass", sourceId: "root", targetId: "pass", label: "next" }],
};

describe("shared decision tree revisions", () => {
  it("merges a new observed branch without changing existing structure", () => {
    const second: SharedDecisionTree = {
      taskId: "task-a",
      rootNodeId: "root",
      nodes: [
        { id: "root", kind: "observation", label: "Start" },
        { id: "fail", kind: "outcome", label: "Fail" },
      ],
      edges: [{ id: "root-fail", sourceId: "root", targetId: "fail", label: "next" }],
    };
    const merged = mergeSharedDecisionTrees(first, second);
    expect(merged.nodes.map(({ id }) => id)).toEqual(["root", "pass", "fail"]);
    expect(isAdditiveTreeRevision(first, merged)).toBe(true);
    expect(isAdditiveTreeRevision(merged, first)).toBe(false);
  });

  it("rejects a revision that changes an existing node", () => {
    expect(() => mergeSharedDecisionTrees(first, {
      ...first,
      nodes: [{ id: "root", kind: "decision", label: "Changed" }, first.nodes[1]!],
    })).toThrow("conflicts at root");
  });
});
