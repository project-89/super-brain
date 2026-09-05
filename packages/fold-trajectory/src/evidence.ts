import { parseEvent, type FoldEvent, type JsonValue } from "@_89/fold";
import { validateAccessContext, canAccessSpace, assertCanWritePersonalMemory } from "@_89/fold-epistemic";
import { z } from "zod";
import { taskManifestSchema, attemptManifestSchema, taskOutcomeInputSchema, taskInterventionInputSchema, taskEvidenceAuthoritySchema } from "./manifests.js";
import type { TrajectoryEventContext, TrajectoryEventStamp } from "./types.js";
import type { TaskManifest, AttemptManifest, TaskAcceptanceRef } from "@_89/fold-trace";
import { taskAcceptanceRefSchema, type TaskOutcomeInput, type TaskInterventionInput, type TaskEvidenceAuthority } from "./manifests.js";

const envelope = { actorId: z.string().min(1), workspaceId: z.string().min(1), spaceId: z.string().min(1).optional(), recordedAt: z.number().int().nonnegative().safe() };
export class TaskEvidenceError extends Error { override readonly name = "TaskEvidenceError"; }
export const taskEvidenceRecordSchema = z.discriminatedUnion("recordType", [
  z.object({ ...envelope, recordType: z.literal("task-manifest"), input: taskManifestSchema }).strict(),
  z.object({ ...envelope, recordType: z.literal("attempt-manifest"), input: attemptManifestSchema }).strict(),
  z.object({ ...envelope, recordType: z.literal("outcome"), input: taskOutcomeInputSchema, authority: taskEvidenceAuthoritySchema }).strict(),
  z.object({ ...envelope, recordType: z.literal("intervention"), input: taskInterventionInputSchema, authority: taskEvidenceAuthoritySchema }).strict(),
]);
export type TaskEvidenceRecord = z.infer<typeof taskEvidenceRecordSchema>;
export type TaskEvidenceMutationResult = { readonly event: FoldEvent; readonly record: TaskEvidenceRecord };
export const TASK_EVIDENCE_NODE_KIND = "x.fold.task-evidence";
export const TASK_EVIDENCE_KINDS = {
  "task-manifest": "trajectory.task-manifest-recorded", "attempt-manifest": "trajectory.attempt-manifest-recorded",
  outcome: "trajectory.outcome-recorded", intervention: "trajectory.intervention-recorded",
} as const;
export type TaskEvidenceInput =
  | { readonly recordType: "task-manifest"; readonly input: TaskManifest }
  | { readonly recordType: "attempt-manifest"; readonly input: AttemptManifest }
  | { readonly recordType: "outcome"; readonly input: TaskOutcomeInput; readonly authority: TaskEvidenceAuthority }
  | { readonly recordType: "intervention"; readonly input: TaskInterventionInput; readonly authority: TaskEvidenceAuthority };

