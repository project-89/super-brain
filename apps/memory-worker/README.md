# Memory worker

Reads only redacted transcript vault artifacts and emits reviewable, project-aware memory candidates. Promotion always creates immutable decision and memory events; the worker never mutates a projection directly.

```sh
export SUPER_BRAIN_URL=http://127.0.0.1:3002
export SUPER_BRAIN_ORGANIZATION=local
export SUPER_BRAIN_WORKSPACE=local-history
export SUPER_BRAIN_TOKEN=...
export FOLD_TRANSCRIPT_VAULT=.data/transcript-vault

pnpm --filter @_89/super-brain-memory-worker start -- scan
pnpm --filter @_89/super-brain-memory-worker start -- backfill --confirm
pnpm --filter @_89/super-brain-memory-worker start -- backfill --confirm --auto-promote
pnpm --filter @_89/super-brain-memory-worker start -- watch --auto-promote
pnpm --filter @_89/super-brain-memory-worker start -- install-service
```

`scan` reports candidates without writes. `backfill` uses deterministic candidate IDs and batches up to 100 proposals. `--max-per-run` is now the extraction page size (1 to 500), not a total-run cutoff: later matches are processed too. `watch` persists a private local processing job before its subscriber callback returns and the transport offset advances. Independent transcript, live-observation, and synthesis jobs retry without discarding the source event.

## Durable processing

The local-vault deployment uses a single-host filesystem spool, not a distributed
queue. Set `FOLD_MEMORY_PROCESSING_ROOT` or `--processing-root` to relocate its
base directory; the default is `~/.local/state/super-brain/memory-worker/jobs`.
API URL, organization, workspace, audience, and consumer identify a namespace.
The credential fingerprint is checked separately: credential rotation fails
closed with pending jobs intact, rather than silently selecting an empty queue.
An operator must verify the same principal and access before migrating the
namespace's `identity.json` fingerprint. Never copy work between principals.

```sh
pnpm --filter @_89/super-brain-memory-worker start -- jobs
# Stop the watcher first; this resets retry timing without dropping saved pages.
pnpm --filter @_89/super-brain-memory-worker start -- retry-jobs --confirm
```

### Ingestion cursor migration

The watcher uses ingestion order, independent of source event timestamps. An
existing legacy `(t, eventId)` checkpoint requires explicit migration; watch
fails closed instead of silently skipping late arrivals or replaying history.
Use the same API URL, organization, workspace, consumer, audience, credential,
and processing-root settings as the installed watcher:

```sh
pnpm --filter @_89/super-brain-memory-worker start -- migrate-cursor
# Stop the watcher first. This initializes missing ingestion progress at zero.
pnpm --filter @_89/super-brain-memory-worker start -- migrate-cursor --confirm
# Restart the same watcher, preserving its existing promotion policy.
pnpm --filter @_89/super-brain-memory-worker start -- watch --auto-promote --no-continuous-cognition
```

The default preview only reads cursor metadata, requires no vault or model
provider, and does not open or create the local spool. Confirmation requires
exclusive ownership of that spool and the same credential fingerprint; it
retains the legacy checkpoint and does not rewind existing ingestion progress.
The command neither queues jobs nor processes events. The watcher subsequently
replays from the ingestion checkpoint, retaining active/completed/excluded job
receipts and using the same deterministic job identities.
The worker checkpoints every 100 successfully spooled events, with a one-second
flush of smaller batches; graceful stops flush the last successful cursor.
An abrupt crash can redeliver up to 100 events,
which durable job receipts deduplicate. A failed enqueue is never acknowledged.

`headCursor` is a sampled high-water mark for the authorized subscription kinds.
`reachedSampledHead` compares decimal sequences without numeric rounding. It
measures transport progress, not completed extraction; gaps are not event counts.
Keep the preview's target to compare against later cursor samples, since new
events can move the head. Inspect `jobs` separately for waiting, blocked, retry,
and completed work, and capture health separately for undelivered source jobs.

For a large replay, `--no-continuous-cognition` avoids scheduling historical
model synthesis. Preserve the watcher's existing `--auto-promote` setting (omit
it in both normal and replay operation for a proposal-only watcher). This does
not change transcript/live job identities. Already queued synthesis jobs and
saved policies remain intact; incompatible synthesis policy blocks those jobs
for deliberate review, rather than silently reinterpreting or deleting them.
Restore the prior cognition configuration after transport catch-up and review
blocked synthesis before explicitly retrying it. Do not remove receipts or use
a new consumer/namespace as a shortcut around migration.

