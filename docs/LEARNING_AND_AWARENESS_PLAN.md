# Learning and organizational awareness

Status: active development. Authorized September 14, 2026.

## Active slice: semantic episodes and durable scheduling

Authorized September 15 after the verified transport checkpoint below. The
initial single-host episode contracts, native provider adapter, durable
scheduling, and inspection UI are implemented and targeted tests pass. Full
workspace build, typecheck, and test suite pass, including restricted-role
PostgreSQL integration. Final API checks pass 97 tests and the core safety
regressions pass; the final combined focused rerun and final full typecheck
rerun also pass.
A bounded real Gemini episode has now been published by the durable worker,
and automatic metadata-only windows are publishing. Source-window and semantic
citation desktop/mobile inspection both passed.
Checked items mean verified contracts or the explicit bounded example below,
not historical completeness or completion of organizational awareness.

### 2A. Evidence and publication

- [x] Publish atomic, versioned proposed episode windows with exact source-event
      coverage, canonical hashes, current assembled-memory snapshot digests,
      source reauthorization, immutable original project boundaries, and explicit
      grouping reasons, uncertainty, revisions, and continuation links.
- [x] Validate citations against retained transcript record ordinals/lines.
      Separate tasks may share a chunk when each has a unique cited record
      witness; additional common-background citations are allowed. Source-event
      coverage does not assert every conversation message was summarized.
- [x] Withhold stale, forgotten, inaccessible, or changed dependencies and
      reauthenticate membership after model execution before releasing results.

### 2B. Semantic production and scheduling

- [x] Implement configured native Gemini, Claude, or Codex structured transport
      for actual grouping. No extractive semantic fallback. Metadata-only or
      unresolved-project windows record explicit ungrouped coverage without a
      model invocation; these are not episodes or successful semantic synthesis.
- [x] Use authorized canonical transcript derivation records, typed checkpoints
      and checks, and current assembled memory accounts. Historical memory event
      anchors are provenance, not original conversation text; repeated anchors
      for one memory are correlated evidence. Raw-vault enrichment stays outside
      this policy boundary.
- [x] Persist count/elapsed/completion/capacity windows and prepared output before
      publication. Bound retry, preserve failed work, and recursively split
      oversized multi-source windows with explicit parent lineage. Oversized
      singletons remain blocked rather than truncated or silently discarded.
- [x] Bound source assembly to 8,000,000 raw UTF-8 bytes and model prompt/schema
      to 1,200,000 bytes, at most 200 source events per request. Full decoded
      selected records are retained; provider context fit is not guaranteed.
      Native episode calls have a finite 180-second timeout and 16,384-token
      output ceiling; synthesis client timeout includes post-provider checks.

### 2C. Human inspection and verification

- [x] Add cursor-paged Episodes and Source windows views, literal project/task
      labels, proposed status, explicit uncertainty, generated timestamps,
      source-event coverage, selected-context limitations, and revision history.
- [x] Drill directly into a cited authorized event and exact transcript locator;
      show readable retained content and memory accounts, with complete JSON
      secondary. No person attribution or work-duration claims inferred from
      generation/archive timestamps. Complete source events page one at a time;
      list/history pages contain up to 100 rows. Nested transcript bodies and
      full JSON render on demand. No Processing tab without a real backend.
- [x] Verify mocked-provider contracts, source-event coverage, shared-chunk
      locators, source/membership changes, retry/restart/split behavior, and scope
      isolation in targeted tests. Brain tests pass 41/41; synthesis/native
      transport tests passed with mocked providers; final API checks pass 97
      tests including safe failure diagnostics. Unit tests alone are not
      real-provider acceptance tests.
- [x] Complete the combined PostgreSQL-backed workspace test suite.
- [x] Rebuild and run API/core checks after final capacity/shared-citation safety
      amendments. The preceding full-workspace result predates those amendments.
- [x] Confirm the final combined focused rerun after the live diagnostic fixes:
      epistemic, SDK, API (97 tests), and worker (88 tests) passed.
- [x] Confirm the final full typecheck rerun; it exited successfully.
- [x] Verify desktop/mobile source-window browsing and source pagination against
      deployed current endpoints, without overflow at 1440px and 390px widths.
- [x] Finish browser inspection of the successful semantic episode and exact
      citation drilldown on desktop/mobile: 17 citation buttons, selected record
      3102 at retained line 6746, revision history 1/1, no overflow at 1440px or
      390px, and no browser page errors.
- [x] Run and inspect an explicitly approved bounded real-provider example,
      including cited retained content and durable publication/retry receipts.

### Bounded live verification

