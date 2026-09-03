import { indexTree, ProjectionValidationError } from "./projection.js";
import type { SharedDecisionTree, SharedEdge, SharedNode } from "./types.js";

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function mergeSharedDecisionTrees(
  current: SharedDecisionTree,
  incoming: SharedDecisionTree,
): SharedDecisionTree {
  if (current.taskId !== incoming.taskId || current.rootNodeId !== incoming.rootNodeId) {
    throw new ProjectionValidationError("shared tree revisions must retain task and root identity");
  }
  const nodes = new Map<string, SharedNode>(current.nodes.map((node) => [node.id, node]));
  for (const node of incoming.nodes) {
    const existing = nodes.get(node.id);
    if (existing !== undefined && !same(existing, node)) {
      throw new ProjectionValidationError(`shared node revision conflicts at ${node.id}`);
    }
    nodes.set(node.id, existing ?? node);
  }
  const edges = new Map<string, SharedEdge>(current.edges.map((edge) => [edge.id, edge]));
  const pairs = new Map(current.edges.map((edge) => [JSON.stringify([edge.sourceId, edge.targetId]), edge]));
  for (const edge of incoming.edges) {
    const existing = edges.get(edge.id);
    if (existing !== undefined && !same(existing, edge)) {
      throw new ProjectionValidationError(`shared edge revision conflicts at ${edge.id}`);
    }
    const pair = JSON.stringify([edge.sourceId, edge.targetId]);
    const paired = pairs.get(pair);
    if (paired !== undefined && !same(paired, edge)) continue;
    edges.set(edge.id, existing ?? edge);
    pairs.set(pair, existing ?? edge);
  }
  const merged = {
    taskId: current.taskId,
    rootNodeId: current.rootNodeId,
    nodes: [...nodes.values()],
    edges: [...edges.values()],
  };
  indexTree(merged);
  return merged;
}

export function isAdditiveTreeRevision(
  current: SharedDecisionTree,
  revision: SharedDecisionTree,
): boolean {
  const merged = mergeSharedDecisionTrees(current, revision);
  return same(merged, revision);
}
