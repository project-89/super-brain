# Data usefulness follow-up

Baseline: September 8, 2026 audit. Collection volume is not evidence of memory
quality, task success, or correct causal reasoning.

## Implementation checklist

- [x] Restore legacy accepted-memory evidence through append-only revisions.
      Dry-run first; preserve content, scope, existing evidence, and ownership.
      Verify a second pass makes no changes.
- [x] Make the quality report include revised evidence, with a real PostgreSQL
      regression test and matching in-memory behavior.
- [x] Collect helpful, unhelpful, and superseded judgments beside recalled
      memories, tied to the question. Do not label retrieval itself as validation.
- [x] Correct Codex tool-result status from explicit outcome signals, preserving
      unknown when no result signal exists. Expand parser coverage with fixtures.
- [x] Keep memory-worker turn references aligned with importer allocation when
      system, boilerplate, or tool-only records precede dialogue.
- [x] Remove common English question words from lexical recall; retain an
      unrelated-memory regression fixture and version the ranker as BM25 v2.
- [x] Inventory remaining unclassified record types and preserve source records.
      The importer scan emits per-type diagnostics and a hash-bound private report.
- [x] Reprocess historical archives into versioned canonical derived records,
      not rewrite imported events or silently discard unfamiliar metadata.
- [x] Capture explicit current-unit task success/failure and decision evidence. Tool completion
      is not task success; a reasoning checkpoint is not a proven causal edge.
- [x] Add post-completion operator verdicts and retrospective outcome corrections,
      scoped to an explicit trajectory rather than a currently open unit.
- [x] Require the operator credential for operator decisions, retain agent claims
      without elevating their authority, and preserve verdict provenance on replay.
- [x] Stop treating all checkpoints along a successful task as accepted memories.
- [x] Persist an incremental System state projection. Test late-arriving events,
      restart recovery, authorization changes, and replay equivalence first.
- [x] Archive Gemini and Hermes transcripts when local sources are available,
      with native run/project identity, policy enforcement, and parser fixtures.
- [x] Add a project-scoped retrieval evaluation runner with explicit expected
      evidence, immutable result reports, and separately recorded human judgments.
- [ ] Review real project questions against original evidence, run retrieval,
      and judge returned memories before claiming usefulness or bulk promotion.
- [x] Review the two quarantined capture delivery jobs still reported on September 9.
      Preview their ordering conflicts and preserve original IDs when recovering them.

## Evaluation gates

Measure source-link coverage and reachability; parser coverage by source/type;
explicit versus unknown task outcomes; and human judgments on actual recalls.
Use a small project-scoped question set with expected source evidence to measure
retrieval relevance before bulk promotion. Report denominators and scope.
Never automatically mark a memory helpful based on confidence or model approval.

## Verified follow-up

September 9: 1,967 legacy memories repaired through revisions; no content or scope
changes. A second dry run found zero repairs remaining. All 2,662 proposal evidence
references checked had existing source events; references carrying run/turn IDs
also resolved to imported turns. Existence is not proof of semantic alignment.

PostgreSQL tests ran against a disposable pgvector PostgreSQL 16 instance using a
NOSUPERUSER/NOBYPASSRLS role, not the live database. Regression coverage includes
evidence addition/removal, unrelated revisions, late arrivals, and hidden scopes.
The live UI exposes per-recall judgments; no artificial helpful judgments were
added to the production corpus during testing.

Historical parser-v1 imports remain immutable. Parser v2 affects new imports;
the remaining historical unknown counts have not been claimed as resolved.

The September 9 follow-up separates task verdicts from tool verification, includes canonical
event/artifact references on explicit verdicts, and records summaries without an
explicit choice as observations rather than decision nodes. `/decision` requires
the operator credential; a lookalike hook body cannot grant that authority.
Unknown results stay unknown, including on restart. Existing historical success
labels remain untouched and are visibly identified as lacking verdict provenance.

The default transcript scan now includes archived Codex sessions. Supplying a
custom Codex root does not implicitly add the user's default archive directory.
Reports created with `scan --report PATH` are versioned, hash-bound per source,
written with mode 0600, and refuse to overwrite an existing report. They contain
metadata diagnostics, not source conversation text, and do not change the Fold.

## Local source inventory (September 9)