The normal worker published window
`f8c119044774a7e2ce89c77cfda19eaba0a277ec9368509467de14d4873ff26c`
with producer `gemini:gemini-flash-latest`, revision
`episode-window:ff639e3e4af80a8cf5712fef559fd46f42eb1d7c701963a06df6d1e7f2c646a5`.
One proposed episode, "Postgres Store Review and Deployment Inspection", was
derived from one explicitly chosen retained transcript chunk. Valid citations
include outer record/retained-line pairs `3102/6746` and `3105/6753`. Inspection
distinguished a failed missing-file lookup from commands that reported exit 0;
it did not turn all tool attempts into successful outcomes. Automatic 25-event
metadata windows also published as coverage records, not semantic episodes.
The normal worker was restored after the bounded diagnostic and repair.

Final operational sample: the API, capture daemon, and memory-worker LaunchAgents
were all running. The worker had zero active jobs, 918 completed receipts, and
zero pending sealed windows. Three open scheduler windows held 37 source events,
awaiting ordinary window triggers. Its cursor was `147889` against the sampled
head `147890` during ongoing intake; no cursor reset was required. These receipt
and window counts are operational observations, not proof that all historical
conversations have been summarized. The five unavailable source transcripts
remain explicitly unresolved.
The disposable PostgreSQL test/restore instance was stopped and removed after
successful tests and restore verification. The private backup remains retained;
only normal background services remain running.

The published record's generation timestamp indicates that an earlier retry may
have succeeded before the diagnostic pause. This validates durable real-provider
output and its read/citation validation under current code; it does not establish
that the final prompt amendment produced that particular output or fixed the
earlier unknown citation error. No extra model call was needed to demonstrate
the already persisted result. Prompt-version/invocation attribution is part of
the remaining model telemetry work below.

The first diagnostic returned Gemini HTTP 200 with finish reason `STOP`, but
failed canonical citation validation. Its raw response was not retained, so the
exact original citation constraint failure is unknown. The prompt now names
outer canonical locators and complete citation/member requirements, native
schema bounds match publication bounds, shared chunks permit common background
only with a unique record witness for each episode, and safe stage/constraint
diagnostics survive the API boundary. Canonical provenance checks were retained.
This successful example proves the chosen source-to-model-to-durable-publication
path, not comprehensive historical summarization, independent truth of all model
claims, or measured improvements in agent performance.

### Remaining Beyond This Slice

- [ ] Add full model-invocation telemetry: provider response ID, known token
      usage/cost, latency, retries/refusals, and retained invalid output under an
      explicit privacy policy. Producer/model/version and local job receipts
      are not complete evaluation provenance.
- [ ] Establish usefulness with reviewed episodes and controlled agent trials;
      source/output provenance alone does not demonstrate improved outcomes.
- [ ] Add distributed scheduling/processing visibility, policy-controlled raw
      artifact enrichment, verified people attribution, exhaustive historical
      episode backfill, automatic rebuilding of invalidated dependencies,
      reusable procedures, organizational answers, and new connectors.

Next implementation: prioritize usefulness evaluation and dependency rebuilding
before broader historical backfill; Phase 1B manual
identity reconciliation is already implemented, not the next implementation task.

Pre-rollout recovery evidence: private ignored backup
`.data/backups/pre-episodes-20260915.dump` is mode `0600`, 534,294,922 bytes,
SHA-256 `65db45e76b5f5dc3cdfeac4627e853736b2783fa79121d5af9a302255ced2a29`.
A real disposable restore matched all 146,096 local-history events through
sequence `146147`, including ordered event-ID hash
`6b1457d37a5127584e6a9e7325f0f067`. This verifies recovery, not episode usefulness.

## Previous transport checkpoint: September 15, 19:31 UTC

This checkpoint supersedes the intermediate rollout notes below. The local
ingestion-order transport repair, explicit migration/reset, pending-candidate
support consolidation, and historical transcript replay are implemented and
verified. Through fixed ingestion sequence `142188`, all 890 canonical unscoped
transcript-import source IDs have distinct completed `candidate-support-v2`
processing jobs: zero missing. The normal LaunchAgent is running again with its
original auto-promotion and cognition configuration. Its latest observed cursor
matched the current head at `143099`, with zero active jobs and 893 completed
receipts overall. This is scoped processing coverage, not a claim that every
observation is useful or that unavailable source data has been recovered.

The historical capture delivery backlog has drained; ongoing hooks can briefly
create new pending work. Five missing transcript source jobs remain retained
and unresolved. Semantic episodes, exact event/time scheduling, procedures,
organizational answers, connectors, usefulness evaluation, and accepted-memory
multiwriter evidence safety remain open. Earlier deferred migration/queueing and
partial replay counts below are historical checkpoints, not the current status.

## Product objective

