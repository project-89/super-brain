# Architectural remediation implementation plan

Authorization: user requested addressing all findings in the September 4 architectural assessment. Baseline `eda5604e6e1d06465dac5e1b914c531c96b15031`; implementation branch `codex/address-architectural-findings`. This plan is executed, not merely proposed. Status and verification evidence are updated as phases complete.

## Scope and completion contract

Address all concrete findings and the high-value mechanisms in `PATHFINDER-2026-09-04/05-assessment.md` and the six handoffs. Preserve the event-sourced architecture and existing private evidence boundaries. Repository work includes migrations, code, tests, operator flows, deployment/recovery tooling, and an empirical comparison if authorized local model runtimes are available. A fixture must never be substituted for an empirical result.

Select a supported initial topology: PostgreSQL-backed API with local-vault workers, scoped per-machine credentials, and a small enrolled-repository pilot. Prepare a concrete hosted deployment configuration and gate. Actual external account provisioning, domain/TLS activation, off-host backup destination, and owner license selection require real configuration/decisions; finish all independent implementation and local drills before presenting any remaining decision. Do not publish packages, transmit private evaluation data or mutate the live corpus as a test.

## Phase 0 — documentation discovery (complete)

Three discovery agents read the assessment, package READMEs, actual source signatures and test patterns. Their contracts establish:

- `FoldSdkStore` at `packages/fold-sdk/src/types.ts:46–60` has `read`, `append`, optional `appendMany`, optional `revision`. Add atomic commit capability compatibly. `FoldSdkCursor` remains a canonical replay/fork position; delivery gets a separate versioned position.
- PostgreSQL `sequence` already exists and append/import allocate it under the same tenant advisory lock (`packages/fold-postgres/src/store.ts:140–151,424–476`). Copy that transaction/RLS pattern for expected-revision command commits and durable command receipts. Compare the snapshot used for domain validation, not a later refreshed snapshot. Preserve bigint positions as decimal strings.
- Existing auth/membership ports (`apps/api/src/types.ts:63–77`) support revalidating stream access. Copy ephemeral API tests (`apps/api/test/helpers.ts:80–101`) and restricted PostgreSQL setup from `.github/workflows/ci.yml:32–72`.
- `CaptureEngine.ingest` (`capture.ts:430`) currently serializes slow work. `HookVault.store` and private atomic writes (`storage.ts:46–98,399–432`) are the receipt durability patterns. Artifact content hashes are not occurrence identities. Keep source-native event identity distinct from receipt/delivery identity.
- `TranscriptBuilder.startTurn` (`apps/importer/src/builder.ts:155–181`) and worker native parsing must share a source normalizer exported by importer. Both consumers already depend on importer. Keep canonical metadata and private text projections separate.
- Extending a trajectory requires types, strict schema and explicit event copying (`fold-trace/src/types.ts`, `fold-trajectory/src/schema.ts`, `events.ts:113`), plus client/UI representation. Existing independent shared-tree fixtures are in `fold-trajectory/test/trajectory.test.ts:33–139`.
- Shared memory revision requires changes to command authorization AND replay authority (`fold-epistemic/access.ts:56–74`, `project.ts:36–42`, `events.ts:308–377`). Historical creator attribution must remain. Candidate evidence is bounded at 100, memory evidence at 1,000; revision starts at zero. New schemas need honest legacy defaults.
- Existing client is browser-safe and can become the canonical transport (`super-brain-client/src/index.ts:208`); Brain still owns connection preferences, token refresh, cancellation and loopback operator artifacts. Feedback must have its own narrow permission and never cause a successful read to fail.
- Docker is running locally; use a disposable `pgvector/pgvector:pg17` container with a restricted role and isolated host port. Never point tests at live `FOLD_DATABASE_URL`.

## Phase 1 — foundational correctness and evidence integrity (verified)

Independent implementation tracks have disjoint file ownership:

