import { captureEnvelopeSchema } from "@_89/fold";
import { z } from "zod";

const nonEmpty = z.string().min(1);

export const traceStepSchema = z.object({
  id: nonEmpty,
  stepNumber: z.number().int().nonnegative(),
  role: z.enum(["model_thought", "tool_call", "tool_call_response", "decision", "model_output"]),
  content: z.string(),
  toolName: nonEmpty.optional(),
}).strict();

export const sharedNodeSchema = z.object({
  id: nonEmpty,
  kind: z.enum(["decision", "action", "observation", "outcome"]),
  label: nonEmpty,
}).strict();

export const sharedEdgeSchema = z.object({
  id: nonEmpty,
  sourceId: nonEmpty,
  targetId: nonEmpty,
  label: nonEmpty,
}).strict();

export const sharedDecisionTreeSchema = z.object({
  taskId: nonEmpty,
  rootNodeId: nonEmpty,
  nodes: z.array(sharedNodeSchema).min(1),
  edges: z.array(sharedEdgeSchema),
}).strict();

const projectionMethodSchema = z.object({
  kind: z.enum(["manual", "rule", "model"]),
  id: nonEmpty,
  confidence: z.number().finite().min(0).max(1).optional(),
}).strict();

export const projectionAssignmentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("mapped"), nodeId: nonEmpty, method: projectionMethodSchema }).strict(),
  z.object({
    kind: z.literal("ambiguous"),
    candidates: z.tuple([nonEmpty, nonEmpty]).rest(nonEmpty),
    reason: nonEmpty,
    method: projectionMethodSchema,
  }).strict(),
  z.object({
    kind: z.literal("unmapped"),
    reason: nonEmpty,
    method: projectionMethodSchema,
  }).strict(),
]);

export const rawTrajectorySchema = z.object({
  id: nonEmpty,
  taskId: nonEmpty,
  model: z.object({ id: nonEmpty, version: nonEmpty.optional() }).strict(),
  outcome: z.enum(["success", "failure"]),
  capture: captureEnvelopeSchema,
  steps: z.array(traceStepSchema).min(1),
}).strict();

export const trajectoryInputSchema = rawTrajectorySchema.omit({ capture: true }).extend({
  assignments: z.record(projectionAssignmentSchema),
  reviewText: nonEmpty.optional(),
}).strict();

export const trajectoryTreeRecordSchema = z.object({
  recordType: z.literal("tree"),
  actorId: nonEmpty,
  workspaceId: nonEmpty,
  spaceId: nonEmpty.optional(),
  recordedAt: z.number().finite().nonnegative(),
  tree: sharedDecisionTreeSchema,
}).strict();

export const trajectoryRunRecordSchema = z.object({
  recordType: z.literal("trajectory"),
  actorId: nonEmpty,
  workspaceId: nonEmpty,
  spaceId: nonEmpty.optional(),
  recordedAt: z.number().finite().nonnegative(),
  trajectory: rawTrajectorySchema,
  assignments: z.record(projectionAssignmentSchema),
  reviewText: nonEmpty.optional(),
}).strict();

export const trajectoryLogRecordSchema = z.discriminatedUnion("recordType", [
  trajectoryTreeRecordSchema,
  trajectoryRunRecordSchema,
]);
