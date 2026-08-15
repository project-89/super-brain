import { edgePairKey, indexTree, ProjectionValidationError } from "./projection.js";
import type {
  EdgeOutcome,
  FirstDivergence,
  ProjectedStep,
  ProjectedTrajectory,
  ProjectionAnalysis,
  RouteOutcome,
  SharedDecisionTree,
  SharedEdge,
} from "./types.js";
import { projectionCoverage } from "./projection.js";

type WalkToken =
  | { readonly kind: "edge"; readonly edge: SharedEdge }
  | { readonly kind: "gap"; readonly stepId: string };

function treeEdges(tree: SharedDecisionTree): {
  readonly byId: Map<string, SharedEdge>;
  readonly byPair: Map<string, SharedEdge>;
} {
  indexTree(tree);
  return {
    byId: new Map(tree.edges.map((edge) => [edge.id, edge])),
    byPair: new Map(tree.edges.map((edge) => [edgePairKey(edge.sourceId, edge.targetId), edge])),
  };
}

function mappedNode(step: ProjectedStep): string | undefined {
  return step.projection.kind === "mapped" ? step.projection.nodeId : undefined;
}

function projectedWalk(
  trajectory: ProjectedTrajectory,
  tree: SharedDecisionTree,
): WalkToken[] {
  const { byPair } = treeEdges(tree);
  const tokens: WalkToken[] = [];
  let previousNode: string | undefined;

  for (const step of trajectory.steps) {
    const nodeId = mappedNode(step);
    if (nodeId === undefined) {
      if (previousNode !== undefined) {
        tokens.push({ kind: "gap", stepId: step.raw.id });
      }
      previousNode = undefined;
      continue;
    }
    if (previousNode === undefined || previousNode === nodeId) {
      previousNode = nodeId;
      continue;
    }

    const edge = byPair.get(edgePairKey(previousNode, nodeId));
    if (edge === undefined) {
      throw new ProjectionValidationError(
        `trace ${trajectory.id} maps adjacent steps to a missing edge: ${previousNode} -> ${nodeId}`,
      );
    }
    tokens.push({ kind: "edge", edge });
    previousNode = nodeId;
  }

  return tokens;
}

function completeRoute(
  trajectory: ProjectedTrajectory,
  tree: SharedDecisionTree,
): string[] | undefined {
  if (trajectory.steps.some((step) => step.projection.kind !== "mapped")) return undefined;
  projectedWalk(trajectory, tree);

  const nodes: string[] = [];
  for (const step of trajectory.steps) {
    const nodeId = mappedNode(step)!;
    if (nodes.at(-1) !== nodeId) nodes.push(nodeId);
  }
  const nodeKinds = new Map(tree.nodes.map((node) => [node.id, node.kind]));
  if (nodes[0] !== tree.rootNodeId || nodeKinds.get(nodes.at(-1)!) !== "outcome") {
    return undefined;
  }
  return nodes;
}

