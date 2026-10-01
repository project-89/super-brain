import type { FoldEvent } from "@_89/fold";
import { rebuildMemories, rebuildMemoryCandidates } from "@_89/fold-epistemic";
import { canonicalProjectId, derivationHash, makeIdentityEvent, rebuildIdentities, rebuildTranscriptCatalog, resolveProjectIds, transcriptRecordsFromEvent, type IdentityProjection, type ProjectAliasInput } from "@_89/fold-transcript";

export function identitySnapshotFromEvents(events: readonly FoldEvent[], workspaceId: string) {
  const projection = rebuildIdentities(events);
  const catalog = rebuildTranscriptCatalog(events.filter(({ kind }) => ["transcript.project-recorded", "transcript.artifact-imported", "transcript.run-imported"].includes(kind)));
  return { projection, catalog, scope: { workspaceId, visibility: "workspace" as const } };
}

export function projectAliasPreview(events: readonly FoldEvent[], workspaceId: string, actorId: string, input: ProjectAliasInput) {
  const { projection, catalog, scope } = identitySnapshotFromEvents(events, workspaceId);
  const conflicts: string[] = [];
  if (!catalog.projects.has(input.aliasProjectId)) conflicts.push("Alias project is unavailable in this workspace");
  if (!catalog.projects.has(input.canonicalProjectId)) conflicts.push("Canonical project is unavailable in this workspace");
  const sharedProjects = new Set(events.filter((event) => event.kind === "transcript.project-recorded" && event.capture.scope.creator === undefined && event.capture.scope.space === undefined)
    .flatMap((event) => transcriptRecordsFromEvent(event).flatMap((record) => record.recordType === "project" ? [record.project.id] : [])));
  if ([input.aliasProjectId, input.canonicalProjectId].some((id) => catalog.projects.has(id) && !sharedProjects.has(id))) conflicts.push("Alias endpoints must be visible to the whole workspace");
  let next: IdentityProjection = projection;
  try {
    const t = Math.max(0, ...projection.history.map((record) => record.recordedAt)) + 1;
    const event = makeIdentityEvent({ workspaceId, principalId: actorId, author: { kind: "human", id: actorId } }, { t, worldDate: "2000-01-01" }, projection.revision, { kind: "project-alias", input });
    next = rebuildIdentities([...events, event]);
  } catch (error) { conflicts.push(error instanceof Error ? error.message : "Invalid alias decision"); }
  const beforeCanonicalProjectId = canonicalProjectId(projection, input.aliasProjectId);
  const afterCanonicalProjectId = canonicalProjectId(next, input.aliasProjectId);
  const projectIds = [...new Set([...resolveProjectIds(projection, [input.aliasProjectId, input.canonicalProjectId]), ...resolveProjectIds(next, [input.aliasProjectId, input.canonicalProjectId])])].sort();
  const affected = {
    projectIds,
    runs: [...catalog.runs.values()].filter((run) => (run.projectId !== undefined && projectIds.includes(run.projectId)) || run.segments.some((segment) => segment.projectId !== undefined && projectIds.includes(segment.projectId))).length,
    memories: [...rebuildMemories(events).memories.values()].filter((memory) => memory.projectIds.some((projectId) => projectIds.includes(projectId))).length,
    candidates: [...rebuildMemoryCandidates(events).candidates.values()].filter((candidate) => candidate.projectIds.some((projectId) => projectIds.includes(projectId))).length,
  };
  return { revision: projection.revision, scope, conflicts, affected, beforeCanonicalProjectId, afterCanonicalProjectId,
    previewToken: derivationHash({ workspaceId, actorId, input, events: events.map((event) => [event.id, derivationHash(event)]).sort(([a], [b]) => a! < b! ? -1 : a! > b! ? 1 : 0) }) };
}