Super Brain should turn evidence from AI workflows and organizational activity
into useful, scoped context for people and agents. It must support both learning
how to perform work and understanding the current state of work. A transcript
archive, a drawn decision tree, or a generated memory alone does not satisfy this
objective. A fast agent should be able to retrieve applicable procedures and
avoid previously observed mistakes; an authorized person should be able to ask
what someone worked on, what a project needs, and which goals remain unresolved.

```text
Source events and private artifacts
  -> people, projects, tasks, attempts, and time
  -> cited work episodes
  -> facts, decisions, procedures, project state, and proposed goals
  -> permission-filtered, task-relevant agent context and organizational answers
  -> actions, independently checked outcomes, corrections, and evaluation
```

This extends the existing Fold/PostgreSQL architecture. No new graph database,
queue service, or agent framework is required merely to begin this phase.

## Completion rules

- Access and applicability are independent. Organization/workspace/space and
  personal access checks always precede relevance selection and model input.
- Unresolved identity is not general applicability. A reusable procedure must
  be explicitly generalized; private source details do not become public.
- Raw evidence remains immutable. Groupings, summaries, identity corrections,
  applicability decisions, and status updates are attributable and versioned.
- Chronological adjacency is not causation. A successful task does not validate
  every hypothesis or prove a recorded path is transferable.
- Late arrivals, corrections, revoked access, and forgotten evidence must be
  reflected in derived knowledge. Missing data stays unknown, not failed work.
- No invented human judgment, completed task, provider result, or connector
  coverage. Proposed goals do not silently become assigned commitments.
- Each checked item needs implementation and verification evidence. Completion
  of a component is not completion of the end-to-end learning product.
- Preserve existing uncommitted work. No automatic live merges, promotions,
  external publication, or production deployment as part of a test.

## Phase 0: Discovery and contracts

- [x] Review architecture, tenancy, trajectory, memory, MCP, and existing roadmap.
- [x] Locate applicability defaults, candidate acceptance, query filters, worker
      deduplication, and misleading UI labels.
- [x] Finish identity/enrollment and existing task/episode contract inventory.

Allowed implementation patterns and source anchors:

- Memory contracts: `packages/fold-epistemic/src/types.ts`; event validation and
  serialization in `events.ts` and `candidates.ts`; replay in `project.ts`.
- Relevance filtering: `fold-epistemic/src/recall.ts:matchesFilters`, SDK
  `memoryCandidates`, and the API candidate-list pagination path. These all need
  consistent semantics; changing just the browser would not fix retrieval.
- Acceptance: SDK single and batch candidate acceptance explicitly construct
  memory inputs. New metadata must survive both paths.
- Worker: `TranscriptMemoryWorker.candidateKey`, `resolveCandidateProjects`,
  `processRun`, `watch`, and `synthesizeAcrossProjects`; preserve evidence and
  keep model proposals separate from acceptance.
- Agent interface: `apps/mcp-server/src/main.ts` registers search/context,
  proposal, checkpoint, and feedback tools. New proposed tools below are future
  contracts, not existing APIs.
- Tenant identity: `docs/MULTI_TENANCY.md` and
  `packages/fold-postgres/src/tenancy.ts`. Enrollment is not identity merging;
  remote URLs, paths, and email strings never confer authority.

Discovery findings to preserve across implementation sessions:

- `apps/importer/src/builder.ts:projectForRoot` hashes local-root versus remote
  identities differently. Transcript project replay rejects changed records;
  reconciliation must not change the historical hash algorithm or overwrite IDs.
- Enrollment remote normalization and importer identity hashing are different
  contracts. Enrollment does not currently feed capture/import resolution.
- Live capture stores the project ID in `capture.identity.repo` but the project
  name in `capture.identity.project`; imported transcripts use a project ID in
  the latter. Future grouping must normalize source-specific identity semantics.
- Existing Clerk bindings authenticate principals, not people represented in
  work evidence. Fleet sensors are not a verified human-to-agent relationship.
- Current comparison keys are explicit identifiers or normalized prompt hashes;
  they are not semantic episode grouping. Intention records are not a complete
  organization-level goal/ownership model.

## Phase 1: Identity and knowledge applicability

### 1A: Explicit applicability (first implementation slice)

- [x] Add `project`, `general`, and `unresolved` applicability to memory and
      candidate contracts, validated through API, events, and replay.
- [x] Preserve legacy event payloads. Derive legacy applicability as project
      when project IDs exist, otherwise unresolved; never infer general.
- [x] Require project applicability to have project IDs; general and unresolved
      have none. Original project evidence can remain in provenance references.
- [x] Project-filtered recall includes matching projects and explicit general
      knowledge, but excludes unresolved records. Unfiltered authorized review
      still exposes unresolved data; nothing is deleted.