Read-only parser-v2 scan of current local files (not an aggregate of imported
snapshots): 863 files, 1,805,111,498 bytes, 80 projects, 39,922 turns, and 173,484
actions, with no parser failures. This includes 532 Claude files and 331 Codex
files, including archived sessions. Unhandled Claude
types include mode, permission-mode, ai-title, file-history-delta, bridge-session,
agent-name, pr-link, cost-state, frame-link, and atis-latch. Codex includes token
usage (10,763), inter-agent metadata (1,921), and agent messages (1,921).
The 329 web-search calls are now handled by parser v2. These records have
different value: bookkeeping must not be mislabeled as missing conversation,
and usage/inter-agent records deserve explicit extraction rather than an ignore
list that merely improves the unknown-record count.

Codex tool-result classification remains unknown for 49,915 results; 27,763
have explicit completion signals and 2,124 explicit failure signals. Unknown
does not mean the output was lost: output without a recognized result signal
is retained without inventing success. These measurements are a point-in-time
snapshot; active source files continue changing.

The local report is `transcript-parser-inventory-2026-09-09-v2-with-archives.json`
under `~/.local/state/super-brain/`; permissions verified as 0600. No historical
canonical imports were rewritten by the scan. All workspace typechecks and the
production build passed. Focused capture/importer/worker/trajectory/UI suites
passed 112 tests; trace, SDK, and API suites passed another 135 (247 total).
The legacy verdict label was checked in the live UI on desktop
and at a 390px mobile viewport, with no horizontal overflow in the inspector.

See also [the execution backlog](EXECUTION_BACKLOG.md). This checklist tracks
data-quality follow-up, not completion of the broader architecture remediation.

## Historical derivations (September 10)

All 794 retained imported runs were readable and now have a complete, hash-bound
derivation. This is the retained-import corpus, not the earlier inventory of 863
live source files. Original imports, run IDs, projects, privacy policies, and
the 164,250 captured actions / 17,773 historical unknown records were not rewritten.

The completed derivations cover 563,702 retained source records and contain
222,750 supplemental evidence records: 139,132 usage snapshots, 82,133 tool
results, 329 web searches, 578 agent communications, and 578 agent messages.
Usage snapshots must not be summed as independent token charges. Tool completion
is not task success, and these records are not automatically accepted memories.
Remaining unclassified schemas are visible in each manifest, including Claude
bookkeeping and Codex `ghost_snapshot` records; their retained sources remain intact.

The audit verified 804 manifests and 3,125 chunks, checking hashes, run identity,
chunk order, contiguous ordinals, record totals, and per-kind counts. Ten initial
v1 derivations encountered PostgreSQL JSONB-incompatible strings and remain
incomplete audit history. Their complete v2 replacements preserve 23 affected
payloads using a lossless, explicitly labeled encoding rather than truncation.
The other 784 complete derivations remain v1. Select one complete version per run
when evaluating the corpus; do not count partial predecessors as extra work.

The CLI defaults to a dry run, stages bounded chunks privately, retries transient
errors, and resumes from server-confirmed completion. Runs now show paginated
derived evidence, source-line references, version/completion state, source hashes,
and diagnostics. The original source hash and retained-input hash are distinct:
capture-time exclusions or anonymization cannot be undone by reprocessing.

Backfill verification also led to bounded SDK/database selection caches, an
indexed run-specific lookup, and memoized validated derivation decoding. A live
capture timestamp tie was recovered as
`capture-1789067771097-900-retry-2611ff9d2aaf`, retaining the original event ID in
`capture.identity.reissuedFrom`. New server-generated derivations avoid integer
capture timestamps. The capture daemon subsequently reported zero failed jobs.

All workspace tests passed, including PostgreSQL tests against a disposable
PostgreSQL 16 instance under a NOSUPERUSER/NOBYPASSRLS role. Workspace typechecks
and builds passed; desktop and 390px mobile evidence views were checked for
readability and horizontal overflow. Reports are private, ignored by Git, under
`.data/reprocessing-v1-dry`, `.data/reprocessing-v1-apply`, and
`.data/reprocessing-v2-recovery`.

Reposting all 794 completed manifests returned idempotent no-ops: zero additional
events. The checksum/count/retry receipt is
`.data/reprocessing-verification-2026-09-10.json` (mode 0600).

