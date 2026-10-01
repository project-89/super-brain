# Memory worker

The worker reads local transcript vaults and canonical events, creates reviewable memory candidates, and retains new supporting or opposing evidence for the same claim. It uses the shared native transcript parser and canonical turn IDs, including pseudonymous imports.

```sh
export SUPER_BRAIN_URL=http://127.0.0.1:3002
export SUPER_BRAIN_ORGANIZATION=local
export SUPER_BRAIN_WORKSPACE=local-history
export SUPER_BRAIN_TOKEN=...
export FOLD_TRANSCRIPT_VAULT=.data/transcript-vault
export SUPER_BRAIN_WORKER_STATE_ROOT=.data/memory-worker-jobs

pnpm --filter @_89/super-brain-memory-worker start -- scan
pnpm --filter @_89/super-brain-memory-worker start -- backfill --confirm
pnpm --filter @_89/super-brain-memory-worker start -- watch
pnpm --filter @_89/super-brain-memory-worker start -- retry --job JOB_ID
pnpm --filter @_89/super-brain-memory-worker start -- install-service --no-auto-promote
```

`scan` reads without creating jobs, keys, candidates, or consumer offsets. `backfill` persists work and processes runnable extraction/proposal jobs. `watch` acknowledges stream delivery only after encrypted jobs are durably published. Artifact retries and archive reconciliation continue independently of new stream events; missing artifacts, keys, permissions, and model providers remain waiting for their dependencies. Invalid source artifacts and permanent API validation failures retain explicit exclusion reasons. Every relevant turn is retained, including corrections late in long sessions; `--max-per-run` limits dispatch per pass, not source coverage.

State defaults to `~/.local/state/super-brain/memory-worker/jobs`. Namespaces use authenticated organization, workspace, principal, extractor version, audience, and space, so credential rotation and consumer-ID changes reuse the same work. Each namespace has an owner-only encryption key and a single-process lease; a competing process fails closed, and a dead owner can be reclaimed. Keep the job directory and its key together when backing up or moving processing. Coverage reports pending, waiting, retry, completed, excluded, and exhausted work. Warning logs identify the complete job ID and a reason code without source excerpts. Explicit `retry --job` creates a new processing attempt while retaining the original record.

Proposal and contribution commands persist their stable event stamps before dispatch. Their timestamps follow canonical evidence and source-memory revisions, including when the worker clock is behind. Unknown acknowledgements reuse the same command. Evidence is batched in groups of at most 100 and merged without truncating historical support. Consolidation requires equal audience, owner where applicable, space, applicability, source, summary, and claim content. The built-in extractors explicitly distinguish claim content from source location; custom extractors require exact content equality. Every distinct canonical event/run/turn citation is retained, including later corrections and reinterpretations. Canonical source lineage counts interpretations of one original occurrence as one supporting source; citation count is separate from independent support. A human correction to an accepted memory sends newly encountered old claims back to review; optimistic revision checks prevent a concurrent correction from receiving support meant for the old revision.

## Operator commands

```sh
pnpm --filter @_89/super-brain-memory-worker start -- jobs
# Stop the watcher first; explicit recovery of blocked, waiting and retrying work.
pnpm --filter @_89/super-brain-memory-worker start -- retry-jobs --confirm
pnpm --filter @_89/super-brain-memory-worker start -- queue-backfill
pnpm --filter @_89/super-brain-memory-worker start -- queue-backfill --confirm
pnpm --filter @_89/super-brain-memory-worker start -- repair-evidence
pnpm --filter @_89/super-brain-memory-worker start -- repair-evidence --confirm
```

`jobs` reports aggregate ledger coverage (pending, waiting, retry, blocked, completed, excluded, exhausted, per kind) and sanitized scheduler counters. It holds the ledger lease briefly; while a watcher owns the namespace it prints the watcher's last published processing status instead. `blocked` work is preserved but never drained automatically (exhausted episode attempts, oversized singleton episode windows, changed episode policy, or a corrupt window checkpoint); `retry-jobs --confirm` makes blocked, waiting and retrying jobs runnable again. Terminal records are never removed.

