import { z } from "zod";

const id = z.string().trim().min(1).max(500);
const count = z.number().int().nonnegative().safe();
export const trajectoryArtifactRefSchema = z.object({
  artifactId: id, kind: z.enum(["task-spec", "input", "repository-snapshot", "context", "outcome"]),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(), byteLength: count.optional(),
}).strict();
export const attemptContextSchema = z.object({
  memoryRefs: z.array(z.object({ memoryId: id, revision: count }).strict()).max(100).optional(),
  artifacts: z.array(trajectoryArtifactRefSchema).max(100).optional(),
  lineage: z.array(z.object({ kind: z.enum(["compaction", "handoff"]), eventId: id,
    previousAttemptId: id.optional(), previousTurnId: id.optional(), artifact: trajectoryArtifactRefSchema.optional(),
  }).strict()).max(100).optional(),
}).strict();
export const taskManifestSchema = z.object({
  version: z.literal(1), taskId: id, taskVersion: id, goal: z.string().min(1).max(10_000).optional(),
  acceptanceCriteria: z.array(z.object({ id, description: z.string().min(1).max(2_000).optional() }).strict()).max(100).optional(),
  specification: trajectoryArtifactRefSchema.optional(), inputs: z.array(trajectoryArtifactRefSchema).max(100).optional(),
}).strict().superRefine((value, context) => {
  if (value.acceptanceCriteria && new Set(value.acceptanceCriteria.map((item) => item.id)).size !== value.acceptanceCriteria.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "criterion IDs must be unique" });
  }
});
export const attemptRevisionRefSchema = z.object({
  fingerprintStatus: z.enum(["available", "unavailable"]), revisionId: id.optional(),
  commit: z.string().regex(/^[a-f0-9]{40,64}$/).optional(), snapshot: trajectoryArtifactRefSchema.optional(),
  reconstruction: z.enum(["complete", "partial", "unavailable"]).optional(),
}).strict().superRefine((value, context) => {
  if ((value.fingerprintStatus === "available") !== (value.revisionId !== undefined)) context.addIssue({ code: z.ZodIssueCode.custom, message: "revision ID requires an available fingerprint" });
  if (value.reconstruction === "complete" && (value.snapshot === undefined || value.revisionId === undefined)) context.addIssue({ code: z.ZodIssueCode.custom, message: "declared complete reconstruction requires a snapshot and available revision" });
});
export const taskAcceptanceRefSchema = z.object({
  version: z.literal(1), taskId: id, attemptId: id, revisionId: id,
  verdict: z.enum(["success", "failure"]), eventId: id, artifactId: id,
  criterionIds: z.array(id).max(100).optional(),
}).strict();
export const attemptManifestSchema = z.object({
  version: z.literal(1), attemptId: id, taskId: id, taskVersion: id,
  parentAttemptId: id.optional(), conditionId: id.optional(), startedAt: z.string().datetime({ offset: true }).optional(),
  startRevision: attemptRevisionRefSchema, finalRevision: attemptRevisionRefSchema.optional(),
  context: attemptContextSchema.optional(), acceptance: taskAcceptanceRefSchema.optional(),
}).strict().superRefine((value, context) => {
  const acceptance = value.acceptance;
  if (value.parentAttemptId === value.attemptId) context.addIssue({ code: z.ZodIssueCode.custom, message: "attempt cannot parent itself" });
  if (acceptance && (acceptance.taskId !== value.taskId || acceptance.attemptId !== value.attemptId || acceptance.revisionId !== value.finalRevision?.revisionId)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "acceptance must match task, attempt and final revision" });
  }
});
export const trajectoryManifestSchema = z.object({ version: z.literal(1), task: taskManifestSchema, attempt: attemptManifestSchema }).strict().superRefine((value, context) => {
  if (value.task.taskId !== value.attempt.taskId || value.task.taskVersion !== value.attempt.taskVersion) context.addIssue({ code: z.ZodIssueCode.custom, message: "task and attempt versions must agree" });
  if (value.attempt.acceptance?.criterionIds?.some((criterion) => !value.task.acceptanceCriteria?.some(({ id }) => id === criterion))) context.addIssue({ code: z.ZodIssueCode.custom, message: "acceptance criterion is absent from task specification" });
});
export const traceRuntimeObservationSchema = z.object({
  provenance: z.enum(["native", "hook-reported", "configured"]), providerId: id.optional(), modelId: id.optional(), modelVersion: id.optional(),
  usageInterpretation: z.enum(["incremental", "cumulative", "unknown"]).optional(), usageScope: z.enum(["request", "turn", "session", "unknown"]).optional(),
  harness: z.object({ id, version: id.optional() }).strict().optional(), configurationId: id.optional(),
  settings: z.object({ temperature: z.number().finite().min(0).max(2).optional(), topP: z.number().finite().min(0).max(1).optional(),
    maxOutputTokens: count.optional(), reasoningEffort: id.optional() }).strict().optional(),
  tools: z.array(z.object({ name: id, version: id.optional() }).strict()).max(100).optional(), permissionMode: id.optional(),
  usage: z.object({ inputTokens: count.optional(), outputTokens: count.optional(), cachedInputTokens: count.optional(), reasoningTokens: count.optional(),
    durationMs: z.number().finite().nonnegative().optional(), cost: z.object({ amount: z.number().finite().nonnegative(), currency: z.string().regex(/^[A-Z]{3}$/) }).strict().optional(),
  }).strict().optional(),
}).strict();
export const taskOutcomeInputSchema = z.object({
  version: z.literal(1), id, taskId: id, attemptId: id, revisionId: id,
  kind: z.enum(["check", "pull-request", "ci", "merge", "revert", "acceptance"]), result: z.enum(["success", "failure", "unknown"]),
  observedAt: z.string().datetime({ offset: true }), sourceEventId: id.optional(),
  source: z.object({ providerId: id, deliveryId: id, externalId: id.optional() }).strict().optional(),
  artifact: trajectoryArtifactRefSchema.optional(), acceptance: taskAcceptanceRefSchema.optional(),
}).strict().superRefine((value, context) => {
  if ((value.sourceEventId === undefined) === (value.source === undefined)) context.addIssue({ code: z.ZodIssueCode.custom, message: "outcome requires one canonical source or authenticated external delivery" });
  if ((value.kind === "acceptance") !== (value.acceptance !== undefined)) context.addIssue({ code: z.ZodIssueCode.custom, message: "only acceptance outcomes require acceptance evidence" });
  if (value.acceptance && (value.acceptance.taskId !== value.taskId || value.acceptance.attemptId !== value.attemptId || value.acceptance.revisionId !== value.revisionId || value.acceptance.verdict !== value.result || value.acceptance.eventId !== value.sourceEventId)) context.addIssue({ code: z.ZodIssueCode.custom, message: "acceptance joins must agree" });
});
export const taskInterventionInputSchema = z.object({ version: z.literal(1), id, taskId: id, attemptId: id, revisionId: id.optional(),
  kind: z.enum(["correction", "constraint", "rejection", "approval"]), observedAt: z.string().datetime({ offset: true }), sourceEventId: id, artifact: trajectoryArtifactRefSchema.optional(),
}).strict();
export const taskEvidenceAuthoritySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("human"), principalId: id }).strict(),
  z.object({ kind: z.literal("integration"), integrationId: id }).strict(),
]);
export type TaskOutcomeInput = z.infer<typeof taskOutcomeInputSchema>;
export type TaskInterventionInput = z.infer<typeof taskInterventionInputSchema>;
export type TaskEvidenceAuthority = z.infer<typeof taskEvidenceAuthoritySchema>;