Outstanding at the September 10 checkpoint: incremental System state projection, Gemini/Hermes archive
adapters, and project-scoped retrieval evaluation with human judgments. The raw
local-artifact panel in the inspected browser also lacks a valid capture operator
credential; its error now distinguishes this from workspace API access. Canonical
derived evidence is available through the normal authorized workspace API.

## September 10 Follow-Up

Recovered both quarantined observations using explicit event rebasing. Their
payloads and error reports are retained under
`.data/capture/recovery-audit-2026-09-10/` (private files); reissued events retain
their source IDs. Capture subsequently reported zero failed jobs.

Retrospective verdicts are append-only `trajectory.outcome-recorded` events.
The Decisions run inspector exposes review, evidence/reason, latest reviewer,
original captured outcome, and paginated verdict history. Corrections require
the previous verdict ID; the database prevents concurrent forks. Scope comes
from the original run, and operator provenance comes from authentication, not
the request body. `unknown` withdraws verification without deleting history.

At the end of this earlier pass, historical reprocessing remained next. The
completed backfill documented above supersedes that status and implements the
requirements below. At that point, the design constraints were: current
artifacts use content-hash identity, so parser-v2 replay must not attempt to
replace an existing artifact/run bundle. The next implementation needs:

- A derivation identity including original artifact hash, parser ID/version,
  and extraction policy; retain the original run/project identity as references.
- Owned source verification against the import hash, not a mutable current
  transcript silently substituted for its historical snapshot.
- Dedicated append-only derived records and an idempotent checkpointed runner.
- Coverage comparisons and source links in reports; do not double-count derived
  actions as newly captured actions or lower unknown counts by ignoring records.
- Usage and inter-agent extraction fixtures before scheduling corpus-wide replay.

Verification: 229 focused tests passed, including 14 PostgreSQL integration tests
using a disposable PostgreSQL 16 database and a NOSUPERUSER/NOBYPASSRLS role.
All workspace typechecks and production builds passed. Desktop and 390px mobile
review controls were checked against a real completed run; no test verdict was
submitted to the production corpus. API, capture, and memory worker were rebuilt
and restarted; the canonical log contains both recovered observations.

Live verification also exposed an older full-detail task-list performance issue:
the route replayed every task before pagination. It now pages task IDs first and
loads only their trees, preserving the full-detail response. A one-task request
measured 676 ms after the fix (the old route exceeded a 15-second check); the
compact query measured 690 ms. These are local spot checks, not load-test results.

## September 11 Follow-Up

The next pass implements durable System projection checkpoints, native archive
adapters, and a project-scoped retrieval evaluation workflow. Implementation and
local verification do not close the human evaluation or hosted-deployment gates.

### System state

PostgreSQL persists projection metadata and individual state cells rather than
serializing the full materialized state into every checkpoint. New visible
events advance the checkpoint incrementally; genuinely late visible events
trigger a deterministic replay. Equal-time events use the Fold's code-unit ID
ordering, including across database cursor batches. Later IDs at an existing
timestamp and invisible old events do not trigger unnecessary replay.

Checkpoints are isolated by organization, workspace, principal, role assignments,
platform-read status, and canonical/draft selection. Authorization changes select
a different checkpoint; one principal's state is not reused for another. Database
transactions and advisory locks protect concurrent advancement. Regression tests
cover replay equivalence, deletion, diagnostics, late arrival, revoked access,
private scopes, restart restoration, reducer rollback, and two-process access.
The non-PostgreSQL SDK retains an incremental in-memory fallback.

Initial materialization or a genuinely late event can still require a full replay.
Durable checkpoints improve normal paging and restart recovery; they do not make
first-time replay, full-state response serialization, or arbitrary authorization
variants free.

Live local spot checks returned HTTP 200: first materialization took 78.185 seconds
at 103,051 visible events; a health request during that build completed in 68 ms.
After restarting the API, restoring durable state took 15.210 seconds for 103,539
nodes, 604,135 values, and 103,700 visible events. Subsequent requests took 345 ms
and 361 ms while capture advanced the visible event count to 103,702 and 103,703.
These measurements are not load tests or latency guarantees. They show recovery
from durable state and ongoing incremental advancement, not constant-time cold
startup.

