# Phase 3 attempt and evidence contracts

Status: implemented and independently reviewed. The full Phase 3 gate passed on Node 24.20.0 with disposable restricted PostgreSQL: 566 tests across 92 files and 21 packages, no skips, all typechecks and both builds. Verification used only the isolated remediation checkout and synthetic data.

The existing `TrajectoryInput` → strict schema → event factory → `RawTrajectory` → projection chain remains the transport for finalized attempts. Additive metadata must survive every link; adding an interface alone is insufficient. Old events keep absent metadata, unknown outcomes and their original source interpretation.

## Shared manifest shapes

Export these portable shapes from `fold-trace`, and re-export them from `fold-trajectory`. Keep references structurally compatible with `MemoryRevisionRef` without introducing a dependency from the trace primitives to epistemic projections. Runtime validation belongs beside the existing strict trajectory schemas.

```ts
interface TrajectoryArtifactRef {
  readonly artifactId: string;
  readonly kind: "task-spec" | "input" | "repository-snapshot" | "context" | "outcome";
  readonly sha256?: string;
  readonly byteLength?: number;
}

interface TaskManifest {
  readonly version: 1;
  readonly taskId: string;
  readonly taskVersion: string;
  readonly goal?: string;
  readonly acceptanceCriteria?: readonly {
    readonly id: string;
    readonly description?: string;
  }[];
  readonly specification?: TrajectoryArtifactRef;
  readonly inputs?: readonly TrajectoryArtifactRef[];
}

interface AttemptRevisionRef {
  readonly fingerprintStatus: "available" | "unavailable";
  readonly revisionId?: string;
  readonly commit?: string;
  readonly snapshot?: TrajectoryArtifactRef;
  readonly reconstruction?: "complete" | "partial" | "unavailable";
}

interface AttemptManifest {
  readonly version: 1;
  readonly attemptId: string;
  readonly taskId: string;
  readonly taskVersion: string;
  readonly parentAttemptId?: string;
  readonly conditionId?: string;
  readonly startedAt?: string;
  readonly startRevision: AttemptRevisionRef;
  readonly finalRevision?: AttemptRevisionRef;
  readonly context?: AttemptContext;
  readonly acceptance?: TaskAcceptanceRef;
}

interface AttemptContext {
  readonly memoryRefs?: readonly { readonly memoryId: string; readonly revision: number }[];
  readonly artifacts?: readonly TrajectoryArtifactRef[];
  readonly lineage?: readonly {
    readonly kind: "compaction" | "handoff";
    readonly eventId: string;
    readonly previousAttemptId?: string;
    readonly previousTurnId?: string;
    readonly artifact?: TrajectoryArtifactRef;
  }[];
}

interface TrajectoryManifest {
  readonly version: 1;
  readonly task: TaskManifest;
  readonly attempt: AttemptManifest;
}
```

Add optional `manifest?: TrajectoryManifest` to `TrajectoryInput`, `RawTrajectory` and `ProjectedTrajectory`. The top-level `taskId` must equal both manifest task IDs; task versions must agree. Capture finalization adds the final revision while retaining the original starting revision. Repeated observations must never replace the attempt's baseline. A parent must be an accessible attempt of this task, must precede the child, and must not create a cycle. The condition ID is an observed experimental condition, not an inferred causal claim.

`fingerprintStatus: "available"` requires a revision ID. Unavailable fingerprints must omit the revision ID and must not authorize revision-bound acceptance. `revisionId` is the public, privacy-projected identifier used in canonical joins. The private snapshot/receipt retains the original Git revision and the exact mapping to that public ID. A consented commit hash may be emitted separately; do not reconstruct a private source revision by parsing an opaque public ID.

Artifact references contain no local paths, raw patches, prompt bodies or credentials. Public hashes are optional and subject to the configured privacy projection; a private descriptor retains the integrity witness when it cannot be exposed. API validation establishes canonical source and tenant joins, but a newly declared private artifact reference does not prove those bytes exist. Reports distinguish reference-only metadata from local witness-verified availability; only the private storage verifier can assert the latter. Goal and criterion text are optional summaries governed by the same text policy as other canonical observations; exact originals belong in the private artifacts. Task versions bind immutable specification and inputs across comparison attempts. Missing goal, condition, specification, context or usage remains missing. No placeholder such as `unknown-model` counts as observed provenance.

## Per-turn runtime observations

Add optional `runtime?: TraceRuntimeObservation` and `context?: AttemptContext` to `TraceStep`. Preserve the existing model summary for compatibility; it must not overwrite more specific turn observations.