### Audited replay repair

`migrate-cursor` never rewinds an existing ingestion checkpoint. When a verified
transport defect requires replaying the same consumer, use the separate reset
command with its exact observed current sequence and a reason of 10 to 2000
characters:

```sh
pnpm --filter @_89/super-brain-memory-worker start -- migrate-cursor
pnpm --filter @_89/super-brain-memory-worker start -- reset-cursor --expected-sequence 1234 --reason "Repair incomplete ingestion replay"
# Stop ALL instances of this consumer first, including on other hosts.
pnpm --filter @_89/super-brain-memory-worker start -- reset-cursor --expected-sequence 1234 --reason "Repair incomplete ingestion replay" --confirm
```

The default preview shows `expectedMatches` and creates no spool. Confirmation
requires the exclusive local spool claim and a workspace owner/admin credential
with consumer-write access. The API atomically checks the current sequence,
records actor, old/new positions, reason and time, and resets that same consumer
to zero. A stale expected cursor fails rather than rewinding newer progress.
The spool claim protects only this host. Reset has no distributed generation
fence: a still-running remote consumer can commit an old higher position after
reset and skip replay. Stop every instance before confirmation and restart only
the intended single owner afterward; preserve its scope, credential, and spool.
Legacy offsets, active jobs, saved pages, and completed/excluded receipts remain
intact. Restart the same watcher to replay; the reset itself processes nothing.
Use the temporary cognition policy precautions above for large repairs. Never
substitute a new principal or delete receipts to bypass the guarded reset.

### Historical transcript inventory

Historical transcript inventory remains an explicit recovery and coverage check;
a watcher upgrade alone does not prove historical artifacts were processed.
After cursor migration and capture catch-up, preview first:

```sh
pnpm --filter @_89/super-brain-memory-worker start -- queue-backfill --auto-promote
# Stop the watcher, keeping its consumer, scope, audience, and promotion policy.
pnpm --filter @_89/super-brain-memory-worker start -- queue-backfill --auto-promote --confirm
# Restart that same watcher; jobs and their saved pages now drain normally.
```

Omit `--auto-promote` in both commands for a proposal-only watcher. Keep the same
`--consumer`, organization/workspace, credential, and processing-root settings.
The default dry run only reads authorized source metadata; it neither reads
vault contents nor calls a model or writes proposals/jobs. Confirmed scheduling
uses exactly the watcher's transcript job identities, refuses a concurrently
owned spool, and skips existing active/completed/excluded receipts. A partial
queueing run can be repeated after restart. Missing artifacts remain waiting
when those jobs are drained. `--limit` can bound the inventory run count.

`jobs` is a read-only, non-atomic coverage snapshot showing active job IDs,
status, attempts, next retry, message/candidate progress, and separate completed
and excluded receipt counts. It does not print source transcripts or generated proposals. States are
`pending`, `waiting` (artifact/access/evidence unavailable), `retry` (processing
failure), `blocked` (eight failures, incompatible policy, or corrupt progress),
and terminal `complete`/`excluded`.
Waiting jobs retry with capped backoff, including after restart. Pending work
is capped at 10,000 jobs; reaching that limit stops transport acknowledgment.
Completed receipts are retained for replay deduplication and are not scanned
for each incoming event; their retention/pruning policy remains future work.

Extraction and synthesis have separate bounded drain lanes; a pending model
request does not stop incoming extraction. Proposal/promotion mutations remain
serialized for deduplication. Private or space-scoped sources are explicitly
excluded rather than widened to unscoped output; current synthesis inputs must
match the output audience and have no space restriction. A changed extractor,
audience, or promotion policy blocks saved jobs for deliberate migration.

Each transcript page is persisted before delivery, and its cursor advances
only after proposal/promotion returns. Candidate IDs make lost-response replay
idempotent. Source events are reauthorized on processing; a changed parsed
artifact digest cannot continue an old cursor. Malformed JSON or decryption
failure is incomplete work, not an empty successful extraction. Synthesis
persists its output before proposal delivery, with a separate output identity
covering source memory snapshots, prompt policy, and provider descriptor.
Revised or inaccessible dependencies invalidate that prepared output before
delivery. Synthesis now uses exact durable count/time/completion windows rather
than event-ID hash sampling. See the scheduling contract below.

