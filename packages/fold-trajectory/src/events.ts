import { parseEvent, type FoldEvent, type JsonValue, type Provenance } from "@_89/fold";
import { canAccessSpace, validateAccessContext } from "@_89/fold-epistemic";
import { indexTree, projectTrajectory, type RawTrajectory } from "@_89/fold-trace";

import { trajectoryInputSchema, trajectoryLogRecordSchema } from "./schema.js";
import type {
  TrajectoryEventContext,
  TrajectoryEventStamp,
  TrajectoryInput,
  TrajectoryLogRecord,
  TrajectoryRunRecord,
  TrajectoryTreeRecord,
} from "./types.js";

export const TRAJECTORY_TREE_NODE_KIND = "x.fold.trajectory-tree";
export const TRAJECTORY_NODE_KIND = "x.fold.trajectory";
const AUTHORED: Provenance = { basis: "authored" };

export class TrajectoryEventError extends Error {
  override readonly name = "TrajectoryEventError";
}

function validateContext(context: TrajectoryEventContext): void {
  validateAccessContext(context.access);
  if (context.author.id.trim().length === 0) throw new TrajectoryEventError("author id must not be empty");
  if (context.capture.scope.workspace !== context.access.workspaceId) {
    throw new TrajectoryEventError("capture workspace must match access workspace");
  }
  if (context.capture.scope.creator !== undefined) {
    throw new TrajectoryEventError("trajectory capture must be workspace or space scoped");
  }
  const spaceId = context.capture.scope.space;
  if (spaceId !== undefined && !canAccessSpace(context.access, spaceId)) {
    throw new TrajectoryEventError(`trajectory space is inaccessible: ${spaceId}`);
  }
  if (context.capture.identity.principal !== context.access.principalId) {
    throw new TrajectoryEventError("capture principal must match access principal");
  }
  if (context.capture.identity.workspace !== context.access.workspaceId) {
    throw new TrajectoryEventError("capture identity workspace must match access workspace");
  }
}

function validateStamp(stamp: TrajectoryEventStamp): void {
  if (stamp.id.trim().length === 0) throw new TrajectoryEventError("event id must not be empty");
  if (!Number.isFinite(stamp.t) || stamp.t < 0) throw new TrajectoryEventError("event t must be non-negative");
}

function asJson(record: TrajectoryLogRecord): Record<string, JsonValue> {
  return JSON.parse(JSON.stringify(record)) as Record<string, JsonValue>;
}

function eventFor(
  context: TrajectoryEventContext,
  stamp: TrajectoryEventStamp,
  input: {
    readonly kind: string;
    readonly title: string;
    readonly subject: string;
    readonly nodeKind: string;
    readonly record: TrajectoryLogRecord;
  },
): FoldEvent {
  validateContext(context);
  validateStamp(stamp);
  return parseEvent({
    specVersion: "0.7",
    id: stamp.id,
    kind: input.kind,
    title: input.title,
    at: { t: stamp.t, worldDate: stamp.worldDate, granularity: "session" },
    participants: [context.access.principalId],
    author: context.author,
    capture: context.capture,
    changes: [{
      verb: "create",
      subject: input.subject,
      nodeKind: input.nodeKind,
      after: asJson(input.record),
      provenance: AUTHORED,
    }],
  });
}

export function makeTrajectoryTreeRecordedEvent(
  context: TrajectoryEventContext,
  stamp: TrajectoryEventStamp,
  tree: TrajectoryTreeRecord["tree"],
): FoldEvent {
  validateContext(context);
  indexTree(tree);
  const record: TrajectoryTreeRecord = {
    recordType: "tree",
    actorId: context.access.principalId,
    workspaceId: context.access.workspaceId,
    ...(context.capture.scope.space === undefined ? {} : { spaceId: context.capture.scope.space }),
    recordedAt: stamp.t,
    tree,
  };
  return eventFor(context, stamp, {
    kind: "trajectory.tree-recorded",
    title: `Shared decision tree recorded for ${tree.taskId}`,
    subject: `trajectory-tree-revision:${tree.taskId}:${stamp.id}`,
    nodeKind: TRAJECTORY_TREE_NODE_KIND,
    record,
  });
}

export function makeTrajectoryRecordedEvent(
  context: TrajectoryEventContext,
  stamp: TrajectoryEventStamp,
  tree: TrajectoryTreeRecord["tree"],
  input: TrajectoryInput,
): FoldEvent {
  validateContext(context);
  const parsed = trajectoryInputSchema.parse(input);
  const trajectory: RawTrajectory = {
    id: parsed.id,
    taskId: parsed.taskId,
    model: parsed.model,
    outcome: parsed.outcome,
    capture: context.capture,
    steps: parsed.steps,
  };
  projectTrajectory(trajectory, tree, parsed.assignments);
  const record: TrajectoryRunRecord = {
    recordType: "trajectory",
    actorId: context.access.principalId,
    workspaceId: context.access.workspaceId,
    ...(context.capture.scope.space === undefined ? {} : { spaceId: context.capture.scope.space }),
    recordedAt: stamp.t,
    trajectory,
    assignments: parsed.assignments,
    ...(parsed.reviewText === undefined ? {} : { reviewText: parsed.reviewText }),
  };
  return eventFor(context, stamp, {
    kind: "trajectory.recorded",
    title: `${trajectory.model.id} trajectory recorded for ${trajectory.taskId}`,
    subject: trajectory.id,
    nodeKind: TRAJECTORY_NODE_KIND,
    record,
  });
}

export function trajectoryLogRecordsFromEvent(event: FoldEvent): TrajectoryLogRecord[] {
  const records: TrajectoryLogRecord[] = [];
  for (const change of event.changes) {
    if (change.verb !== "create") continue;
    const isTrajectoryNode =
      change.nodeKind === TRAJECTORY_TREE_NODE_KIND || change.nodeKind === TRAJECTORY_NODE_KIND;
    if (!isTrajectoryNode) continue;
    const parsed = trajectoryLogRecordSchema.safeParse(change.after);
    if (!parsed.success) {
      throw new TrajectoryEventError(`trajectory event ${event.id} contains an invalid record`);
    }
    records.push(parsed.data);
  }
  return records;
}