The active ledger is capped at 10,000 jobs. When the cap is reached, intake pauses before the transport acknowledgement and resumes as durable work drains; no source is dropped. The watcher subscribes to `transcript.run-imported`, `terminal.observation`, `trajectory.recorded`, `trajectory.outcome-recorded`, `memory.recorded`, `memory.revised`, `transcript.derivation-chunk-recorded` and `transcript.chunk-imported`, and batches cursor checkpoints every 100 events because every delivered event is durably scheduled before its callback returns; an abrupt crash redelivers at most that batch, which deterministic job identities deduplicate.

`queue-backfill` is an explicit historical inventory. The default dry run only reads authorized run metadata (no vault, model, ledger or proposal writes). `--confirm` enqueues exactly the watcher's `extract-run` identities, reports `queued`/`existing`/`unavailable`, and can be repeated after a partial run. `--limit` bounds the run count. Transcript imports captured in a private space or creator scope are never extracted into unscoped output; they are reported as unavailable.

`repair-evidence` restores candidate evidence missing from accepted memories (memories that predate evidence propagation). The default is a dry run. Confirmed repairs use attributed evidence contributions with deterministic command stamps and the current memory revision, so content, scope and creator are unchanged and a replay is idempotent. Forgotten memories are skipped, never recreated. Rate-limit responses are retried at most three times using the server's retry delay.

### Ingestion cursor migration and audited reset

```sh
pnpm --filter @_89/super-brain-memory-worker start -- migrate-cursor
# Stop the watcher first. This initializes missing ingestion progress at zero.
pnpm --filter @_89/super-brain-memory-worker start -- migrate-cursor --confirm
pnpm --filter @_89/super-brain-memory-worker start -- reset-cursor --expected-sequence 1234 --reason "Repair incomplete ingestion replay"
# Stop ALL instances of this consumer first, including on other hosts.
pnpm --filter @_89/super-brain-memory-worker start -- reset-cursor --expected-sequence 1234 --reason "Repair incomplete ingestion replay" --confirm
```

Previews only read cursor metadata and create no local state. Confirmation holds the same ledger lease as the watcher for its authenticated namespace (state root, organization, workspace, principal, audience and space), so it fails while that watcher runs. `migrate-cursor` never rewinds existing ingestion progress. `reset-cursor` atomically checks the exact observed sequence, records actor, positions, reason (10 to 2000 characters) and time, and resets that same consumer to zero; a stale expected cursor fails. The lease protects only this host: reset has no distributed generation fence, so stop every instance first. Jobs and terminal receipts are retained; restart the same watcher to replay. For a large replay, `--no-continuous-cognition` and `--no-episodes` avoid scheduling historical model work.

The previous plaintext processing spool (`FOLD_MEMORY_PROCESSING_ROOT`, `--processing-root`) has been superseded by the encrypted job ledger; both settings are accepted as aliases for the ledger state root. Its old `active/` records are not imported; replay or `queue-backfill` re-derives the same work.

## Episode formation

