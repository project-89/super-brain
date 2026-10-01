import { describe, expect, it } from "vitest";

import { indexTree, isAdditiveTreeRevision, mergeSharedDecisionTrees, ProjectionValidationError, type SharedDecisionTree } from "../src/index.js";

function chain(size: number): SharedDecisionTree {
  return {
    taskId: "deep-task",
    rootNodeId: "node-0",
    nodes: Array.from({ length: size }, (_, index) => ({ id: `node-${index}`, kind: "action", label: `Action ${index}` })),
    edges: Array.from({ length: size - 1 }, (_, index) => ({ id: `edge-${index}`, sourceId: `node-${index}`, targetId: `node-${index + 1}`, label: "next" })),
  };
}

describe("deep decision tree validation", () => {
  it("validates and merges additive delivery snapshots beyond the JavaScript call stack", () => {
    const current = chain(10_000);
    const incoming = chain(12_000);
    expect(indexTree(incoming).nodes.size).toBe(12_000);
    expect(mergeSharedDecisionTrees(current, incoming)).toEqual(incoming);
    expect(isAdditiveTreeRevision(current, incoming)).toBe(true);
  });

  it("rejects a cycle at the end of a deep chain with the domain validation error", () => {
    const tree = chain(12_000);
    const cyclic = { ...tree, edges: [...tree.edges, { id: "back-edge", sourceId: "node-11999", targetId: "node-10000", label: "cycle" }] };
    expect(() => indexTree(cyclic)).toThrow(ProjectionValidationError);
    expect(() => indexTree(cyclic)).toThrow("shared decision structure contains a cycle at node-10000");
  });

  it("rejects unreachable nodes after traversing a deep valid chain", () => {
    const tree = chain(12_000);
    const disconnected = { ...tree, nodes: [...tree.nodes, { id: "unreachable", kind: "action" as const, label: "Disconnected" }] };
    expect(() => indexTree(disconnected)).toThrow("shared nodes are unreachable from the root: unreachable");
  });

  it("accepts reconvergent paths and wide fan-out without treating completed nodes as cycles", () => {
    const tree = chain(12_000);
    const reconvergent = { ...tree, edges: [...tree.edges, ...tree.nodes.slice(2).map((node, index) => ({ id: `shortcut-${index}`, sourceId: tree.rootNodeId, targetId: node.id, label: "shortcut" }))] };
    expect(indexTree(reconvergent).nodes.size).toBe(12_000);
  });
});
