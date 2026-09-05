import type {
  ProjectedTrajectory,
  ProjectionAssignment,
  ProjectionCoverage,
  RawTrajectory,
  SharedDecisionTree,
} from "./types.js";

export class ProjectionValidationError extends Error {
  override readonly name = "ProjectionValidationError";
}

interface TreeIndex {
  readonly nodes: Set<string>;
  readonly edgesByPair: Map<string, string>;
}

export function edgePairKey(sourceId: string, targetId: string): string {
  return JSON.stringify([sourceId, targetId]);
}

export function indexTree(tree: SharedDecisionTree): TreeIndex {
  const nodes = new Set<string>();
  for (const node of tree.nodes) {
    if (nodes.has(node.id)) {
      throw new ProjectionValidationError(`duplicate shared node id: ${node.id}`);
    }
    nodes.add(node.id);
  }
  if (!nodes.has(tree.rootNodeId)) {
    throw new ProjectionValidationError(`missing root node: ${tree.rootNodeId}`);
  }

  const edgesByPair = new Map<string, string>();
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, number>();
  const edgeIds = new Set<string>();
  for (const edge of tree.edges) {
    if (edgeIds.has(edge.id)) {
      throw new ProjectionValidationError(`duplicate shared edge id: ${edge.id}`);
    }
    edgeIds.add(edge.id);
    if (!nodes.has(edge.sourceId) || !nodes.has(edge.targetId)) {
      throw new ProjectionValidationError(`edge ${edge.id} references an unknown node`);
    }
    const pair = edgePairKey(edge.sourceId, edge.targetId);
    if (edgesByPair.has(pair)) {
      throw new ProjectionValidationError(
        `parallel edges are not supported by the spike contract: ${edge.sourceId} -> ${edge.targetId}`,
      );
    }
    edgesByPair.set(pair, edge.id);
    outgoing.set(edge.sourceId, [...(outgoing.get(edge.sourceId) ?? []), edge.targetId]);
    incoming.set(edge.targetId, (incoming.get(edge.targetId) ?? 0) + 1);
  }
  if ((incoming.get(tree.rootNodeId) ?? 0) !== 0) {
    throw new ProjectionValidationError("the shared root node must not have incoming edges");
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (nodeId: string): void => {
    if (visiting.has(nodeId)) {
      throw new ProjectionValidationError(`shared decision structure contains a cycle at ${nodeId}`);
    }
    if (visited.has(nodeId)) return;
    visiting.add(nodeId);
    for (const targetId of outgoing.get(nodeId) ?? []) visit(targetId);
    visiting.delete(nodeId);
    visited.add(nodeId);
  };
  visit(tree.rootNodeId);
  if (visited.size !== nodes.size) {
    const unreachable = [...nodes].filter((nodeId) => !visited.has(nodeId)).sort();
    throw new ProjectionValidationError(
      `shared nodes are unreachable from the root: ${unreachable.join(", ")}`,
    );
  }
  return { nodes, edgesByPair };
}

function validateAssignment(
  assignment: ProjectionAssignment,
  stepId: string,
  nodes: ReadonlySet<string>,
): void {
  if (assignment.method.id.trim().length === 0) {
    throw new ProjectionValidationError(`step ${stepId} has an empty projection method id`);
  }
  if (assignment.method.confidence !== undefined) {
    if (
      !Number.isFinite(assignment.method.confidence) ||
      assignment.method.confidence < 0 ||
      assignment.method.confidence > 1
    ) {
      throw new ProjectionValidationError(`step ${stepId} has confidence outside [0,1]`);
    }
  }

  if (assignment.kind === "ambiguous") {
    if (assignment.candidates.length < 2) {
      throw new ProjectionValidationError(`step ${stepId} ambiguity requires at least two candidates`);
    }
    if (assignment.reason.trim().length === 0) {
      throw new ProjectionValidationError(`step ${stepId} has an empty ambiguity reason`);
    }
  }
  if (assignment.kind === "unmapped" && assignment.reason.trim().length === 0) {
    throw new ProjectionValidationError(`step ${stepId} has an empty unmapped reason`);
  }

  const candidateNodeIds = assignment.kind === "mapped"
    ? [assignment.nodeId]
    : assignment.kind === "ambiguous"
      ? assignment.candidates
      : [];
  if (new Set(candidateNodeIds).size !== candidateNodeIds.length) {
    throw new ProjectionValidationError(`step ${stepId} repeats a projection candidate`);
  }
  for (const nodeId of candidateNodeIds) {
    if (!nodes.has(nodeId)) {
      throw new ProjectionValidationError(`step ${stepId} maps to unknown node ${nodeId}`);
    }
  }
}

export function projectTrajectory(
  trajectory: RawTrajectory,
  tree: SharedDecisionTree,
  assignments: Readonly<Record<string, ProjectionAssignment>>,
): ProjectedTrajectory {
  if (trajectory.taskId !== tree.taskId) {
    throw new ProjectionValidationError(
      `trajectory task ${trajectory.taskId} does not match tree task ${tree.taskId}`,
    );
  }
  const index = indexTree(tree);
  if (trajectory.steps.length === 0) {
    throw new ProjectionValidationError("a trajectory must contain at least one raw step");
  }
  const seenStepIds = new Set<string>();
  let previousStepNumber = Number.NEGATIVE_INFINITY;

  const steps = trajectory.steps.map((step) => {
    if (seenStepIds.has(step.id)) {
      throw new ProjectionValidationError(`duplicate raw step id: ${step.id}`);
    }
    seenStepIds.add(step.id);
    if (step.stepNumber <= previousStepNumber) {
      throw new ProjectionValidationError("raw step numbers must be strictly increasing");
    }
    previousStepNumber = step.stepNumber;

    const assignment = assignments[step.id];
    if (assignment === undefined) {
      throw new ProjectionValidationError(`raw step ${step.id} has no projection outcome`);
    }
    validateAssignment(assignment, step.id, index.nodes);
    return { raw: step, projection: assignment };
  });

  const unknownAssignments = Object.keys(assignments).filter((stepId) => !seenStepIds.has(stepId));
  if (unknownAssignments.length > 0) {
    throw new ProjectionValidationError(
      `projection outcomes reference unknown steps: ${unknownAssignments.join(", ")}`,
    );
  }

  return {
    id: trajectory.id,
    taskId: trajectory.taskId,
    model: trajectory.model,
    outcome: trajectory.outcome,
    capture: trajectory.capture,
    ...(trajectory.manifest === undefined ? {} : { manifest: trajectory.manifest }),
    steps,
  };
}

export function projectionCoverage(
  trajectories: readonly ProjectedTrajectory[],
): ProjectionCoverage {
  let total = 0;
  let mapped = 0;
  let ambiguous = 0;
  let unmapped = 0;

  for (const trajectory of trajectories) {
    for (const step of trajectory.steps) {
      total += 1;
      if (step.projection.kind === "mapped") mapped += 1;
      else if (step.projection.kind === "ambiguous") ambiguous += 1;
      else unmapped += 1;
    }
  }

  return {
    total,
    mapped,
    ambiguous,
    unmapped,
    mappedRatio: total === 0 ? 0 : mapped / total,
  };
}