- [x] Preserve applicability through single/batch acceptance and append-only
      memory revisions. Keep creator and access restrictions unchanged.
- [x] Apply identical filtering in SDK/API lists and lexical/semantic recall;
      prevent deduplication from merging general and unresolved candidates.
- [x] Expose truthful labels in Memory and explicit applicability on agent
      proposals. Project-independent means reusable within authorized access,
      not accessible across organizations.

Copy existing strict event/schema, replay, SDK acceptance, client request, and
Memory-page patterns. Verify old replay, invalid combinations, revision replay,
both acceptance paths, candidate pagination, project/global/unresolved recall,
private/space/tenant isolation, worker deduplication, and UI labels. Do not
silently bulk-reclassify existing memories or weaken authorization.

### 1B: Canonical identity and reconciliation

- [x] Represent people separately from agents, credentials, machines, and source
      accounts, with explicit attributable account/agent relationships.
- [x] Inventory possible project aliases using current normalized repository and
      path metadata; suggestions remain read-only. See [identity review](PROJECT_IDENTITY_REVIEW.md).
- [ ] Inventory ambiguous human/account ownership after defining person identity;
      repository aliases alone cannot establish who performed the work.
- [x] Add administrator-reviewed, versioned project aliases/reconciliation with
      previewed affected records, conflicts, and scope. Keep original IDs.
- [x] Define merge/split and revocation behavior; no implicit cross-tenant move.
- [x] Default MCP search/context to explicit or configured project IDs verified
      against current authorized metadata, with explicit broader discovery
      instead of accidental workspace-wide recall. Add paginated ID discovery.
- [ ] Automatically resolve verified task/person context from attributable
      source relationships; catalog membership alone is not task identity or
      proof of human ownership.

Copy enrollment administration and tenant audit patterns, not authentication
bindings as a substitute for business identity. Verify same-name projects,
remote/local aliases, worktrees, ambiguous actors, corrections, cross-tenant
denial, and unchanged original evidence. No live merge without a concrete preview.

## Phase 2: Durable episode formation and current knowledge

- [x] P0: replace the PostgreSQL subscription's source timestamp/event-ID cursor
      with an ingestion-sequence cursor. Migrate existing consumers explicitly
      and prove replay/idempotence for arbitrary late appends behind the old
      watermark. A durable processing spool protects received events only; it
      cannot recover events that the transport never delivers.
- [x] Persist independent transcript/live-extraction and synthesis jobs with
      saved pages before advancing subscriber progress in the local-vault
      single-host deployment. Retry without blocking unrelated extraction;
      expose waiting/retry/blocked/excluded coverage through the jobs CLI.
- [x] Extend durable local jobs to semantic episode preparation/publication with
      persisted windows, selected context, bounded retries, and split lineage.
      This initial single-host contract has targeted tests; live verification
      remains tracked separately in 2C above.
- [ ] Add deployable multi-host execution and dedicated processing/coverage UI.
      The private spool is not a distributed queue or server-wide dashboard.
- [x] Replace first-N candidate termination with bounded resumable processing
      that retains later conclusions, corrections, and supporting evidence.
- [x] Consolidate evidence from repeated same-summary proposals within pending
      work and a delivery batch without dropping later source references or
      turning contradictory observations into a single unsupported claim.
- [ ] Add additive support or compare-and-swap protection for already accepted
      memory evidence. Its read-modify-write revision can race independent
      writers and its evidence payload is capped at 1,000 references; these
      remain separate from the completed pending-candidate support ledger.
- [x] Define versioned proposed work episodes from retained task evidence with
      exact verified project scope, grouping reasons, uncertainty, and supported
      cross-window continuation/revision contracts. A session boundary or time
      gap alone is not a semantic task.
- [ ] Add verified people attribution and supported work-time semantics to
      episodes; generation/archive timestamps are not evidence of human labor.
- [x] Implement event-count, elapsed-time, completion, and capacity triggers with
      durable local scheduling, rather than hash sampling as an exact cadence.
- [x] Implement model-produced cited summaries, decisions, blockers, checks, and
      open-question proposals, with full source references separately retained.
      Actual live model behavior and usefulness remain unchecked in 2C.
- [x] Count newly ingested late events and withhold summaries whose source hashes,
      current memory snapshots, or access dependencies become invalid.
- [ ] Automatically rebuild invalidated summaries and reconcile all relevant
      prior episodes rather than only bounded selected continuation context.
- [x] Add inspectable episode/source-window views with cursor pagination.
- [ ] Add a genuine server-wide processing view backed by durable shared state.