The System page now distinguishes browser state ("Not loaded" / "Load state")
from database materialization. Its toolbar wraps large live counts without
shrinking or covering the mode and section controls. Desktop and 390px mobile
checks showed all five section tabs and both modes, with no horizontal page
overflow, at 103,723 nodes, 605,231 values, and 161 diagnostics.

### Additional archive sources

The importer now reads Gemini JSON conversation snapshots, legacy Hermes JSON
logs, and Hermes SQLite sessions including WAL-backed messages. Native session
identity is preserved. Gemini filesystem roots are trusted only when the adjacent
project marker matches the native project hash; an unresolved native hash remains
an estimated project. Missing project metadata or naive legacy timestamps are not
filled in with invented values.

Archive storage applies the existing reasoning, opaque-signature, anonymization,
secret-scanning, and encryption policies. Readable reasoning and opaque provider
signatures remain separate retention decisions. Native usage, tool results, and
parent-session references can be extracted as versioned evidence. Unknown tool
outcomes remain unknown and are not overall task verdicts.

These are import adapters, not Gemini/Hermes live capture installers. Gemini's
newer append-only `session-*.jsonl` format is detected and reported as unsupported;
it is not silently discarded or imported partially. Hermes SQLite access requires
Node.js 22.13 or later. See the [importer documentation](../apps/importer/README.md)
for source paths and supported-format boundaries.

The local read-only inventory found 59 Gemini files representing 49 unique native
runs, 403 turns, and 2,556 actions, with no parser failures. Three runs resolved to
filesystem projects and 46 retain estimated native-hash projects. The Hermes
inventory found 37 SQLite sessions, 103 turns, and 2,266 actions, all with resolved
projects and no parser failures. Native-run deduplication selects the snapshot
with the most source records; this does not prove different snapshots are strict
prefixes or restore data omitted by the source harness. Private reports are
`.data/gemini-archive-inventory-2026-09-11.json` and
`.data/hermes-archive-inventory-2026-09-11.json`.

Canonical import then completed for all 49 Gemini and 37 Hermes runs: 86 runs,
506 turns, and 4,822 actions, with zero parse or delivery failures. The private
mode-0600 receipts are `.data/gemini-archive-import-2026-09-11.json` and
`.data/hermes-archive-import-2026-09-11.json`. These are actual retained source
imports, not generated fixtures. The corpus subsequently exposed 882 unique runs,
including one recovered Codex snapshot; both paginated importer resume and client
run listings returned matching unique IDs in a local 484 ms, 18-request check.

Live delivery exposed an import-path performance issue: generic transcript
selection included large supplemental derivation payloads. Import writes now
exclude those records and select only the relevant native run and snapshot
chunks, retaining conflict checks. Regression coverage includes snapshot identity
and chunk selection. This does not remove or rewrite earlier derivations.

Reposting all 86 native imports through the real API returned HTTP 200,
`imported: false`, and zero new events. The private mode-0600 receipt is
`.data/native-import-retry-verification-2026-09-11.json`.

Parser-v3 derivation completed for these 86 runs, extracting 3,746 supplemental
records from 3,903 retained source records: 1,194 usage snapshots, 2,516 tool
results, and 36 parent-agent links. Gemini contributed 2,435 records and Hermes
1,311; 192 canonical manifest/chunk events store that evidence. Ten `info` and two
`error` source records remain explicitly unclassified, not silently ignored.
The existing worker naturally produced 15 Gemini and 36 Hermes memory proposals
from the imports. These proposal counts do not establish promotion or human
validation; no synthetic recall judgments were added.

The integrity audit verified all 86 manifests, 106 chunks, and 3,746 records.
All 86 completed manifest retries were no-ops with zero new events. The private
receipt is `.data/native-derivation-verification-2026-09-11.json`.

### Retrieval evaluation

The read-only `fold-eval` CLI prepares cursor-paginated project authoring catalogs,
runs reviewed question sets against scoped recall, and writes private hash-bound
results. Separate human judgments bind to the exact result report and
question/memory pair. Incomplete ground truth, foreign project results, duplicate
results, mismatched evidence qualifiers, repeated cursors, and transport failures
are errors rather than negative relevance observations. Empty metric denominators
are null, and unjudged results remain unknown. The runner neither promotes
memories nor writes canonical feedback.

