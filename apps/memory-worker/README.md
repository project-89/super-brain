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

Proposal and contribution commands persist their stable event stamps before dispatch. Their timestamps follow canonical evidence and source-memory revisions, including when the worker clock is behind. Unknown acknowledgements reuse the same command. Evidence is batched in groups of at most 100 and merged without truncating historical support. Consolidation requires equal audience, owner where applicable, space, applicability, source, summary, and claim content. The built-in extractors explicitly distinguish claim content from source location; custom extractors require exact content equality. Replayed citations of the same run/turn are not independent support. A human correction to an accepted memory sends newly encountered old claims back to review; optimistic revision checks prevent a concurrent correction from receiving support meant for the old revision.

The watcher credential needs `events:read`, `consumers:read`, `consumers:write`, `transcripts:read`, `memories:read`, and `memories:write`. Continuous cognition additionally uses `reasoning:read`. Optional permission or provider failures retain their jobs and do not stop deterministic extraction.

Cognition has a separate single-concurrency processing lane. It resolves either `SUPER_BRAIN_COGNITION_PROVIDER` or the configured default model to its actual provider ID and configuration revision. Jobs identify the exact prompt and current memory revisions; both the worker and API recheck references, and changed/forgotten sources cannot yield current synthesized claims. Canonical applicability determines project coverage. Model output is encrypted before downstream proposals, so a proposal retry reuses the output. Provider requests are cancelled after 30 seconds or at shutdown. Three transient model failures exhaust that job; explicit retry starts another bounded attempt. Model output always remains reviewable.

Automatic promotion requires `--auto-promote` and an explicitly configured capture witness verifier:

- `SUPER_BRAIN_TRUSTED_CAPTURE_SENSOR`
- `SUPER_BRAIN_TRUSTED_CAPTURE_STATE_ROOT`
- `SUPER_BRAIN_TRUSTED_CAPTURE_VAULT_ROOT`
- `SUPER_BRAIN_TRUSTED_CAPTURE_RECEIPT_KEY_FILE`
- `SUPER_BRAIN_TRUSTED_CAPTURE_VAULT_KEY_FILE` when capture artifacts are encrypted

Only an exact extracted project-scoped human decision with successful, tenant-bound, authenticated task/attempt/revision acceptance may auto-promote. XML tags, confidence scores, sensor labels, and ordinary tool success do not confer approval. Earlier different content cannot inherit a later approval. The service credential must also have central API permission to review that memory audience; a local witness does not grant workspace review access. Human failure decisions remain reviewable. Trajectory checkpoint promotion is explicitly deferred to Phase 3's attested final revision and acceptance linkage; current trajectory labels are insufficient. Native artifact coverage separately reports verified stored bytes versus readable legacy artifacts without stored-byte attestations.

On macOS, `install-service` writes an owner-readable launchd configuration. It carries the state, provider, space, vault, and trusted-capture settings above. `--replay-all` replays delivery while reusing durable job identity. SIGINT/SIGTERM abort owned requests, settle processing, and release the lease.

The process-level lease regression imports the built worker output. Run the workspace build before the worker test suite, as in CI.
