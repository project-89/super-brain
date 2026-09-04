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

`scan` reports candidates without writes. `backfill` uses deterministic candidate IDs and batches up to 100 proposals. `watch` subscribes to transcript run events and commits its durable consumer offset only after extraction and proposal succeed.

`--auto-promote` applies a deliberately narrow trusted policy. Structured
Claude-Mem observations require confidence of at least `0.95` and a resolved
project. Explicit project-scoped human decisions qualify immediately. Live
reasoning checkpoints qualify only when a verified successful trajectory cites
their exact event. Rule-derived and unresolved global candidates remain in
review. Equivalent accepted memories accumulate new causal evidence through
revisions rather than duplication. Proposals and promotions are each committed
in atomic batches of at most 100.

On macOS, `install-service` creates an owner-readable `launchd` service that
runs the durable watcher with automatic promotion. Pass `--no-auto-promote` to
install a proposal-only watcher or `--replay-all` for an intentional full replay.

The built-in `durable-transcript-memory` rule extractor recognizes structured Claude-Mem observations plus explicit durable decisions/preferences. Its ID and version are stored on every candidate. A model-backed extractor can be added under a different extractor identity without changing the event, review, or promotion contracts.