```ts
interface TraceRuntimeObservation {
  readonly provenance: "native" | "hook-reported" | "configured";
  readonly usageInterpretation?: "incremental" | "cumulative" | "unknown";
  readonly usageScope?: "request" | "turn" | "session" | "unknown";
  readonly providerId?: string;
  readonly modelId?: string;
  readonly modelVersion?: string;
  readonly harness?: { readonly id: string; readonly version?: string };
  readonly configurationId?: string;
  readonly settings?: {
    readonly temperature?: number;
    readonly topP?: number;
    readonly maxOutputTokens?: number;
    readonly reasoningEffort?: string;
  };
  readonly tools?: readonly { readonly name: string; readonly version?: string }[];
  readonly permissionMode?: string;
  readonly usage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly cachedInputTokens?: number;
    readonly reasoningTokens?: number;
    readonly durationMs?: number;
    readonly cost?: { readonly amount: number; readonly currency: string };
  };
}
```

Counts are finite nonnegative integers; durations and observed cost are finite nonnegative numbers. Zero means an observed zero. Cost is emitted only when the source reports it, with its currency. Settings are an allowlist, not a generic environment/configuration dump. Runtime identity comes from observed hook/native metadata and is distinguished from a model name guessed from a session label. Exact context references identify versions offered or injected into that attempt/turn; they do not assert that the model used them. Later feedback adds that distinction in Phase 4.

Usage scope and interpretation remain unknown unless established by the source protocol. Repeated cumulative or unknown updates are never summed as incremental usage. Capture attaches one hook's usage to one dedicated runtime observation step with its source event ID, rather than copying it onto every derived step. Ordinary steps may repeat identity/settings for context; that repetition is not additional usage.

## Typed acceptance, interventions and delayed outcomes

Keep acceptance separate from a trajectory's compatibility `outcome` label. Use append-only records so a delayed observation never overwrites the original finalized attempt. The same authorized attempt/revision joins apply to all sources.

```ts
interface TaskAcceptanceRef {
  readonly version: 1;
  readonly taskId: string;
  readonly attemptId: string;
  readonly revisionId: string;
  readonly verdict: "success" | "failure";
  readonly eventId: string;
  readonly artifactId: string;
  readonly criterionIds?: readonly string[];
}

interface TaskOutcomeInput {
  readonly version: 1;
  readonly id: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly revisionId: string;
  readonly kind: "check" | "pull-request" | "ci" | "merge" | "revert" | "acceptance";
  readonly result: "success" | "failure" | "unknown";
  readonly observedAt: string;
  readonly sourceEventId?: string;
  readonly source?: { readonly providerId: string; readonly deliveryId: string; readonly externalId?: string };
  readonly artifact?: TrajectoryArtifactRef;
  readonly acceptance?: TaskAcceptanceRef;
}

interface TaskInterventionInput {
  readonly version: 1;
  readonly id: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly revisionId?: string;
  readonly kind: "correction" | "constraint" | "rejection" | "approval";
  readonly observedAt: string;
  readonly sourceEventId: string;
  readonly artifact?: TrajectoryArtifactRef;
}

type TaskEvidenceAuthority =
  | { readonly kind: "human"; readonly principalId: string }
  | { readonly kind: "integration"; readonly integrationId: string };
```

`TaskEvidenceAuthority` is server-derived record metadata, excluded from public mutation inputs. Human authority comes from the authenticated human boundary; an ordinary agent credential cannot select it. Integration authority comes from a separately scoped credential and configured provider identity after source verification, never from hook agent labels, a payload's `author`, or a generic trajectory-write capability. Preserve the existing private local-operator witness as a distinct trusted local path. New API configuration must expose this distinction explicitly and fail closed when no suitable authority is configured.

Verified Clerk session tokens derive human authority from their resolved principal. Clerk API keys and M2M tokens never derive human authority from author metadata or scopes. Static credentials require explicit `taskEvidenceAuthority: {kind:"human"}` or `{kind:"integration",integrationId:"provider"}` configuration; default human-looking author metadata grants neither. Authority is included in static credential revalidation and cannot be mutated through the returned subject. Narrow capabilities are `task-outcomes:write` and `task-interventions:write`, independent of general trajectory writes. Space writes require writer/admin access.