Direct library callers of `watch` must supply `processingRoot`; missing durable
storage fails before subscription. One process owns each spool namespace.
This local worker does not provide a multi-host queue or ongoing
invalidation of already-published synthesis. Vault parsing still loads and
hashes the full artifact per page, so long-run processing has repeated read
cost; `scan`/`backfill` aggregate extracted candidates for reporting (writes
are per run). The durable watcher bounds proposal pages, not total artifact
size. Streaming parser checkpoints remain a follow-up optimization.

- [x] Consolidate equivalent pending support through additive candidate
  evidence events, including within a batch and across extraction pages.
  Content, extractor, confidence, tags, audience, space, applicability, and
  project scope must agree; matching titles alone never establish equivalence.
  Changed meanings remain separate reviewable proposals, with deterministic
  variant IDs when the source-derived candidate ID collides. Proposal writes
  carry at most 100 references; additional support uses bounded overlay calls.
  Lost responses and conflicting proposal writes reconcile evidence before
  completing the durable job. Concurrent review requires the current support
  revision; PostgreSQL validates this under its tenant append lock.
  Transcript/live job IDs include delivery policy `candidate-support-v2`, so
  legacy completed receipts do not suppress replay with the improved support
  behavior. Old in-progress policies are blocked for explicit operator review;
  their saved cursors are never silently reinterpreted.
- [ ] Add additive support or compare-and-swap revisions for already accepted
  memories. Their current evidence revision is still read-modify-write and can
  race independent writers; the memory revision API also caps evidence at
  1,000 references. Neither limit is a pending-candidate ledger guarantee.
- [x] Verify the September 15 local migration/replay through fixed ingestion
  sequence `142188`: all 890 canonical unscoped transcript source IDs have
  distinct completed new-policy jobs. Normal background cognition was restored.
  This is not a blanket guarantee for other deployments or unavailable artifacts;
  five local source transcript jobs remain unrecovered. New deployments require
  their own migration and source-ID-based processing coverage checks.

Repair accepted memories that predate evidence propagation with:

```sh
pnpm --filter @_89/super-brain-memory-worker start -- repair-evidence
pnpm --filter @_89/super-brain-memory-worker start -- repair-evidence --confirm
```

This command uses the same API URL, organization, workspace, and token settings;
it does not require a vault or model provider. The default is a dry run. Confirmed
repairs merge the accepted proposal's evidence into the current memory through
an authorized revision, preserving content and scope. Forgotten memories are
skipped; already repaired memories are unchanged. Rate-limit responses are retried
at most three times using the server's retry delay. Other errors stop the command;
rerunning resumes safely through the existing-evidence checks.

A successful task does not validate every hypothesis along its path. Live
reasoning-checkpoint proposals therefore remain reviewable even when the task
has an operator-approved successful outcome. Their acceptance is a separate
memory decision; the worker no longer promotes them solely from path membership.

The watcher credential needs `events:read`, `consumers:read`,
`consumers:write`, `transcripts:read`, `memories:read`, and `memories:write`.
Add `reasoning:read` when continuous cognition is enabled. Missing optional
reasoning access disables cognition for that worker process without blocking
deterministic extraction or cursor progress.

`--auto-promote` applies a deliberately narrow trusted policy. Structured
Claude-Mem observations require confidence of at least `0.95` and a resolved
project. Explicit project-scoped human decisions qualify immediately. Live
reasoning checkpoints require separate memory review; a successful trajectory
does not validate every thought along its path. Rule-derived and unresolved candidates remain in
review. Equivalent accepted memories accumulate new causal evidence through
revisions rather than duplication. Proposals and promotions are each committed
in atomic batches of at most 100.

On macOS, `install-service` creates an owner-readable `launchd` service that
runs the durable watcher with automatic promotion. Pass `--no-auto-promote` to
install a proposal-only watcher or `--replay-all` for an intentional full replay.

The built-in `durable-transcript-memory` rule extractor recognizes structured Claude-Mem observations plus explicit durable decisions/preferences. Its ID and version are stored on every candidate. A model-backed extractor can be added under a different extractor identity without changing the event, review, or promotion contracts.

Continuous cognition selects a small, project-diverse set of accepted memories
with canonical evidence and sends those exact authorization-checked IDs to the
configured central reasoner. Model output remains a reviewable proposal and is
never silently promoted.