Copy capture inbox/spool, worker subscriber, derivation manifest, and PostgreSQL
checkpoint patterns. Verify crash/restart, replay idempotence, missing artifacts,
model failure, long-session final correction, cross-session grouping, unrelated
simultaneous tasks, source revocation, and deterministic evidence coverage.

## Phase 3: Reusable procedures and the agent learning interface

- [ ] Separate task specifications and comparable attempts from observed traces;
      retain input/environment/tool/model versions and acceptance checks.
- [ ] Derive versioned procedure proposals with applicability, prerequisites,
      actions, branch conditions, verification, failure modes, and exceptions.
- [ ] Preserve supporting and counterexample attempts, outcome provenance,
      ambiguous mappings, and claims requiring confirmation.
- [ ] Provide bounded agent retrieval of applicable procedures and task context,
      with source links, currentness, cautions, and escalation conditions.
- [ ] Record exact context/procedure versions offered, injected, used, corrected,
      and associated with outcomes. Retrieval is not proof of adoption.
- [ ] Support controlled stronger-model distillation without treating that
      model's approval as independent success evidence.

Copy trajectory trees/assignments, retrospective outcome review, MCP tools, and
memory feedback contracts. Verify independently mapped attempts, unsupported
branches, changed environments, failed acceptance checks, stale procedures,
authorization, and exact context lineage. Do not infer causality from ordering.

## Phase 4: Organizational state, questions, and bounded autonomy

- [ ] Build cited current project/task state: owners, goals, progress, blockers,
      commitments, next actions, dependencies, and evidence freshness.
- [ ] Distinguish stated, inferred, proposed, committed, completed, and withdrawn
      goals/actions. Require policy or approval for consequential assignments.
- [ ] Answer person/day and project-status questions over episodes plus current
      state, respecting timezone, identity confidence, permissions, and coverage.
- [ ] Include what is unknown or stale. No observations is not no work; elapsed
      session time is not labor time; agent activity is not automatically human
      activity or a performance assessment.
- [ ] Add autonomous planning/execution only behind scoped tools, approvals,
      budgets, idempotency, cancellation, outcome checks, and audit evidence.

Copy Fold projections, intention lifecycle, authorization, reasoning-provider,
and review UI patterns. Verify late corrections, conflicting claims, reassigned
owners, unavailable sources, timezones, private work, denied actions, and bounded
execution. Do not advertise organizational omniscience from coding data alone.

## Phase 5: Additional connectors

- [ ] First integrate issue/task trackers and repository PR/CI/merge/revert
      evidence so task outcomes can be checked independently of agent claims.
- [ ] Add messaging, email, calendars, and life-operations sources as explicit
      independently deployable connectors, not assumptions about source access.
- [ ] Each connector defines native identity, permissions, historical backfill,
      incremental cursor, deduplication, edits/deletes, retries, retention,
      provenance, account attribution, and visible coverage/freshness.
- [ ] Keep personal life data outside organization access unless explicitly
      shared. Connector text remains untrusted data, never agent instructions.

Copy sensor/importer envelopes and durable delivery patterns. Verify repeated
pages, revoked source permission, deletions, incomplete sync, out-of-order edits,
and personal/organization isolation. External credentials remain deployment gates.

## Phase 6: Demonstrate usefulness and operate the product

- [ ] Freeze representative tasks and compare the same fast model under no
      memory, ordinary recall, and procedure-guided conditions.
- [ ] Measure acceptance correctness, time, known usage/cost, retries, and human
      intervention; use repeated trials and avoid evaluation-source leakage.
- [ ] Separately evaluate organizational answers against reviewed evidence and
      declared source coverage, including intentionally unanswerable questions.
- [ ] Publish only reviewed, permission-scoped evaluation bundles with hashes,
      exact versions, known exclusions, and reproducible scoring.
- [ ] Run full build/typecheck/tests, restricted-role PostgreSQL integration,
      UI checks, restart/recovery, and cross-tenant adversarial verification.
- [ ] Complete hosting, backup/restore, observability, secrets, retention, and
      license gates from the existing operations and tenancy backlogs.

Copy `docs/RETRIEVAL_EVALUATION.md`, `fold-eval`, and existing disposable-database
tests. Fixtures test software; only real controlled trials establish benefit.

## Relationship to existing work

`ARCHITECTURE_REMEDIATION_PLAN.md` remains the correctness/deployment dependency
ledger. Its durable jobs, task evidence, revision validity, and experiment work
must be reused here, not implemented as competing subsystems. Existing roadmap
entries marked complete describe local components, not this product milestone.

## Execution log

