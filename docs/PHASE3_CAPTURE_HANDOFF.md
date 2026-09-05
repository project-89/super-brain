# Phase 3 capture handoff

Capture sources live in `apps/capture-daemon`; shared trace/trajectory domain
contracts are owned by the platform track. No live services, configuration or
private corpus were changed by this work.

## Consumer contract

`createCapturedTrajectoryVerifier(options): (event: FoldEvent) => Promise<boolean>`
is exported from the capture package. Options are `stateRoot`, optional
`receiptEncryptionKey`, `trustedSensorId`, `organizationId`, and `workspaceId`.
The existing worker `CaptureAuthorityOptions` is structurally compatible.
Missing keys, legacy witnesses, mismatched tenant/sensor, changed input, added
identity fields, changed stable stamp and incorrect revision bindings fail closed.

The protected receiver completion record contains
`trajectoryWitnesses[eventId] = {digest, privateRevisionBinding}`. The digest
normalizes `TrajectoryInput` through the shared strict schema and hashes
`{input, captureIdentity, runStamp}` using the same stable serializer as event
witnesses. `runStamp` contains `id`, `t`, and `worldDate`. Verification reconstructs
input from the canonical trajectory plus its assignments/reviewText and removes
only API-owned `principal`/`workspace` from caller capture identity. Record actor,
workspace, scope, timestamp, participants, and nested capture envelope must agree.
Capture currently publishes workspace scope; a different space cannot borrow the
witness. The protected receipt tenant includes the actual configured sensor ID.

`manifest.attempt.acceptance` is an exact `TaskAcceptanceRef`, included only when
its task, attempt and revision match finalization. It points to the canonical
human-decision event and its private artifact. The worker separately verifies
that event and the exact checkpoint, then checks task/attempt/final revision and
checkpoint membership/content. The finalized witness alone does not establish
human acceptance, and an acceptance witness alone cannot endorse arbitrary
checkpoint content.

New canonical acceptance revisions and manifest revisions share
`revision:<privacy-projected digest of original repositoryRevisionId>`. The
original Git/worktree fingerprint stays in private state/snapshot/receipt binding.
`engine.acceptanceContext(source, sessionId)` and the operator-authenticated
`GET /acceptance-context?source=...&sessionId=...` return current public IDs.
Local legacy private-fingerprint submissions are translated before publication.
Old immutable events are unchanged and are never implicitly upgraded.

## Storage and reconstruction

`captureRepositorySnapshot(config, project, identity)` returns explicit
complete/partial/unavailable coverage and an optional opaque artifact reference.
`readRepositorySnapshot` verifies bounded authenticated encryption and descriptor
integrity. `reconstructRepositorySnapshot` creates only a new separate checkout,
requires the base commit in an explicitly supplied source repository, restores
index/worktree overlays, and verifies the resulting private revision fingerprint.

The policy defaults to metadata-only and requires explicit roots, bytes/files,
untracked/binary consent and encryption to capture file bodies. NUL parsing uses
Buffers; private descriptors encode paths/bytes only after source redaction.
Staged and unstaged binary patches are supplemental, bounded, and retained only
after original base/index/worktree bytes are checked. Partial snapshots omit
patches. Unsupported base/index modes, hidden tracked files, checkout transforms,
private storage/key paths (including symlink aliases), size limits and races
cannot claim complete reconstruction. Ignored files and external dependencies
are outside the explicitly documented Git-overlay scope.

`readBoundedPrivateText` bounds allocation/actual reads, rejects nonregular files
and final symlinks, uses nonblocking opens, and verifies file identity/stability.
Canonical-reference receipt and hook readers use it and require authenticated
`.enc` envelopes. Missing/corrupt private evidence denies trust.

## Runtime interpretation

Runtime provenance is native or hook-reported according to the actual ingress,
never a caller-selected authority field. Settings/tools/provider/model are
allowlisted; missing/invalid optional values stay absent. Each hook contributes
at most one usage observation even when it generates multiple tool/check steps.
Native records contribute dedicated observations. `usageInterpretation` and
`usageScope` are currently unknown; no inferred token totals or prices are
created. Exact memory revision zero is retained. Context means offered/injected,
not proven use. Compaction/handoff lineage preserves the canonical boundary event.

## Independent review

The capture track reported a missing canonical source join for delayed acceptance
outcomes in the platform SDK. The platform added a common source validator to
command validation and replay. Human/integration authority is explicitly derived
from configured credentials independently of author display metadata; private
witness verification remains a separate stronger claim. The worker track found
and capture fixed symlink-parent restoration, canonical private-root exclusion,
bounded private reads, and hidden tracked changes retaining prior acceptance.
Final verification counts are recorded in the coordinator's Phase 3 gate.