External integration delivery uses `source:{providerId,deliveryId,externalId?}` instead of a preexisting `sourceEventId`. Exactly one source form is required. The authenticated integration ID must match the provider ID; the outcome record itself preserves that delivery's minimal canonical witness. The durable command receipt identity includes provider/delivery identity, so changed retries conflict. Human acceptance still requires a canonical source reference. An authenticated human statement is not private capture attestation, and a referenced event cannot lend it private witness status. No live provider webhook setup is part of these changes.

An acceptance reference must match an actual canonical capture-shaped human decision, or a previous authenticated human approval/rejection intervention with the same task, attempt, revision, artifact and verdict. An arbitrary accessible event cannot serve as the acceptance source. Phase 4 human UI can persist an approval intervention and then its acceptance outcome with separate stable stamps; partial completion retries these same commands without asking the user to approve twice. Display author metadata is separate from the resolved actor and configured evidence authority, and never grants the latter.

Check/CI success is evidence about a check. Merge/revert records are observations about repository state. They do not become task acceptance without an exact typed acceptance assertion from an allowed authority. A delayed success for revision A cannot make revision B successful. Multiple or contradictory observations remain visible; reports compute an evidence summary alongside the original outcome and identify the affected revisions. Acceptance criterion IDs must exist in the cited task version when provided.

SDK validation resolves task, attempt, revision, source event and artifact membership through the current authorized view, and enforces target audience/space containment as in Phase 2 memory evidence. A writer who can read a private or space-scoped source cannot copy it into a broader task. Event factories and replay validate the same actor, scope and authority attestation contract. Dedicated commands reserve these domain event kinds from generic append. Commands use the Phase 1 atomic revision/receipt boundary and exact stable stamps, so retries cannot create competing observations or lose attributed changes.

## Additive command and report ports

Use the existing client convention of an explicit leading stable stamp for trajectory commands. The proposed ports are:

```ts
recordTaskManifest(stamp, manifest: TaskManifest, options?: TrajectoryWriteOptions)
recordAttemptManifest(stamp, manifest: AttemptManifest, options?: TrajectoryWriteOptions)
recordTaskOutcome(stamp, input: TaskOutcomeInput, options?: TrajectoryWriteOptions)
recordTaskIntervention(stamp, input: TaskInterventionInput, options?: TrajectoryWriteOptions)
taskEvidence(taskId, options?: { limit?: number; cursor?: string })
```

`TrajectoryWriteOptions` retains the existing `spaceId` and `captureIdentity` options. The SDK receives the corresponding resolved event context before the stamp. Proposed tenant endpoints are `/trajectory-tasks/:taskId/manifests`, `/trajectory-tasks/:taskId/attempts`, `/trajectory-tasks/:taskId/outcomes`, `/trajectory-tasks/:taskId/interventions` and GET `/trajectory-tasks/:taskId/evidence`. Responses retain `{event, record}` for mutations and the existing opaque-cursor page convention for reports.

Proposed event kinds are `trajectory.task-manifest-recorded`, `trajectory.attempt-manifest-recorded`, `trajectory.outcome-recorded` and `trajectory.intervention-recorded`. Task versions and attempt IDs identify immutable records: changed content under the same identity conflicts. A finalized trajectory may enrich the attempt with final revision and turn runtime but must agree with the recorded baseline task version, starting revision, parent and condition. This avoids a mutable attempt row that silently alters historical context.

The namespace is workspace-global: `(taskId, taskVersion)` and `attemptId` retain their first canonical scope as well as their immutable contents. The atomic precommit projection uses the complete pinned workspace history, so disjoint space views cannot introduce conflicting identities. A human-readable task ID may have different explicit versions in different spaces; a viewer who can read both sees both versions. Reusing one version or attempt identity across scopes fails closed. A new scoped specification needs a new version identity.

A report exposes the exact manifests, trajectory IDs, attributed interventions and outcome records, with bounded pages (default 100, maximum 1,000). Manifest references, context lineage and acceptance criteria each have at most 100 entries. Large private inputs and repository state use artifact references and separate bounded storage. Apply explicit string/byte limits alongside the existing request body limit. Existing trajectory reports keep their current fields and add an evidence summary; absent evidence is represented explicitly without manufacturing history.

The evidence page returns a unified `items` array with `kind:"task"|"attempt"|"evidence"`, stable IDs, total and optional next cursor. Trajectory reports flag incompatible task versions or starting input revisions and suppress pooled comparative route statistics for those sets. Reports expose `projectionBasis` and authenticated-human `acceptanceSummary` separately from the original outcome label. Legacy parsed review text is labeled `legacy-self-reported`; absent independent oracle evidence has `availability:"unavailable"`, nullable confidence and no executions. A small UI compatibility change renders that confidence as Unknown; broader product work remains Phase 4.

