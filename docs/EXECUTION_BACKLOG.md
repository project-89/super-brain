# Super Brain Execution Backlog

This backlog records the work required after the local vertical slice. It is
ordered by current data risk rather than feature novelty. An item is complete
only when its acceptance evidence is committed to this repository; a working
interface without its production dependency is recorded as ready, not complete.

Last audited: 2026-09-15.

## Current Status

The initial single-host semantic episode and durable event/time scheduling
contracts are implemented, including proposed cited windows, native structured
model adapters, durable preparation/publication jobs, bounded retries/splits,
and paginated human-readable episode/source inspection. Targeted tests and full
workspace build/typecheck and the combined restricted-role PostgreSQL-backed
suite pass. Final API checks pass 97 tests and core safety regressions pass;
the final combined focused rerun passes (API 97, worker 88, plus epistemic/SDK).
The final full typecheck rerun also passes. A real
`gemini:gemini-flash-latest` episode from one explicitly chosen transcript chunk
was published by the durable worker, and automatic 25-event metadata coverage
windows also publish. Normal worker operation is restored. Desktop/mobile
source-window pagination and semantic citation drilldown both passed, including
record 3102/line 6746 and revision history. The successful publication may predate
the final prompt amendment, so no causal prompt-fix claim is made. The concrete
2A/2B/2C checklist and exact live provenance are in
[the phase plan](LEARNING_AND_AWARENESS_PLAN.md). Complete historical episode
coverage, full model-invocation telemetry, and usefulness trials remain open.

Latest operational sample: API, capture, and memory-worker services are running;
zero active jobs, 918 completed receipts, and zero pending sealed windows. Three
open windows hold 37 source events awaiting normal triggers. Cursor `147889` was
one sequence behind sampled head `147890` during ongoing intake, with no reset.
This is service health, not complete historical episode coverage.
The disposable PostgreSQL test/restore instance was stopped and removed after
verification; the private restore-verified backup remains retained.

The local P0 ingestion-order repair and historical replay are verified. Through
fixed sequence `142188`, all 890 canonical unscoped transcript-import source IDs
have matching completed new-policy jobs, with zero missing. Pending-candidate
evidence consolidation is implemented and verified. Normal background capture,
API, and memory-worker services are running; the worker's original cognition
and auto-promotion settings are restored. Its final cursor matched head `143099`,
with zero active jobs and 893 completed receipts overall.

The historical capture delivery backlog has drained, though new hooks continue
to arrive. Five unavailable transcript source jobs remain unresolved and retained.
Beyond the implemented initial episode/scheduling contracts, distributed
execution, automatic dependency rebuilding, verified people attribution,
exhaustive episode backfill, reusable procedures, org-level answers, connectors,
and usefulness evaluation remain open. Accepted-memory multiwriter evidence
safety and its 1,000-reference payload limit also remain open. The earlier
transport slice passed its full suite and its disposable infrastructure was
removed; the new episode pre-rollout backup is separately restore-verified.
See the current slice and dated verification in
[the phase log](LEARNING_AND_AWARENESS_PLAN.md).

## Historical Checkpoints

The following dated notes preserve the rollout sequence. Deferred migration,
uncleared backlog, and partial replay statements here are superseded by the
current status above; they are not additional unfinished migrations.

September 14 product phase: [Learning and organizational awareness](LEARNING_AND_AWARENESS_PLAN.md)
is the active phased checklist for scoped knowledge, identity reconciliation,
durable episodes, reusable procedures, organizational status, connectors, and
controlled usefulness evaluation. Explicit applicability is implemented and
locally verified; a read-only identity inventory found 11 possible alias pairs
across 132 projects. Reviewed reconciliation and person identity followed in the
September 15 slice below. Reuse
the existing architecture-remediation work rather than creating parallel systems.
Earlier component-complete labels do not mark this product phase complete.