export function makeTaskEvidenceEvent(context: TrajectoryEventContext, stamp: TrajectoryEventStamp, data: TaskEvidenceInput): FoldEvent {
  validateAccessContext(context.access);
  assertCanWritePersonalMemory({ workspaceId: context.access.workspaceId, audience: "workspace", creatorId: context.access.principalId, ...(context.capture.scope.space === undefined ? {} : { spaceId: context.capture.scope.space }) }, context.access);
  if (context.capture.scope.creator !== undefined || context.capture.scope.workspace !== context.access.workspaceId ||
    context.capture.identity.principal !== context.access.principalId || context.capture.identity.workspace !== context.access.workspaceId ||
    (context.capture.scope.space !== undefined && !canAccessSpace(context.access, context.capture.scope.space))) throw new TaskEvidenceError("task evidence scope is inaccessible");
  const record = taskEvidenceRecordSchema.parse({ ...data, actorId: context.access.principalId, workspaceId: context.access.workspaceId,
    ...(context.capture.scope.space === undefined ? {} : { spaceId: context.capture.scope.space }), recordedAt: stamp.t });
  validateAuthority(record);
  return parseEvent({ specVersion: "0.7", id: stamp.id, kind: TASK_EVIDENCE_KINDS[record.recordType], title: `Task evidence: ${record.recordType}`,
    at: { t: stamp.t, worldDate: stamp.worldDate, granularity: "session" }, participants: [record.actorId], author: context.author, capture: context.capture,
    changes: [{ verb: "create", subject: `task-evidence:${stamp.id}`, nodeKind: TASK_EVIDENCE_NODE_KIND,
      after: JSON.parse(JSON.stringify(record)) as Record<string, JsonValue>, provenance: { basis: "authored" } }],
  });
}
function validateAuthority(record: TaskEvidenceRecord): void {
  if (!("authority" in record)) return;
  if (record.authority.kind === "human" && record.authority.principalId !== record.actorId) throw new TaskEvidenceError("human task evidence actor mismatch");
  if (record.authority.kind !== "human" && (record.recordType === "intervention" || record.input.kind === "acceptance")) throw new TaskEvidenceError("machine reporters cannot assert human acceptance or intervention");
  if (record.recordType === "outcome" && record.input.source !== undefined && (record.authority.kind !== "integration" || record.authority.integrationId !== record.input.source.providerId)) throw new TaskEvidenceError("external outcome provider does not match authenticated integration");
}
export function taskEvidenceRecordsFromEvent(event: FoldEvent): TaskEvidenceRecord[] {
  const records: TaskEvidenceRecord[] = [];
  for (const change of event.changes) {
    if (!("nodeKind" in change) || change.nodeKind !== TASK_EVIDENCE_NODE_KIND) continue;
    if (change.verb !== "create") throw new TaskEvidenceError("task evidence must append an immutable record");
    const record = taskEvidenceRecordSchema.parse(change.after);
    if (event.kind !== TASK_EVIDENCE_KINDS[record.recordType] || record.workspaceId !== event.capture?.scope.workspace || record.spaceId !== event.capture?.scope.space ||
      event.capture?.scope.creator !== undefined || event.capture?.identity?.principal !== record.actorId || record.recordedAt !== event.at.t ||
      !event.participants?.includes(record.actorId) || change.provenance?.basis !== "authored" || change.subject !== `task-evidence:${event.id}`) throw new TaskEvidenceError("task evidence envelope mismatch");
    validateAuthority(record); records.push(record);
  }
  if (Object.values(TASK_EVIDENCE_KINDS).includes(event.kind as typeof TASK_EVIDENCE_KINDS[keyof typeof TASK_EVIDENCE_KINDS]) && records.length !== 1) throw new TaskEvidenceError("task evidence event requires one record");
  return records;
}

/** Canonical claim matching only. Private capture authenticity is verified separately by the local witness. */
export function assertTaskAcceptanceSource(reference: TaskAcceptanceRef, source: FoldEvent): void {
  const claims: unknown[] = [];
  for (const change of source.changes) if (change.verb === "create" && source.kind === "terminal.observation" && change.nodeKind === "x.fold.activity-observation" && change.after.observation === "human_decision") {
    const data = change.after.data;
    if (data !== null && typeof data === "object" && !Array.isArray(data)) {
      const candidate = data.acceptance;
      if (candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)) {
        const { authority: _privateAuthority, ...claim } = candidate;
        claims.push({ ...claim, eventId: source.id });
      }
    }
  }
  for (const record of taskEvidenceRecordsFromEvent(source)) if (record.recordType === "intervention" && record.authority.kind === "human" && (record.input.kind === "approval" || record.input.kind === "rejection") && record.input.revisionId !== undefined && record.input.artifact !== undefined) {
    claims.push({ version: 1, taskId: record.input.taskId, attemptId: record.input.attemptId, revisionId: record.input.revisionId,
      verdict: record.input.kind === "approval" ? "success" : "failure", eventId: source.id, artifactId: record.input.artifact.artifactId });
  }
  const match = claims.some((claim) => {
    const parsed = taskAcceptanceRefSchema.safeParse(claim);
    if (!parsed.success) return false;
    return ["taskId", "attemptId", "revisionId", "verdict", "eventId", "artifactId"].every((key) => parsed.data[key as keyof typeof parsed.data] === reference[key as keyof TaskAcceptanceRef]) &&
      (reference.criterionIds ?? []).every((id) => parsed.data.criterionIds?.includes(id));
  });
  if (!match) throw new TaskEvidenceError("acceptance reference does not match canonical approval/rejection source");
}