## Finalized trajectory witness and structural mappings

Capture's encrypted completion receipt adds a digest witness for the exact normalized `TrajectoryInput`, caller capture identity and stable run stamp after privacy projection. The receipt also binds the private source revision to the public manifest revision. API-owned principal/workspace envelope fields remain API-owned. Verification parses the actual canonical trajectory record, reconstructs the intended command projection, and compares it to this witness; it must not hash a different shape or trust user-supplied envelope fields.

Worker checkpoint promotion requires all of: exact finalized trajectory witness; matching task, attempt and final public revision; an exact separately verified acceptance; and the cited checkpoint's membership in that trajectory. Copying a genuine acceptance event ID onto an arbitrary caller-authored trajectory is insufficient. Missing legacy witnesses leave the candidate pending. Existing owner/admin shared promotion authorization remains independently required.

Add optional `basis?: "structural" | "semantic"` to `ProjectionMethod`. Capture's automatic one-step-to-one-node mapping emits `basis: "structural"`; its confidence measures mapping determinism only. It cannot certify semantic equivalence or independent outcome validation. Existing manual/model/rule mappings, including ambiguous and unmapped assignments, remain available. Legacy methods with absent basis are unspecified and cannot be upgraded to semantic evidence by default. Reports distinguish structural coverage from semantic alignment when describing certainty.

## Repository snapshot and reinterpretation ownership

Capture owns private repository snapshots using NUL-delimited Git paths, exact binary bytes and executable modes, a starting commit, staged and unstaged binary patches, and allowed untracked files. Consent/exclusions and byte bounds are recorded in the private descriptor. Symlinks and paths outside the consented root are excluded. Only an actually complete, reconstructible descriptor can claim `reconstruction: "complete"`; a digest alone cannot. Verification restores a synthetic snapshot into a disposable checkout and compares tracked/untracked bytes and modes. No live corpus migration or restoration is authorized by implementation tests.

Transcript reinterpretation requires new immutable run/artifact/turn identities while preserving the original interpretation. The proposed additive `TranscriptRun.interpretation` metadata is `{version: 1, sourceOccurrenceId, sourceArtifactId, previousRunId, parser}`. Turn metadata additionally maps decoded raw-record ordinal ranges to the original source occurrence. The platform track owns transcript schema/event/projection and authorization joins; the processing track owns importer parsing/delivery and worker consumption. Coordinate this ownership before editing `fold-transcript`.

The SDK verifies that the previous run and original source artifact are accessible, contained in the target scope and refer to the same immutable source bytes. New IDs cannot merely assert source equivalence. Canonical citations retain the selected interpretation's actual run/turn IDs; evidence independence derives from the verified source occurrence and raw-record origin. Reprocessing one occurrence cannot increase corroboration counts. The explicit reinterpretation operation reports original/new IDs and what was recomputed, uses stable commands, and never mutates the original parser metadata or quietly runs as a live backfill.

The bounded `transcriptEvidenceOrigins(references)` client/SDK port resolves at most 100 actual event/run/turn citations through POST `/transcript-evidence-origins`. Results preserve each reference and return sourceOccurrenceId, optional descriptive recordRanges, independenceKey and verified. Here verified means canonical root/predecessor/source-byte metadata equivalence and access; it does not attest private byte ranges. Every original and reinterpretation conservatively shares `transcript-source-family-v1:<source>:<original SHA>` even when new ranges exist and the original lacks them. Caller-chosen artifact IDs and source-path hashes are excluded from this family key, so a renamed/copied alias import with the same immutable source hash cannot raise independent-source counts. This can collapse historically indistinguishable occurrences, and must not be described as precise per-record independence. Private local decoding may verify ranges separately. Live receipts retain their own occurrence identity; identical live payloads from distinct receipts remain distinct occurrences. All unique citations stay visible even when their independent-source count is one.

## Verification required before completion

The shared regression gate covers legacy replay; full manifest round trips through strict schemas, factories, public API and projection; immutable baseline conflicts and command retries; distinct start/final revisions; unavailable fingerprints; exact context scope containment; absent versus observed-zero usage; authenticated versus forged interventions/outcomes; delayed results and stale-revision acceptance; cross-space evidence denial; finalized witness and checkpoint tampering; and structural mappings that do not imply semantic validation. Snapshot tests reconstruct synthetic binary/tracked/untracked inputs. Reinterpretation tests preserve the original and show that repeated interpretations contribute only one source occurrence's evidence.