September 15 execution: reviewed people/source identities, versioned project
aliases, their administrator UI, and explicit MCP project context are locally
implemented and verified. The worker now has durable single-host extraction/live
and synthesis jobs with replayable pages instead of a first-N-run cutoff. Full
build/typecheck/tests, restricted-role PostgreSQL integration, and read-only
desktop/mobile UI checks passed. No live identity merges or attributions were
applied. The [phase log](LEARNING_AND_AWARENESS_PLAN.md) records exact evidence.

This is not phase/product completion: ambiguous human ownership, automatic task
binding, pending/in-batch same-summary evidence consolidation, semantic episode
grouping, exact event/time scheduling, procedures, org-level status, connectors,
and controlled usefulness evaluation remain open. An 888-run historical queue
dry run read metadata only and queued nothing; its explicit migration remains
deferred until capture catches up. An initial zero-active-job worker snapshot
did not establish historical extraction coverage; a later check confirmed the
live worker advancing through recovered 01:49 chronology.

September 15 local rollout: API, capture, and memory-worker services restarted
with the latest builds. Iterative graph traversal fixed the live 5,038-node
stack overflow and cleared the previously blocking head job. The capture health
sample at `2026-09-15T17:54:22Z` reported 17,679 pending jobs and 450 delivered
with zero delivery failures since the `17:50:58Z` restart. The prior `17:51:44Z`
sample had 17,893 pending and 157 delivered; the queue head advanced from 01:27
to 01:48. Delivery counters now expose failures; the backlog is
not cleared, and four unavailable transcript jobs remain unresolved. Late capture
checks passed 61 tests and worker checks passed 48 including cognition policy.
The disposable PostgreSQL test instance was stopped and removed. Final full
workspace typecheck after these late changes passed. Drain is progressing, with
no guaranteed completion time.

September 15 migration preparation: the source-time consumer had advanced to
18:20 while capture was still delivering 05:25 records, confirming the P0
late-arrival exposure. A later read-only sample at `18:37:05Z` showed 10,382
pending, 8,328 delivered, and one delivery failure; continuing intake means no
completion ETA. Supported recovery dry run now finds five unavailable transcript
jobs and zero recoverable matches. A private mode-`0600` pre-migration dump and
checksum were created; full disposable restore passed and matched the live
128,921-event prefix through ingestion sequence `128972`. This is a verified
local recovery point, not off-host backup automation. Explicit worker
`migrate-cursor` preview/confirmation is implemented with exclusive-spool apply,
legacy-offset preservation, and authorized high-water reporting; seven focused
tests plus worker build/typecheck passed. Live migration/replay coverage remains
pending. Exact evidence is in the phase log above.

September 15 later rollout: validated current-tree reads and incremental
trajectory state removed repeated warm-history reconstruction. Capture delivered
2,089 jobs in roughly 123 seconds with zero new failures, and reached two pending
jobs at `19:16:08Z`; five unavailable transcripts remain. Initial ingestion replay
was paused after a text-alias sequence-ordering bug was discovered. Numeric
ordering and greater-than-1,200-row enumeration tests now cover that boundary;
an explicit audited, expected-cursor-guarded `reset-cursor` repair is implemented.
The initial replay cursor/receipts do not establish full coverage. Corrected
reset/replay verification remains pending at this checkpoint, and all consumer
instances must be stopped before reset because the local claim is not a
distributed generation fence.

September 9 data audit follow-up: [DATA_USEFULNESS_FOLLOWUP.md](DATA_USEFULNESS_FOLLOWUP.md)
tracks evidence repair, recall judgments, parser and outcome fidelity, incremental
state projection, and additional transcript sources. These data-quality gates
remain distinct from implementation-complete features below.

September 11 follow-up: the same document now records durable System checkpoints,
Gemini/Hermes archive adapters, and a read-only project-scoped retrieval evaluation
runner. Local performance and source-inventory evidence are recorded there.
[Retrieval evaluation](RETRIEVAL_EVALUATION.md) still requires human-reviewed
questions, expected evidence, and judgments; starter drafts are not validation.
These changes do not close hosted deployment, identity reconciliation, broader
architecture remediation, or the empirical evaluation milestone below.