- September 15: Phase 1B manual identity/alias review and scoped MCP context,
  plus the first Phase 2 durable local extraction slice, are implemented and
  verified as detailed below. The local services have been restarted with the
  fixes; capture backlog drain and historical worker coverage remain open.
  The broader learning product and organizational-awareness phases are not done.

- September 14: vision and phased checklist recorded. Phase 0 discovery and
  Phase 1A are implemented and locally verified; the Phase 1B read-only project
  inventory is also available. Remaining checkboxes are not completed by this slice.
- Verification: full workspace build, typecheck, and test suites passed, including
  PostgreSQL integration using a disposable non-superuser, non-RLS-bypass role.
  Final worker changes additionally passed 27 tests, typecheck, and build.
  Independent review covered applicability, explicit reasoning filters, worker
  reclassification/deduplication, and private read-only identity reporting.
- Browser verification: existing memory applicability labels and new-memory
  Project/General/Unresolved controls checked on desktop; project IDs are required
  for Project and disabled otherwise. No live memory was created or revised.
  Mobile layout verification remains a follow-up for this form change.
- Read-only local inventory (`local/local-history`): 132 projects, 887 runs,
  11 needs-review alias pairs, zero conflicting pairs or unknown project
  references. Private report: `.data/project-identities-review-2026-09-14.json`
  (mode `0600`, not tracked). These are suggestions, not verified merges.
- Live recall enumerated all 20 pages: 1,967 accepted memories, all project-scoped,
  with none reclassified. API and capture health passed after local restart.
  Two pre-existing failed transcript jobs still reference missing source files;
  this phase does not resolve them or claim complete capture coverage.
- Historical next step at that checkpoint was Phase 1B identity reconciliation;
  it is now implemented and verified below. The current next step is integrated
  and bounded live verification of the initial Phase 2 episode slice at the top
  of this plan. The inventory never authorized automatic aliases, mass candidate
  acceptance, or generalization. Changes remain uncommitted pending scoped review.

### September 15 verification and rollout boundary

- People, source accounts, agents, and machines have separate, versioned identity
  records. Reviewed attribution and aliases preserve original source IDs, expose
  reasons/evidence/history, and require an authenticated human workspace admin.
  Generic ingress cannot forge identity revisions. Alias cycles, stale revision
  writes, restricted-source publication, and cross-tenant reads are rejected.
  Revocation splits resolution rather than deleting or rewriting source evidence.
- The Identities UI has cursor-paginated lists and selectors, name-first project
  previews, explicit apply/revoke confirmation, and a change history. An identity
  revision/scope change while paging clears the stale view rather than combining
  old fields with a newer write revision. Editing a preview invalidates it.
- MCP adds paginated `super_brain_projects` discovery. Search/context now require
  explicit or configured project IDs checked on every call, or deliberate
  `broaderDiscovery: true`. Unknown/denied metadata never triggers a broad fallback.
  Human attribution coverage and automatic task binding remain unchecked above.
- The worker saves replayable extraction pages and independent local jobs before
  acknowledging source progress. `--max-per-run` now bounds a page rather than
  discarding later candidate matches. Missing source data, blocked retries,
  excluded scopes, and policy changes remain explicit states. This does not close
  episode grouping, exact event/time scheduling, procedures, person/day answers,
  pending/in-batch evidence consolidation, connectors, or controlled evaluation.
- Verification: full workspace build/typecheck/test suites passed, including
  restricted-role PostgreSQL integration. Brain tests passed 36/36, MCP 16/16,
  and independent SDK identity review passed 4/4 targeted tests. Review identified
  and fixed restricted-project alias publication and mixed-revision UI page merges.
  Later capture/observability checks passed 61 tests; worker checks passed 48,
  including the cognition-policy regression. The disposable restricted-role
  PostgreSQL test instance was stopped and removed. The final full-workspace
  typecheck after the late changes also passed.
- Live UI review was read-only: new-person draft review, empty attribution/history,
  project selector pagination (133/133 over two pages), and the Super Brain alias
  preview (6 visible runs, 10 memories, 55 proposals). Updated previews show names
  above full IDs. Back-to-edit removed the apply control. Desktop and 390x844 CSS
  mobile screenshots were clean; all drafts were canceled and viewport overrides
  reset. No live identity, attribution, or alias was created. The prior memory
  form mobile-layout check also passed with no live memory write.
- Historical queue-backfill metadata dry run found 888 authorized eligible runs,
  zero metadata-unavailable/excluded runs, and queued zero jobs. It did not inspect
  retained artifacts or prove extraction completeness. Old consumer offsets do
  not retroactively schedule those runs; historical draining needs deliberate
  queueing with the watcher's exact scope, consumer, and policy. Queueing remains
  intentionally unapplied until capture catches up. An initial zero-active-job
  worker snapshot was not proof of historical processing completion. A later
  check confirmed the live worker advancing through recovered 01:49 chronology.
