# Super Brain Architecture

## System Shape

```text
Codex / Claude / Hermes / sensors / importers
                  |
        @_89/super-brain-client
        authenticated HTTP + SSE
                  |
          @_89/super-brain-api
                  |
             @_89/fold-sdk
       authorization + projections
                  |
          @_89/fold-postgres
 canonical events + offsets + checkpoints
                  |
     derived views, workers, and pgvector
                  |
       apps/brain and agent consumers
```

PostgreSQL is the canonical multi-process spine. Fold events are append-only;
memory, fleet, trajectories, transcript catalogs, and UI state are projections
rebuilt from those events. Consumer offsets and projection checkpoints are
durable operational records, not alternate sources of domain truth. The prior
JSONL journal remains a verified migration and recovery artifact.

## Harness Contract

Every authorized harness receives a bearer credential with explicit workspace
and optional space roles. It can append ordinary authenticated events, recall
authorized memory, propose memory, and subscribe to filtered Fold events. SSE
uses an exclusive `(t, eventId)` cursor. Durable consumer IDs are additionally
scoped by the authenticated principal, preventing two harnesses from moving one
another's offsets.

The client commits an offset only after its event handler succeeds. Transient
stream termination reconnects from the last committed cursor; authentication
and other non-retryable client failures fail closed. This is the same contract
for Codex, Claude, Hermes, or a future harness.

## Memory Lifecycle

```text
redacted transcript or live producer
  -> deterministic extraction
  -> memory.candidate-proposed
  -> policy or human decision
  -> memory.candidate-accepted + memory.recorded
  -> authorized project-aware recall
  -> lexical BM25 or optional pgvector ranking
```

A proposal contains source, content, project IDs, confidence, salience,
extractor identity/version, and immutable event/run/turn evidence. Proposals and
decisions are never hidden projection mutations. Accepted candidates create a
normal active memory with causal links to both the proposal and decision.

Automatic promotion is deliberately conservative: only structured ClaudeMem
observations at confidence `>= 0.95` with a resolved project qualify. Global
observations and rule-derived statements remain pending. This gives the system
automatic memory formation without silently treating ambiguous extraction as
truth.

Recall always applies current workspace, creator, space, audience, and project
authorization. Project queries also include intentionally global memories.
Rankers receive only the authorized corpus, and their candidates are
reauthorized before return. Response limits remain at 100 while ranking scans
up to 10,000 authorized memories.

## Semantic Layer

Lexical BM25 is complete and is the default. pgvector is a derived index enabled
only when a real HTTP embedding sidecar is configured. The sidecar accepts
`{ model, inputs }` and returns `{ embeddings }`; missing embeddings are sent in
batches of 64. Vector rows are partitioned by workspace and model, carry content
digests and revisions, and can be rebuilt from Fold memory at any time. No fake
or deterministic placeholder embedding is used.

## Local Operation

Required API configuration:

```bash
export FOLD_DATABASE_URL=postgres://user:password@127.0.0.1:5441/super_brain
export FOLD_API_CREDENTIALS_JSON='{"replace-token":{"principalId":"owner","workspaces":{"local-history":{"role":"owner"}}}}'
export FOLD_API_PORT=3003
pnpm --filter @_89/super-brain-api build
pnpm --filter @_89/super-brain-api start
```

Initial JSONL migration is exact and resumable:

```bash
FOLD_DATABASE_URL="$FOLD_DATABASE_URL" pnpm --filter @_89/fold-postgres migrate -- \
  --workspace local-history \
  --journal .data/fold-history/<workspace-hash>.jsonl
```

Transcript memory scan, confirmed backfill, and durable subscriber:

```bash
export SUPER_BRAIN_URL=http://127.0.0.1:3003
export SUPER_BRAIN_WORKSPACE=local-history
export SUPER_BRAIN_TOKEN=replace-token
export FOLD_TRANSCRIPT_VAULT=.data/transcript-vault

pnpm --filter @_89/super-brain-memory-worker start -- scan
pnpm --filter @_89/super-brain-memory-worker start -- backfill --confirm --auto-promote
pnpm --filter @_89/super-brain-memory-worker start -- watch --auto-promote
```

The browser client uses the same API and can be run through Vite's proxy:

```bash
FOLD_API_PROXY_TARGET=http://127.0.0.1:3003 \
VITE_FOLD_API_BASE_URL=/api \
VITE_FOLD_WORKSPACE=local-history \
VITE_FOLD_TOKEN=replace-token \
pnpm --filter @_89/super-brain dev
```

## Proven Local Corpus

The first migration retained 2,874 historical transcript Fold events covering
71 projects, 760 runs, 34,864 turns, and 142,787 observable actions. The first
memory census extracted 2,527 candidates, deduplicated them to 2,497 canonical
proposals, and promoted 1,967 high-confidence project-resolved observations.
The remaining 530 proposals are available for review. The durable subscriber's
cursor is caught up to the 760th run event.

## Deployment Boundaries

The implemented service has real persistence, authentication, authorization,
resumable streams, and automatic memory formation. A public or multi-host
deployment must still supply TLS termination, secret rotation or an external
identity provider, backups and restore testing, distributed rate limiting, and
an embedding sidecar when semantic ranking is desired. External sensors must
send authenticated real events; the API intentionally exposes no simulated
fleet mutation route.