1. **Platform:** SDK/store/API/client delivery contract. Single internal batch commit; expected-revision validation; stable command retry result; exact cache revision; versioned ingestion cursor and old-offset replay migration; single-flight journal registry and honest atomic-batch contract; revalidated/capped/backpressure-aware SSE; stale identity webhook protection. Owner reserves SDK, PostgreSQL store/tenancy, API auth/types/registry/server, client cursor methods.
2. **Capture:** shared pure hook interpretation, explicit success/failure/unknown, check versus task acceptance, server-attested human authority, no silence-derived offline; encrypted/redacted sender receipts and fast durable receiver acknowledgement with recovery; shared native record/turn normalizer and importer failure/unknown preservation. Owner reserves capture daemon, importer and transcript package; no worker/MCP/API edits without handoff.
3. **Test environment:** disposable PostgreSQL/pgvector runner and restricted-role test harness. Reserve new scripts/integration fixtures, not existing source owned by the first two tracks. Establish real two-process integration test capability.

Copy source patterns from Phase 0. Add regressions for missing result; unrelated checks; forged human labels through all ingress; repeated identical occurrences versus retries; downtime, slow processing and lost acknowledgement; live/recovery parity; matching transcript turn IDs; delayed events after a newer cursor; concurrent acceptance/retry and snapshot interleaving; live revocation; concurrent first journal access. Verify old canonical replay/fork behavior is unchanged. No helper-only fix that leaves precommit validation outside CAS. No reinterpretation of old cursor fields.

Verification: full `pnpm verify` passed under Node **24.20.0**, using the disposable restricted PostgreSQL 17 role: **487 tests across 79 files**, all workspace typechecks and both verification builds passed. This includes 15 PostgreSQL store/tenancy tests and seven real two-process API regressions. Capture's 44 and importer's 23 tests passed, including recovery and immutable parser migration. Independent platform/capture cross-review and test-environment review were completed; actionable findings were fixed and reproduced regressions verified. See `PHASE1_CAPTURE_HANDOFF.md` and `DISPOSABLE_POSTGRES_TESTS.md` for contracts and reproduction. The original checkout remains on `main`, with its running binaries untouched.

## Phase 2 — memory completion, authority and validity

Depend on Phase 1 contracts. One scope-aware consolidation policy merges distinct support before scheduling bounded proposals; do not discard later correction because the first 25 matched. Use shared native identities and selected result/verification evidence. Persist artifact/turn/extractor-version jobs before advancing transport progress, reconcile missing artifacts, expose completed/waiting/retry/excluded coverage. Give synthesis a separate durable evidence-revision/prompt/provider job identity and bounded retries, using currently authorized active memory.

Add attributable shared contributions/corrections while preserving personal creator control. Add source memory revisions, supersession/contradiction/currentness, dependent-synthesis invalidation and explicit unresolved versus global applicability. Resolve candidate evidence references through authorization, and make promotion require attested evidence, not labels/XML formatting/fixed confidence alone. Update schemas, event factories, API/client and replay together.

Patterns: worker `processRun/watch`, source-enveloped memory events, candidate batch handling, and existing encrypted vault tests. Verification: late artifact appears after restart; one failed model job does not halt extraction; long-session final correction retained; pending/in-batch evidence preserved; scopes do not collide; human acceptance then worker support; human correction of shared machine-owned memory; forgotten/revised dependency invalidation; deterministic job replay and bad citations rejected. No extra queue service, scope broadening or implicit truth promotion.

## Phase 3 — task evidence and reproducible attempt data

Add a backward-compatible versioned task/attempt manifest and event path: goal/acceptance specification, task version/input state, attempt/parent/condition, starting commit and consent-scoped dirty patch/untracked artifact references, fingerprint availability, per-turn provider/model/settings/tool/runtime/config metadata, available usage/time/cost, exact memory/context revisions and compaction/handoff lineage. Capture typed authenticated human interventions and delayed check/PR/CI/merge/revert outcomes through an authenticated integration boundary, linked to attempt/revision.

Use existing trajectory types/schema/factory and private artifact storage; preserve old events without inventing missing fields. Mark automatic trace self-mapping as structural; keep independent manual/model/rule assignments with ambiguity/unmapped support. Record specific acceptance evidence separately from outcome labels and expose task evidence reports.

Verification: old trajectory replay; every manifest field survives event construction; unknown remains explicit; starting and ending revisions differ correctly; untracked content and Git failure handling; symlink/out-of-scope artifacts excluded; correction/intervention/outcome attribution; cost absent rather than invented; mappings do not self-certify semantic equivalence. Keep private text and patches out of canonical storage.

