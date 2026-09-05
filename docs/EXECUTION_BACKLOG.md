# Super Brain Execution Backlog

This backlog records the work required after the local vertical slice. It is
ordered by current data risk rather than feature novelty. An item is complete
only when its acceptance evidence is committed to this repository; a working
interface without its production dependency is recorded as ready, not complete.

Last audited: 2026-09-04.

## P0: Preserve The Dataset

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
