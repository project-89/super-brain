import { compareEventKeys, type FoldEvent } from "@_89/fold";
import type { AttemptManifest, TaskManifest } from "@_89/fold-trace";
import { trajectoryLogRecordsFromEvent } from "./events.js";
import { TaskEvidenceError, taskEvidenceRecordsFromEvent, assertTaskAcceptanceSource, type TaskEvidenceRecord } from "./evidence.js";

export function taskVersionKey(taskId: string, taskVersion: string): string { return JSON.stringify([taskId, taskVersion]); }
export function attemptBaseline(attempt: AttemptManifest): unknown {
  const { finalRevision: _final, acceptance: _acceptance, ...baseline } = attempt;
  return baseline;
}
const stable = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item !== null && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) : item);
export interface TaskEvidenceState {
  readonly tasks: ReadonlyMap<string, TaskManifest>;
  readonly attempts: ReadonlyMap<string, AttemptManifest>;
  readonly records: readonly TaskEvidenceRecord[];
}
export function rebuildTaskEvidence(events: readonly FoldEvent[]): TaskEvidenceState {
  const tasks = new Map<string, TaskManifest>(); const attempts = new Map<string, AttemptManifest>();
  const records: TaskEvidenceRecord[] = []; const observations = new Set<string>();
  const scopes = new Map<string, string>();
  const seenEvents = new Map<string, FoldEvent>();
  const sourceFor = (id: string, event: FoldEvent): FoldEvent => {
    const source = seenEvents.get(id); const target = event.capture.scope;
    if (!source || source.capture.scope.workspace !== target.workspace || source.capture.scope.creator !== undefined || (source.capture.scope.space !== undefined && source.capture.scope.space !== target.space)) throw new TaskEvidenceError("task evidence source is unavailable in target scope");
    return source;
  };
  const retainScope = (id: string, event: FoldEvent): void => {
    const scope = stable(event.capture.scope); const previous = scopes.get(id);
    if (previous !== undefined && previous !== scope) throw new TaskEvidenceError("workspace-global task evidence identity cannot change scope");
    scopes.set(id, scope);
  };
  const addTask = (task: TaskManifest, event: FoldEvent): void => {
    const key = taskVersionKey(task.taskId, task.taskVersion); const previous = tasks.get(key);
    retainScope(`task:${key}`, event);
    if (previous && stable(previous) !== stable(task)) throw new TaskEvidenceError("task specification or inputs changed under the same version");
    tasks.set(key, task);
  };
  const addAttempt = (attempt: AttemptManifest, event: FoldEvent): void => {
    retainScope(`attempt:${attempt.attemptId}`, event);
    if (!tasks.has(taskVersionKey(attempt.taskId, attempt.taskVersion))) throw new TaskEvidenceError("attempt task version is unavailable");
    if (attempt.parentAttemptId) {
      const parent = attempts.get(attempt.parentAttemptId);
      if (!parent || parent.taskId !== attempt.taskId || parent.attemptId === attempt.attemptId) throw new TaskEvidenceError("attempt parent is unavailable or cyclic");
    }
    const previous = attempts.get(attempt.attemptId);
    if (previous && (stable(attemptBaseline(previous)) !== stable(attemptBaseline(attempt)) ||
      (previous.finalRevision !== undefined && stable(previous.finalRevision) !== stable(attempt.finalRevision)) ||
      (previous.acceptance !== undefined && stable(previous.acceptance) !== stable(attempt.acceptance)))) throw new TaskEvidenceError("attempt baseline or final evidence changed");
    attempts.set(attempt.attemptId, attempt);
    if (attempt.acceptance) assertTaskAcceptanceSource(attempt.acceptance, sourceFor(attempt.acceptance.eventId, event));
  };
  for (const event of [...events].sort(compareEventKeys)) {
    for (const record of trajectoryLogRecordsFromEvent(event)) if (record.recordType === "trajectory" && record.trajectory.manifest) {
      const manifest = record.trajectory.manifest;
      if (record.trajectory.taskId !== manifest.task.taskId) throw new TaskEvidenceError("trajectory task differs from manifest");
      addTask(manifest.task, event); addAttempt(manifest.attempt, event);
    }
    for (const record of taskEvidenceRecordsFromEvent(event)) {
      if (record.recordType === "task-manifest") addTask(record.input, event);
      else if (record.recordType === "attempt-manifest") addAttempt(record.input, event);
      else {
        if (record.input.sourceEventId !== undefined) sourceFor(record.input.sourceEventId, event);
        const attempt = attempts.get(record.input.attemptId);
        if (!attempt || attempt.taskId !== record.input.taskId) throw new TaskEvidenceError("task evidence attempt is unavailable");
        if (record.input.revisionId !== undefined && record.input.revisionId !== attempt.startRevision.revisionId && record.input.revisionId !== attempt.finalRevision?.revisionId) throw new TaskEvidenceError("task evidence revision does not belong to attempt");
        if (record.recordType === "outcome" && record.input.acceptance?.criterionIds?.some((id) => !tasks.get(taskVersionKey(attempt.taskId, attempt.taskVersion))?.acceptanceCriteria?.some((criterion) => criterion.id === id))) throw new TaskEvidenceError("acceptance criterion is unavailable");
        if (record.recordType === "outcome" && record.input.acceptance) assertTaskAcceptanceSource(record.input.acceptance, sourceFor(record.input.acceptance.eventId, event));
        if (observations.has(record.input.id)) throw new TaskEvidenceError("task evidence identity already exists");
        observations.add(record.input.id);
      }
      records.push(record);
    }
    seenEvents.set(event.id, event);
  }
  return { tasks, attempts, records };
}