`watch` forms project-scoped work episodes unless `--no-episodes` is given. `--episode-every` (default 25 eligible events) and `--episode-elapsed-ms` (default 300000 ms of processing time from a window's first arrival) seal windows; an explicit non-unknown trajectory outcome seals one as completion, and 200 sources seal it as capacity. Windows are partitioned by exactly one verified project and publication scope. Unknown, ambiguous, multi-project, private and space-scoped sources are excluded with counters, never mixed into workspace output; the initial episode policy supports unscoped workspace publication only.

The window scheduler's state and outbox are encrypted checkpoints inside the worker's leased job ledger and are written before the transport acknowledgement. Replays never recount an ingestion sequence. A changed episode policy starts at the subscriber's current committed position; jobs under an old policy are blocked for review, not reinterpreted.

Episode jobs run in the model lane. They persist the selected optional context (at most five recent same-project, same-publication episodes) and the complete prepared result before publication, so a lost response republishes without a second model call. Publication revalidates source access and hashes. A conflict discards the prepared output for a fresh retry. On an input-size refusal the same sources first retry without optional context, then split deterministically into two child windows that retain parent provenance and every source; an oversized singleton stays blocked.

```sh
pnpm --filter @_89/super-brain-memory-worker start -- queue-episodes --project-id PROJECT --event-id EVENT_A --event-id EVENT_B
pnpm --filter @_89/super-brain-memory-worker start -- queue-episodes --project-id PROJECT --event-id EVENT_A --event-id EVENT_B --confirm
```

`queue-episodes` queues 1 to 200 chosen canonical events for one exact project without resetting any consumer. Preview performs authorized reads only; confirmation (with the watcher stopped) queues one manual window whose identity is the sorted source ID/hash set and policy, so duplicate invocations reuse it. Any inaccessible or mismatched source refuses the whole set.

Gemini and Hermes JSON archives are read with the importer's turn allocation, so their dialogue evidence keeps canonical turn identity; Gemini thought parts and tool output never become dialogue evidence.

The watcher credential needs `events:read`, `consumers:read`, `consumers:write`, `transcripts:read`, `memories:read`, and `memories:write`. Continuous cognition additionally uses `reasoning:read`. Optional permission or provider failures retain their jobs and do not stop deterministic extraction.

Cognition has a separate single-concurrency processing lane. It resolves either `SUPER_BRAIN_COGNITION_PROVIDER` or the configured default model to its actual provider ID and configuration revision. Jobs identify the exact prompt and current memory revisions; both the worker and API recheck references, and changed/forgotten sources cannot yield current synthesized claims. Canonical applicability determines project coverage. Model output is encrypted before downstream proposals, so a proposal retry reuses the output. Provider requests are cancelled after 30 seconds or at shutdown. Three transient model failures exhaust that job; explicit retry starts another bounded attempt. Model output always remains reviewable.

Automatic promotion requires `--auto-promote` and an explicitly configured capture witness verifier:

- `SUPER_BRAIN_TRUSTED_CAPTURE_SENSOR`
- `SUPER_BRAIN_TRUSTED_CAPTURE_STATE_ROOT`
- `SUPER_BRAIN_TRUSTED_CAPTURE_VAULT_ROOT`
- `SUPER_BRAIN_TRUSTED_CAPTURE_RECEIPT_KEY_FILE`
- `SUPER_BRAIN_TRUSTED_CAPTURE_VAULT_KEY_FILE` when capture artifacts are encrypted

Only an exact extracted project-scoped human decision with successful, tenant-bound, authenticated task/attempt/revision acceptance may auto-promote. XML tags, confidence scores, sensor labels, and ordinary tool success do not confer approval. Earlier different content cannot inherit a later approval. The service credential must also have central API permission to review that memory audience; a local witness does not grant workspace review access. Human failure decisions remain reviewable. A reasoning checkpoint may auto-promote only after a finalized trajectory has an exact private receiver witness, a successful witnessed acceptance for its task, attempt and final public revision, and an exact checkpoint event/content/artifact membership match. Checkpoints remain pending while witnesses are unavailable; encrypted verification jobs survive restarts. Modified trajectories, unrelated approvals, and copied checkpoint labels cannot confer authority. Native artifact coverage separately reports verified stored bytes versus readable legacy artifacts without stored-byte attestations.

On macOS, `install-service` writes an owner-readable launchd configuration. It carries the state, provider, space, vault, and trusted-capture settings above. `--replay-all` replays delivery while reusing durable job identity. SIGINT/SIGTERM abort owned requests, settle processing, and release the lease.

The process-level lease regression imports the built worker output. Run the workspace build before the worker test suite, as in CI.

The CLI publishes a sanitized, owner-only processing status file beside its job
state (`processing-status.json`), or at `SUPER_BRAIN_WORKER_STATUS_FILE`. It
contains the authenticated subject, observation time, aggregate job state/kind
counts and oldest-work lag. It contains no job payloads, model output, token,
source text or vault paths. Publication failure logs a generic warning and does
not interrupt processing. Shutdown publishes `stopped` after settling owned work.
Configure capture's `SUPER_BRAIN_WORKER_STATUS_FILE` to that same explicit file
for its operator-only `/processing` bridge. The bridge rejects a different
workspace, stale status, unsafe files or a stopped worker, and returns only
aggregate coverage to the browser. An absent bridge means status is unavailable;
it does not imply that processing is idle or complete.