## P0: Preserve The Dataset

### Deliver Arbitrarily Late Events

Status: implemented and locally verified September 15; production rollout remains
deployment-specific.

- PostgreSQL subscriptions use numeric ingestion order, independent of source
  timestamps, with bounded immediate backlog draining and SSE backpressure.
- Explicit migration preserves legacy offsets. Audited reset requires an exact
  current cursor and stopped consumers; repeated migration never rewinds.
- Late append, restart, numeric digit boundaries, authorization and replay
  tests passed. Exact local replay coverage is 890/890 source IDs through the
  fixed cutoff, with all associated new-policy jobs complete.

The spool is still single-host. Stop every instance before a reset: its local
claim is not a distributed generation fence. The five unavailable source files
and broader data-quality/evaluation work remain separate coverage limitations.

### Lossless long-session trajectories

Status: complete.

- Persist captured steps outside the frequently rewritten daemon state.
- Remove the 2,000-step loss boundary without creating unbounded state writes.
- Preserve stable step ordering across daemon restart and hook retry.
- Migrate existing retained steps and recover omitted steps from retained hook
  evidence where possible.
- Prove a session longer than 2,000 steps records every step and finalizes.

Acceptance evidence: durable per-session step journals and encrypted-hook
recovery tests preserve a 2,105-step session across restart and finalization.
The live daemon was migrated and currently reports zero truncated steps.

### Stable transcript handoff

Status: complete.

- Snapshot or redact a transcript while the source path still exists.
- Make delivery depend on a Super Brain-owned durable artifact, not a mutable
  harness path.
- Migrate or explicitly resolve every quarantined missing-path job.
- Prove source deletion after `SessionEnd` cannot prevent transcript delivery.

Acceptance evidence: deletion-race tests deliver from a daemon-owned redacted
snapshot after the source disappears. All three historical missing-source jobs
were explicitly archived with an audit reason; the live failed spool is empty.

### Reliable session finalization

Status: complete.

- Finalize explicit session ends exactly once.
- Retain timeout finalization as `unknown`, never inferred success or failure.
- Bound long-lived sessions into lossless evaluation units without counting
  chunks as independent model runs.
- Expose incomplete and finalization-age diagnostics.

Acceptance evidence: prompt-to-response evaluation units finalize on `Stop`,
retain unknown timeout/orphan outcomes, deduplicate exact hook retries, and
backfill retained sessions idempotently. The live finalized-unit count increased
from 3 to 30 while long-lived CLI sessions remained open.

## P1: Close The Learning And Evaluation Loop

### Empirical evaluation corpus

Status: in progress; 66 finalized units are live and the volume threshold is met.

- Produce at least 50 finalized, annotated trajectories.
- Run at least one comparable task through two materially different models.
- Preserve mapped, ambiguous, and unmapped projection assignments.
- Record command/human outcomes, first divergence, downstream consequences,
  coverage, and efficiency without treating absent evidence as failure.
- Export a reproducible sponsor/evaluation dataset with provenance.

### Feedback and steering adoption

Status: implementation complete; live adoption evidence accumulating.

- Make every harness report recalled-memory use and helpful, unhelpful, or
  superseded outcomes.
- Connect operator steering actions to subsequent sessions and outcomes.
- Surface feedback coverage and stale/unvalidated memories in Brain.

### Continuous cognition

Status: implementation complete; live local Gemini validation complete and
hosted provider deployment pending.

- Add a durable worker that consumes canonical events and proposes cited
  cross-project synthesis, contradiction, procedure, and investigation records.
- Keep model output proposed until evidence or policy promotes it.
- Add a real model-provider port with timeouts, budgets, provenance, and
  deterministic test doubles; do not label extractive output as model reasoning.