Private starter drafts under `.data/retrieval-evaluation-2026-09-11/` expose two
existing project identities for this repository: the local-root project has ten
accepted authoring memories and the remote-identity project has zero. Neither is
reviewed or merged. These counts exclude candidates and imported evidence and
cannot establish usefulness. A human still needs to select questions and expected
source evidence, then judge the resulting recalls. Source-reference overlap does
not prove reachability, semantic alignment, task success, or causal correctness.
See [retrieval evaluation](RETRIEVAL_EVALUATION.md) for commands and denominators.

### Remaining operator gates

The raw local-artifact viewer still needs the capture operator token in its
browser connection settings. The existing token was verified against the local
capture settings endpoint (HTTP 200), but the browser's missing session token was
not replaced without explicit approval. No authentication boundary was weakened
and no public token-discovery endpoint was added. Canonical derived evidence
continues to use normal authorized workspace API access.

Capture now resolves relocated Codex transcripts using native session identity,
not a matching filename alone, and refuses ambiguous matches. Recovery previews
are read-only; confirmed recovery preserves audit evidence and uses a durable
private snapshot. One available historical Codex transcript was recovered and
imported. Two remaining failed delivery jobs point to source files that could
not be found. They remain visible with their failure evidence; no substitute
transcript or successful-delivery result was invented.

Human-reviewed retrieval questions and judgments remain outstanding, as does
reconciling the local-root and remote-repository project identities without
silently widening authorization. Supporting Gemini's newer JSONL archive format
and installing live capture for additional harnesses are separate work from the
native archive import delivered here. Hosted identity, production operations,
and the broader architecture remediation remain governed by their own backlog.

### Verification

All workspace test suites, typechecks, and builds passed after the final implementation
fixes, including 59 capture, 67 API, 23 PostgreSQL, 37 importer, and 13 client tests.
The PostgreSQL integration tests used a disposable PostgreSQL 16 instance under
a NOSUPERUSER/NOBYPASSRLS role, not the production database. Independent reruns
also passed 33 evaluation-package tests and 20 UI tests. These automated checks
establish the tested behavior, not human usefulness or hosted readiness.

After rebuilding and restarting the services, the API and capture health checks
were healthy. The capture inbox reported zero pending hooks and zero failed hooks;
the delivery spool reported one pending job and the two missing-source failures
described above. The latest observed hook was at 2026-09-11 23:40:55 UTC. This is a
point-in-time live check, not a claim that the delivery spool is empty or that the
two historical failures have been resolved.

### Missing-source investigation (September 11 evening)

A subsequent read-only recovery preview still found two unavailable sources and
zero recoverable jobs. The affected native sessions are
`01a09161-1c2c-7540-aa08-7e3b6845b3b0` (sixth-summit) and
`01a09271-eba2-7070-af92-7e8ff73c9c0d` (Workspaces). Neither has a matching filename
under the local Codex home, a row in its current `threads` index, or retained
`thread_items` in its separate history database. This does not establish whether
the source harness deleted the sessions or never persisted their transcripts.

Each capture session has one observed event, is finalized with `session-end`,
and retains only the synthetic session-start observation in its step journal.
There is no captured conversation in those journals to reconstruct as a native
transcript. The failed jobs were not retried, discarded, or marked delivered.
At 2026-09-12 01:09:45 UTC, capture was healthy, its hook inbox had zero pending or
failed hooks, and the last delivery failure was still the earlier missing file.

The existing capture operator credential again returned HTTP 200 from `/settings`,
while the inspected browser still displayed the archive access-denied message.
The UI stores this credential in tab session storage, separately from workspace
API access. Connecting that browser remains a configuration action, not a reason
to disable archive authorization. No browser credential was changed in this check.

### Browser archive connection resolved (September 14)

With explicit operator approval, the existing local capture operator token was
saved through the Brain connection settings in the existing browser tab. The
History page then rendered retained transcript records for
`codex:01a096be-8676-7d62-9741-0758050de495`; the archive access-denied message was
absent. This closes the inspected tab's credential configuration issue, not the
two missing-source failures. The credential remains in browser session storage,
not this repository, and may need to be entered again in a new browser session.
No capture policy or authorization controls were changed.