- Operational follow-up remains open: four unavailable transcript jobs had no
  supported identity-verified source/archive match in the recovery dry run.
  API, capture, and memory-worker services were restarted with the latest builds.
  Iterative depth-first traversal fixed the live 5,038-node tree stack overflow,
  and the previously blocking head job cleared. At `2026-09-15T17:54:22Z`, capture
  reported 17,679 pending jobs, with delivery counters showing 450 delivered and
  zero failures since restart at `17:50:58Z`. This follows the `17:51:44Z` sample
  of 17,893 pending and 157 delivered. The queue head advanced from the blocked
  01:27 job to 01:48. The new health delivery counters make subsequent failures
  observable. These counters do not erase the four unavailable transcript jobs
  or establish that the backlog is cleared. Continue monitoring drain progress
  before scheduling the historical worker migration. These samples show progress,
  not a guaranteed completion time.
- P0 transport follow-up: the existing PostgreSQL subscription uses source
  timestamp/event-ID ordering. An arbitrarily late append behind an advanced
  consumer watermark can still be missed, even though the current recovered
  chronology is advancing. Replace it with ingestion-sequence ordering and
  explicit consumer migration/replay tests before claiming lossless late-arrival
  delivery. The new durable job spool guarantees retention only after receipt.

### September 15 ingestion migration preparation

- The read-only `18:36:34Z` worker checkpoint was at source time `18:20:31Z`
  while capture was delivering records from `05:25Z`. This demonstrates the
  late-arrival exposure rather than merely a theoretical ordering risk. The
  local spool snapshot showed zero active jobs and two completed receipts;
  that is not proof that the skipped historical events were processed.
- At `18:37:05Z`, capture had 10,382 pending jobs, 8,328 delivered since restart,
  one delivery failure, and a head from `05:36:03Z`. The preceding sample had
  10,365 pending and 8,114 delivered. Delivery advanced while continuing intake
  grew the pending count, so these samples do not provide a completion ETA.
  Supported transcript recovery was rerun without confirmation: five matched,
  zero recovered, five unavailable. No identity-verified source/archive match
  was found, and all five failed jobs were retained. Historical queueing remains
  unapplied pending transport rollout and capture catch-up.
- A private, ignored pre-migration PostgreSQL dump was created at
  `.data/backups/pre-ingestion-20260915.dump` (507,326,106 bytes, mode `0600`),
  with a private SHA-256 sidecar. Full restore into disposable
  `super_brain_restore` passed. Its 128,921 `local/local-history` events through
  ingestion sequence `128972` matched the live prefix's ordered event-ID/sequence
  checksum (`019f43f1a00bbfbd439917099149f48d`). This proves this restore check,
  not scheduled or encrypted off-host backup coverage.
- The worker now exposes explicit `migrate-cursor` preview/confirmation before
  vault or model setup. Preview creates no spool; confirmation requires the
  existing exclusive spool claim and preserves legacy/existing ingestion
  offsets. It does not enqueue jobs: the watcher performs replay. The report
  includes authorized-kind high-water metadata; sequence distance is neither
  an event count nor completed extraction. Seven focused tests, worker
  typecheck, and worker build passed. Deployment migration and end-to-end replay
  verification are still pending at this checkpoint.

### September 15 transport rollout and repair checkpoint

- Capture now requests only the authorized current tree, not a full trajectory
  report. PostgreSQL-backed SDK reads reuse validated immutable event objects;
  bounded access-context caches extend only validated source-ordered prefixes.
  Late insertions replay the full history, and invalid retroactive tree revisions
  fail before append. Full source snapshots are retained. Cold/evicted-cache
  validation and cumulative snapshot storage still have costs. Independent review
  also fixed a shared SDK race where an append could incorrectly mark partial
  cached entries with another writer's newer revision.
- Live capture samples: `19:12:13Z` had 5,096 pending and 2,013 delivered since
  restart; `19:14:16Z` had 3,085 pending and 4,102 delivered, with zero new delivery
  failures. That interval delivered about 1,023 jobs/minute and reduced pending
  work by 2,011. API CPU point samples were 21.8% then 9.3%, with RSS about
  355 then 404 MiB, compared with a pre-rollout sample of 91% and approximately 2.57 GB.
  These are live observations under changing load, not a controlled benchmark.
  At `19:16:08Z`, capture had two pending jobs, 7,257 delivered and zero new
  delivery failures. Five unavailable transcript jobs remained unresolved.