### Exact scheduling and episode jobs

`watch` enables episode formation and continuous cognition independently.
`--no-episodes` and `--no-continuous-cognition` disable their respective policies.
`--cognition-every` and `--episode-every` default to 25 eligible events;
`--cognition-elapsed-ms` and `--episode-elapsed-ms` default to 300000 milliseconds
from the first eligible **processing-time** arrival, not its historical timestamp.
An explicit non-unknown recorded trajectory outcome closes its window as completion; a
count/completion coincidence closes it only once. Capacity also closes windows:
1000 sources for synthesis, 200 for episodes. Capacity is a distinct trigger,
not a claim that a larger configured count threshold was reached.

Synthesis counts unscoped `trajectory.recorded`, `memory.recorded`,
`memory.revised`, and `trajectory.outcome-recorded` events. Its window is trigger
provenance, not a claim that every window source is fed to the reasoner. Episode
windows retain sources from the subscribed kinds, including canonical transcript
derivation chunks, partitioned by exactly one verified original project and
publication scope. Unknown, ambiguous, multi-project, private, and space-scoped
sources are excluded with counters, never mixed into workspace output. The
initial episode worker supports unscoped workspace publication only. Display
names and arbitrary repository URLs are not project identifiers.

An atomic scheduler checkpoint/outbox precedes transport acknowledgement.
Restart/replay does not recount ingestion sequences; a late source timestamp
with a new ingestion position still counts. Timer and event transitions are
serialized. State retains at most 1000 open partitions, 10000 source references,
and 15 MiB on admission, with 1 MiB reserved to seal and drain windows. Exhaustion
refuses progress visibly rather than dropping references. `jobs` reports safe
scheduling counters. This is the existing single-host spool, not a distributed
scheduler. A changed policy starts a new namespace at the current committed
consumer position; old jobs/state remain preserved and incompatible jobs block.
It does not silently replay historical events under new settings.

Episode jobs save the complete prepared result before publication. Lost-response
retries reuse it; publication revalidates source access, project scope, revisions,
and hashes. At most five recent same-project/same-publication episodes are selected from one
bounded page as optional continuity context, not an exhaustive project history.
The selection and omitted-context flag are persisted. A stale publication
conflict discards the prepared output for a fresh, bounded retry. If optional
context exceeds the input budget, the same source set retries without it before
any source splitting. Actual content may produce proposed semantic groups with
citations; metadata-only sources remain explicitly ungrouped `insufficient_content`, without
a model call. Prompt artifact references alone do not reveal prompt text. No raw
vault content is implicitly uploaded. On an explicit input-size refusal, jobs
split deterministically into two child windows retaining parent provenance and
every source. An oversized singleton stays blocked for budget or record-level
handling; no source text or record list is silently truncated.

### Chosen historical episode sources

Adding subscription kinds cannot recover records behind an existing cursor. Use
this bounded chosen-set queue for historical verification; it does not reset the
extraction consumer or scan the full archive. Select 1 to 200 distinct canonical
events belonging to one exact project. Preview performs authorized reads only:

```sh
pnpm --filter @_89/super-brain-memory-worker start -- queue-episodes --project-id PROJECT --event-id EVENT_A --event-id EVENT_B
# Stop the watcher first; confirmation requires its exclusive local spool lease.
pnpm --filter @_89/super-brain-memory-worker start -- queue-episodes --project-id PROJECT --event-id EVENT_A --event-id EVENT_B --confirm
```

Use the same consumer, credentials, audience, and episode policy flags as the
watcher, then restart it. Queueing performs no model call. The sorted source
ID/hash set and policy determine a stable manual window: duplicate invocations
reuse its receipt. Manual windows have no ingestion cursor or elapsed deadline
(their scheduling times use zero sentinels). Any inaccessible or mismatched
chosen source refuses the entire set; preview lists the exclusions. Full
historical episode coverage remains an explicit follow-up, not an inference from
the completed transcript extraction backfill.

Applicability is distinct from access. Known-project extraction emits `project`;
missing project identity emits `unresolved`, never implicitly `general`. File
evidence can resolve an unresolved observation to a project. Explicit `general`
proposals are not reassigned by that inference. Deduplication includes effective
applicability, so general and unresolved proposals cannot absorb one another's
evidence. Cross-project synthesis retains its cited project IDs and `project`
applicability; generalization requires a separate explicit decision and does not
expand organization or workspace permissions.