## Phase 4 — shared client, feedback, context and operator product

Extend the existing canonical client with cancellation/deadlines, token delivery, pagination, typed errors/retry hints, relevant operations and stable stamps. Brain delegates canonical calls while retaining local operator artifact access. Give feedback narrow permission, stable recall/batch identities, exact memory revision/rank/provider/task/attempt/session joins and offered/injected/used/judged/outcome states. Persist/retry optional telemetry independently of successful reads; share transport error policy while preserving distinct import/spool/subscriber state machines.

Provide bounded project/task context through MCP and an explicit completion/correction flow. Distinguish steering delivery from adoption. Add a task evidence page using Phase 3 records, permission-aware memory evidence links and correction controls, and operator processing/value coverage with lag/failure/retry/exclusion. Replace misleading validated/100%-confidence labels with accurate judgment/relevance terms. Apply current project/revision validity and feedback to review/retrieval without treating votes as truth.

Patterns: existing Brain pages/components, `SuperBrainClient`, MCP tool registration, feedback Fold events. Verification: read-only MCP works when feedback is forbidden; failed telemetry does not fail recall; retries dedup; exact revision joins; token refresh and browser abort; operator token never reaches hosted API; task context bounded and current; UI task/evidence/processing/correction flows inspected in browser. No unrelated UI redesign or new agent framework.

## Phase 5 — empirical evaluation and selected export

Build an independent frozen-task specification/tree, runnable model-attempt harness, acceptance checks and annotation format using `fold-trace`, `fold-trajectory`, and `fold-eval`. Execute two materially different real available providers from the same input state, retain outputs/observed action evidence, and report exact provenance, verification, ambiguity, intervention, timing and known usage. A fixture is only a fixture. Include a retrieval/use benchmark with no-memory versus memory conditions where repeatable; do not infer causality from a single uncontrolled example.

Implement a selected evaluation exporter with explicit audience/permission/redaction review, task/input/model/oracle/annotation versions, declared exclusions, data dictionary, content hashes and deterministic report regeneration. Exclude private paths/keys/artifacts by default; never repurpose the private backup exporter. Add source-revision and publication eligibility checks; keep selection/approval reviewable before any external sharing.

Verification: bundle is deterministic and self-verifies; no secrets/private keys; denied or stale evidence excluded; unknown annotations preserved; report regenerates; real run evidence distinguished from synthetic tests. Record any unavailable external provider as an explicit remaining dependency rather than claiming the comparison passed.

## Phase 6 — operated deployment, bounded projections and recovery

Add meaningful liveness/readiness, dependency/processing metrics and structured diagnostics, tenant/principal budgets and stream bounds. Benchmark cold start, RSS, append/retrieval p95 and capture-to-recall lag at representative history volume. Wire bounded paged reads/cache eviction and version/configuration/ingestion-aware durable projections; late-arrival correctness must match full replay. Move embedding refresh out of serialized request-critical work, add bounded sidecar calls and verify current digest/revision filtering. Preserve lexical default unless measured retrieval warrants semantics.

Provide a concrete reproducible PostgreSQL-backed pilot/hosted topology and migration/rollback runbook, scoped identity/enrollment/quarantine, explicit local-worker artifact placement, TLS/reverse proxy and backup scheduling configuration. Build a database-plus-artifact/key-version recovery manifest and encrypted off-host-capable backup workflow. Restore only into a disposable environment and verify canonical replay, restricted role/tenant isolation, consumer resumption and cited artifact decryption. Validate deployed-equivalent two-process and hostile access paths. External destinations/keys/license choices must remain honest gates until actually supplied and operated.

Patterns: current Docker CI service, tenant RLS initialization, projection checkpoint persistence, scripts/backup-postgres.sh and verify-postgres-restore.sh. Verification: clean install/build/full suite including PostgreSQL; migration/rollback rehearsal; process outage/restart; corrupted backup/artifact and wrong key fail closed; privacy-preserving diagnostic outputs; monitoring distinguishes waiting from complete; deployment config validated locally. Do not test against production or claim off-host delivery without a real destination.