- The initial ingestion migration preserved the legacy checkpoint and started
  from zero, but replay was stopped after discovering that PostgreSQL selected
  `sequence::text` and ordered by its text alias. This could skip numeric rows
  across digit boundaries. Initial cursor movement and approximately 96
  completed receipts are therefore not complete-replay evidence. Receipts remain
  intact; no source or completed work was deleted.
- Numeric ordering is corrected with more-than-1,200-row PostgreSQL and API
  enumeration coverage. A separate `reset-cursor` command previews an exact
  expected position and requires explicit confirmation, owner/admin access,
  the local exclusive spool claim, an atomic expected-cursor check, and an
  append-only reset audit. It preserves legacy offsets and processing receipts.
  All consumer instances must be stopped; a local claim is not a distributed
  generation fence. Worker tests passed 69/69, including reset refusal and
  receipt preservation, with worker build/typecheck passing. Corrected replay
  rollout and end-to-end processing coverage are still pending at this checkpoint.

### September 15 corrected replay in progress

- The numeric-order fix passed the combined workspace build/typecheck/test
  suites. With the consumer stopped, an explicit audited compare-and-set reset
  changed ingestion cursor `118883` to `0`, preserving all processing receipts.
  The same consumer resumed with its existing auto-promotion policy and
  continuous cognition temporarily disabled. The fixed replay target is
  ingestion sequence `142188`; ongoing ingestion can move the current head.
- Independent read-only samples: at `19:24:55Z`, the worker cursor was `10990`,
  with 406 pending jobs and 451 completed receipts. At `19:26:38Z`, its cursor
  was `29197`, with two pending jobs and 855 completed receipts. Completed
  receipts increased by 404 over about 103 seconds. Cursor sequence distance is
  not an event count, and the fixed target was not yet reached.
- Capture had zero pending delivery jobs at `19:26:38Z`, with 7,710 deliveries
  and zero new delivery failures since restart. Twelve newly received inbox
  hooks remained pending, with zero inbox failures. The five unavailable source
  transcripts were retained, so an empty delivery queue does not imply complete
  source recovery. API CPU was 18.4% with approximately 698 MiB RSS during replay.
- At the `19:25:33Z` source-ID audit, 890 canonical unscoped transcript-import
  events existed through the fixed target. New-policy jobs existed for 854:
  806 complete and 48 pending; 36 were not yet scheduled. Completion must be
  verified against all 890 exact source IDs after the transport target is
  reached, not inferred from the earlier defective replay or aggregate receipts.
  Normal service/cognition restoration remains the operator's next rollout step.

### September 15 final verification

- At `19:30:00Z`, exact source-ID comparison through fixed sequence `142188`
  found 890 canonical unscoped transcript-import events, 890 distinct new-policy
  jobs, and 890 completed jobs, with zero missing. All processing jobs totaled
  893, with zero active. The corrected cursor had reached `143018`, beyond the
  fixed target. Historical scheduling is therefore verified for this scope and
  cutoff; the earlier 888-run metadata-only queue preview is superseded by this
  source-ID-based replay check, not by manually marking jobs complete.
- The temporary cognition-disabled foreground replay was stopped. The original
  memory-worker LaunchAgent was restored with `watch`, the existing consumer,
  `--auto-promote`, and normal cognition. Independent verification at `19:31:18Z`
  found PID `19412` running, zero active jobs and 893 completed receipts; the
  final cursor sample matched the head at `143099`. The API was healthy and
  running, with a 4.2% CPU point sample and about 601 MiB RSS.
- Capture was idle at `19:31:32Z`, with 7,969 deliveries since restart, one
  pending delivery job and one pending inbox hook from ongoing intake. The
  delivery counter retained one retry-class failure at `19:29:21Z` during the
  API rollout; subsequent deliveries progressed. Five unavailable transcript
  sources remained failed and retained, with no supported recovery match.
  Those missing sources are not included in a claim of complete capture.
- Full workspace build, typecheck and test suites passed. Targeted totals
  include SDK 67 tests (eight cache regressions), client 31, worker 69, and API
  83 after immediate bounded backlog draining was added. PostgreSQL tests cover
  numeric sequencing across more than 1,200 rows, late appends, tenant/access
  boundaries, monotonic checkpoints, reset compare-and-set, and reset audit.
  Independent reviews covered cache ordering, concurrent append revisions,
  bounded SSE backpressure, batched/idle checkpoints and proposal support.
- Read-only UI checks showed proposal and memory views loading without an
  unavailable/error state: 919 proposals and 2,099 memory records, with the first
  100 memory records displayed. These counts are not an evaluation of memory
  accuracy or usefulness. No live identity aliases or attributions were applied.
- The disposable test/restore database container was stopped and removed. The
  private restore-verified backup and checksum remain retained. Only normal
  background services remain running; no temporary replay process remains.