- Add optional semantic embeddings and prove authorization before and after
  ranking.

Acceptance evidence: replayable worker and HTTP provider contract tests pass.
The worker creates only reviewable, canonically cited cross-project proposals
and skips honestly when the configured provider is extractive. The local
deployment has produced a real Gemini-backed `continuous-cognition` proposal
from an explicit authorization-checked, project-diverse evidence set.

## P2: Hosted Multi-Tenant Product

### Identity and tenant control plane

Status: implementation complete; Clerk environment provisioning pending.

- Add Clerk sign-in, sign-out, organization selection, and token delivery to
  Brain.
- Replace restart-loaded bindings with signed webhook or authenticated admin
  provisioning.
- Provision, scope, rotate, and revoke one API key or M2M identity per sensor or
  harness.
- Make organization creation, membership change, and deletion idempotent and
  auditable.

Acceptance evidence: Brain conditionally provides Clerk sign-in, sign-out,
active organization switching, server-derived workspace selection, and
in-memory token refresh. Signed webhook deliveries transactionally provision,
deduplicate, audit, and revoke organization/user membership. Organization
admins can provision and revoke deterministic workspace-scoped API-key or M2M
identities. API and restricted-role PostgreSQL tests cover these paths.

### Production isolation

Status: application and CI topology complete; deployment pending.

- Run the API with a non-superuser, non-`BYPASSRLS` PostgreSQL role and
  `FOLD_REQUIRE_TENANT_RLS=true`.
- Provision a private quarantine workspace and require explicit repository
  enrollment before normal routing.
- Namespace remote artifact objects and KMS keys by organization/workspace.
- Exercise hostile tenant, cache, cursor, worker, vector, artifact, and support
  access tests in the deployed topology.

### Production operations

Status: local tooling complete; external deployment pending.

- Add TLS termination, distributed rate limiting, health/readiness probes,
  metrics, structured logs, traces, and alerts.
- Schedule PostgreSQL backups, retain an encrypted off-host copy, and alert on
  backup age and restore-verification failure.
- Add multi-host failover and recovery actuation only through authenticated,
  audited real operations.

## P3: Public Repository And Release Discipline

Status: complete except owner license selection.

- Correct public/private documentation and add contribution/security guidance.
- Select a license for the new Fold and Super Brain packages. Until the owner
  decides, they remain `UNLICENSED` despite the public repository.
- Add GitHub Actions for install, build, typecheck, tests, secret scanning, and
  dependency review.
- Add release/versioning policy and publish only packages whose ownership and
  dependency licenses are verified.

Acceptance evidence: CI verifies build/typecheck/tests, exercises pgvector and
forced RLS with a restricted PostgreSQL role, scans full Git history with a
checksum-pinned Gitleaks binary, and reviews pull-request dependencies. Security,
contribution, Dependabot, and release policies are committed. Local Gitleaks
history and pending-source scans report no findings.

## Current Evidence Baseline

At the 2026-09-04 audit the local workspace contained 23,588 canonical events,
71 projects, 760 imported runs, 2,498 memory candidates, 1,967 accepted
memories, 118 tree snapshots, and 3 finalized trajectories. It contained no
memory-feedback or steering events. The capture daemon reported active event
flow, three quarantined missing-transcript jobs, and long sessions beyond the
old 2,000-step boundary.

These counts are evidence of a substantial local corpus, not completion of the
evaluation or hosted-product milestones.

## Current Live Progress

At the 2026-09-04 release-readiness check, capture reported more than 12,000
received hooks, 66 finalized prompt-to-response units, zero truncated steps,
zero failed jobs, and an empty delivery spool. The memory worker was caught up
to the newest subscribed event and produced a live, cited, cross-project
proposal through Gemini. No production Clerk, embedding, object-storage, TLS,
monitoring, or scheduled off-host backup environment is configured by this
repository checkout.