export function analyzeProjectedTrajectories(
  trajectories: readonly ProjectedTrajectory[],
  tree: SharedDecisionTree,
): ProjectionAnalysis {
  const edges = treeEdges(tree);
  const edgeCounts = new Map<
    string,
    { traversals: number; successes: number; failures: number }
  >();
  const routeCounts = new Map<
    string,
    { nodeIds: string[]; samples: number; successes: number; failures: number }
  >();
  let routeEligibleTraceCount = 0;

  for (const trajectory of trajectories) {
    for (const token of projectedWalk(trajectory, tree)) {
      if (token.kind !== "edge") continue;
      const counts = edgeCounts.get(token.edge.id) ?? {
        traversals: 0,
        successes: 0,
        failures: 0,
      };
      counts.traversals += 1;
      counts[trajectory.outcome === "success" ? "successes" : "failures"] += 1;
      edgeCounts.set(token.edge.id, counts);
    }

    const route = completeRoute(trajectory, tree);
    if (route === undefined) continue;
    routeEligibleTraceCount += 1;
    const routeKey = JSON.stringify(route);
    const counts = routeCounts.get(routeKey) ?? {
      nodeIds: route,
      samples: 0,
      successes: 0,
      failures: 0,
    };
    counts.samples += 1;
    counts[trajectory.outcome === "success" ? "successes" : "failures"] += 1;
    routeCounts.set(routeKey, counts);
  }

  const edgeOutcomes = new Map<string, EdgeOutcome>();
  for (const [edgeId, counts] of edgeCounts) {
    const edge = edges.byId.get(edgeId)!;
    edgeOutcomes.set(edgeId, {
      edgeId,
      sourceId: edge.sourceId,
      targetId: edge.targetId,
      ...counts,
      successRate: counts.traversals === 0 ? 0 : counts.successes / counts.traversals,
    });
  }

  const routes: RouteOutcome[] = [...routeCounts.values()]
    .map((route) => ({
      ...route,
      successRate: route.samples === 0 ? 0 : route.successes / route.samples,
    }))
    .sort((left, right) => {
      if (left.successRate !== right.successRate) return right.successRate - left.successRate;
      if (left.samples !== right.samples) return right.samples - left.samples;
      const leftKey = JSON.stringify(left.nodeIds);
      const rightKey = JSON.stringify(right.nodeIds);
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });

  return {
    traceCount: trajectories.length,
    routeEligibleTraceCount,
    incompleteTraceCount: trajectories.length - routeEligibleTraceCount,
    coverage: projectionCoverage(trajectories),
    routes,
    mostSuccessfulPath: routes[0]?.nodeIds ?? [],
    edgeOutcomes,
  };
}

function pathEdges(path: readonly string[], tree: SharedDecisionTree): SharedEdge[] {
  const { byPair } = treeEdges(tree);
  const edges: SharedEdge[] = [];
  for (let index = 1; index < path.length; index += 1) {
    const sourceId = path[index - 1]!;
    const targetId = path[index]!;
    const edge = byPair.get(edgePairKey(sourceId, targetId));
    if (edge === undefined) {
      throw new ProjectionValidationError(
        `consensus path references missing edge: ${sourceId} -> ${targetId}`,
      );
    }
    edges.push(edge);
  }
  return edges;
}

export function firstDivergentEdge(
  trajectory: ProjectedTrajectory,
  consensusPath: readonly string[],
  tree: SharedDecisionTree,
  edgeOutcomes: ReadonlyMap<string, EdgeOutcome> = new Map(),
): FirstDivergence {
  if (consensusPath.length === 0) {
    return { kind: "indeterminate", comparedEdges: 0, reason: "no-consensus" };
  }

  const firstMappedStep = trajectory.steps.find(
    (step) => step.projection.kind === "mapped",
  );
  if (firstMappedStep === undefined) {
    return { kind: "indeterminate", comparedEdges: 0, reason: "trace-ended" };
  }
  if (
    firstMappedStep.projection.kind === "mapped" &&
    firstMappedStep.projection.nodeId !== consensusPath[0]
  ) {
    return {
      kind: "indeterminate",
      comparedEdges: 0,
      reason: "different-start-node",
      stepId: firstMappedStep.raw.id,
    };
  }

  const expected = pathEdges(consensusPath, tree);
  const actual = projectedWalk(trajectory, tree);
  let comparedEdges = 0;

  for (const token of actual) {
    if (comparedEdges === expected.length) {
      return { kind: "aligned", comparedEdges };
    }
    if (token.kind === "gap") {
      return {
        kind: "indeterminate",
        comparedEdges,
        reason: "projection-gap",
        stepId: token.stepId,
      };
    }

    const expectedEdge = expected[comparedEdges];
    if (expectedEdge === undefined) return { kind: "aligned", comparedEdges };
    if (token.edge.id !== expectedEdge.id) {
      return {
        kind: "divergent",
        edgeIndex: comparedEdges,
        expectedEdge,
        actualEdge: token.edge,
        ...(edgeOutcomes.get(expectedEdge.id) === undefined
          ? {}
          : { expectedOutcome: edgeOutcomes.get(expectedEdge.id)! }),
        ...(edgeOutcomes.get(token.edge.id) === undefined
          ? {}
          : { actualOutcome: edgeOutcomes.get(token.edge.id)! }),
      };
    }
    comparedEdges += 1;
  }

  return comparedEdges === expected.length
    ? { kind: "aligned", comparedEdges }
    : { kind: "indeterminate", comparedEdges, reason: "trace-ended" };
}
