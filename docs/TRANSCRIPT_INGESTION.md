# Transcript Ingestion

Super Brain can harvest historical Claude Code and Codex sessions without
turning source directories or private reasoning into canonical state.

## Data Flow

```text
~/.claude/projects or ~/.codex/sessions
  -> streaming source adapter (read-only)
  -> canonical metadata bundle
  -> optional redacted local artifact vault
  -> owner-authorized API import
  -> Fold project/artifact/run/chunk events
  -> durable transcript-memory subscriber
  -> project-aware proposal and optional trusted promotion
  -> workspace-authorized SDK/API catalog
  -> Brain History view
```

`scan` is always metadata-only and performs no writes. `import` requires
`--confirm` and a vault path. Source JSONL is never modified.

## Identity Model

- A **project** is a deterministic identity derived from normalized working
  context. A sanitized repository remote is preferred when Codex supplies one,
  so separate checkouts remain one project; otherwise normalized working
  directory is used. It has a human-readable name and an explicit
  `resolved`, `estimated`, or `unassigned` resolution.
- A **run** is source-qualified as `claude-code:<native-id>` or
  `codex:<native-id>`. This prevents identical producer IDs from colliding.
- An **artifact** is content-addressed by SHA-256. The source path is represented
  only by a separate hash in canonical metadata.
- A **context segment** records a working-directory, repository, branch, or
  project change within a run instead of pretending the entire run had one
  context.
- Turns and observable actions have stable run-qualified IDs and ordinals.
  Large runs are divided into contiguous chunks with at most 500 turns and 500
  actions per record.

The SDK rebuilds this catalog deterministically. Changed identities, missing
references, chunk gaps, generic-event masquerading, and conflicting reimports
fail closed. An exact retry appends no events.

## Privacy Boundary

Canonical Fold records include counts, timestamps, roles, tool/action names,
status, source, model/client metadata, and project/run context. They do not
include prompts, assistant text, tool arguments/results, or transcript bodies.

Claude `thinking` blocks and Codex exposed reasoning are excluded by default;
encrypted content is always excluded. The capture daemon can opt into retaining
exposed reasoning in the private redacted vault, and records that choice as
`artifact.reasoningPolicy`. This never promotes reasoning text into canonical
Fold state. When import is explicitly confirmed, the importer writes a new JSONL
artifact to a `0700` content-addressed vault tree with `0600` files. An optional
AES-256-GCM key encrypts each redacted line independently with a random nonce;
authentication failure is fatal. Common token, key, password, bearer, AWS key,
and private-key patterns are replaced with `[REDACTED]`. The original file
remains untouched.

The adapter verifies file size and modification time across parsing and hashing,
and the vault writer verifies the source hash again before storage. A transcript
that changes during either phase is rejected for retry instead of producing a
mismatched artifact and metadata bundle.

`artifact.stored: true` means the importer successfully persisted that local
vault copy. The API stores only artifact metadata and does not serve or assume
access to client-local vault content. A remote or multi-user deployment needs a
separate encrypted artifact-store contract before transcript bodies can be
available server-side.

## Commands

Dry run:

```bash
pnpm --filter @_89/super-brain-importer build
pnpm --filter @_89/super-brain-importer start -- scan --source all
```

Confirmed local import:

```bash
FOLD_API_TOKEN=... pnpm --filter @_89/super-brain-importer start -- import \
  --source all \
  --api-url http://127.0.0.1:3000 \
  --workspace local \
  --vault ~/.super-brain/transcript-vault \
  --confirm \
  --resume
```

Use `--claude-root`, `--codex-root`, and `--limit` to scope a batch. API URL,
workspace, token, and vault also accept the environment variables documented in
`apps/importer/README.md`. `--resume` queries the authenticated run catalog and
skips IDs already committed to that workspace, which avoids repeating completed
work after interruption. The bearer token is never written to CLI output.

## Delivery Surface

- `POST /transcript-imports`: owner/admin strict bundle import.
- `GET /transcript-projects`: project summaries and run counts.
- `GET /transcript-projects/:id`: one project and its runs.
- `GET /transcript-runs`: all runs, with optional `projectId` and `source`.
- `GET /transcript-runs/:id`: run, artifact, projects, chunks, turns, and actions.

The routes are under `/v1/workspaces/:workspace`. Reads use current workspace
authorization. Transcript event kinds and node kinds are rejected by generic
event append.

## Memory Formation

`@_89/super-brain-memory-worker` reads only the redacted vault after metadata
has entered Fold. It recognizes structured ClaudeMem observations and explicit
durable transcript statements, attaches immutable run/turn/event evidence, and
resolves project roots from the transcript catalog. Candidate IDs are
deterministic, so a confirmed backfill is resumable and duplicate-safe.

Every extraction first becomes a `memory.candidate-proposed` event. With
`--auto-promote`, structured observations require confidence `>= 0.95` and a
resolved project. Explicit project-scoped human decisions also qualify. Live
reasoning checkpoints remain proposed until a verified successful trajectory
cites their exact event. Acceptance appends a decision and active memory
atomically; later equivalent observations append evidence through a revision.
Other rule-derived and unresolved global observations stay pending for review.
The `watch` command uses a principal-scoped durable consumer cursor and resumes
after API or network interruption.

## Current Limits

- Adapters tolerate unknown JSONL records and report their count; producer
  format changes still require fixture review.
- Project identity has no manual merge/split workflow yet.
- The local vault is durable local evidence, not a server-side content service.
- Historical imports cannot reconstruct ephemeral live signals that were never
  written to transcripts.
- Live Fleet population is supplied by the authenticated local capture daemon.
  Remote machines still require their own sensor credential and capture
  deployment; no simulated replacement is exposed.