## Per-phase review and completion

After implementation, delegate verification, anti-pattern checks and code-quality review; resolve actionable findings before marking complete. Commit only verified phases, then push the working branch and prepare the next handoff. Keep commits reviewable and never merge without the user's instruction. Final verification includes repository suite, real disposable PostgreSQL integration, UI inspection, migration/recovery drills and evidence bundle regeneration. Update the execution backlog and README so implemented interfaces, tested behavior, empirical evidence and operated external deployment are distinguished.

## Execution notes

- Implementation runs in `/Users/jakobgrant/Workspaces/super-brain-remediation`. The original checkout remains on `main`; installed capture hooks and local services reference that original checkout's build output. Builds and tests in this plan must use the isolated worktree.
- The clean isolated dependency install and bootstrap build passed. A disposable PostgreSQL 17/pgvector instance is available with a restricted application role; it is never the live database. Test schemas and child API processes are independently owned and cleaned up.
- Prepare a private beta on one server with local private-artifact workers. Keep the existing private/UNLICENSED distribution status unless the owner chooses a license. Public provisioning and external backup delivery require actual destination configuration; neither is implied by a local test.
- Phase 1 independent review resolved exact-retry API prechecks, concurrent schema initialization, overly broad command-request normalization, repeated memory identity validation, trajectory ordering, receipt publication durability, retry ordering, restart timestamps, and stale acceptance fingerprints. The full Node 24/PostgreSQL gate passed after these changes.
- Parser/normalizer version changes must include migration coverage for previously imported immutable artifacts and canonical turn citations. Receipt occurrence identity, artifact content identity, parser interpretation identity, canonical event order, and ingestion delivery order are separate concepts.

## Finding coverage ledger

| Finding family | Planned coverage | Status |
| --- | --- | --- |
| E1 receipt loss/ambiguous retries | Phase 1 capture receipts and reconciliation | verified Phase 1 |
| E2 outcome overstatement/historical result loss | Phase 1 tri-state evidence + Phase 3 acceptance contract | Phase 1 verified; Phase 3 pending |
| E3 semantic mapping proof | Phases 3 and 5 independent annotations/experiment | pending |
| E4 task/model/context/usage provenance | Phase 3 attempt manifest | pending |
| E5 replayable repository state | Phase 3 private patch/artifact capture | pending |
| E6 human authority/interventions | Phases 1, 3, 4 | Phase 1 verified; Phases 3–4 pending |
| E7 lifecycle silence | Phase 1 explicit unknown policy | verified Phase 1 |
| E8 selected consent-aware evaluation export | Phase 5 | pending |
| P1 late-event cursor loss | Phase 1 ingestion positions and migration | verified Phase 1 |
| P2/P3 stale cache/concurrent domain commands | Phase 1 CAS/idempotent commit | verified Phase 1 |
| P4 JSONL singleton and batch contract | Phase 1 | verified Phase 1 |
| P5 revocation/stale webhooks | Phase 1 | verified Phase 1 |
| P6 history growth/checkpoints | Phase 6 measured bounded read models | pending |
| P7 operations/readiness/restore | Phase 6 | pending |
| Missing artifacts/failed cognition halt work | Phase 2 durable independent jobs | pending |
| Extraction cap/tool evidence/turn identity | Phases 1 and 2 | pending |
| Evidence references/promotion provenance | Phase 2 | pending |
| Dedup support loss/scope collisions | Phase 2 | pending |
| Shared correction/creator replay mismatch | Phase 2 | pending |
| Forgotten/revised sources, derivative invalidation | Phase 2 | pending |
| Feedback permission/failure/revision/meaning | Phase 4 | pending |
| Browser/client/retry duplication | Phase 4 | pending |
| Context adoption and practical task evidence UI | Phase 4 | pending |
| Outcome-bearing PR/CI/merge/revert integration | Phase 3 authenticated outcome boundary | pending |
| Provider deadlines/background current embeddings | Phase 6 | pending |
| Useful retrieval/real two-model evidence | Phase 5 | pending |
| External deployment destination and license | Concrete preparation in Phase 6; actual decisions required before public release | pending |
