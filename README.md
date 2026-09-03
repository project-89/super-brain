# Super Brain

Implementation workspace for the Fold Platform described in
[`Fold_Platform_Super_Brain_Unified_Reference_v8.md`](./Fold_Platform_Super_Brain_Unified_Reference_v8.md).

The repository now contains the complete local vertical slice: authenticated
harness ingestion, a transactional PostgreSQL Fold, resumable event
subscriptions, historical transcript capture, automatic project-aware memory
formation, reviewed promotion, full-corpus recall, and an operator UI. The
original v0.7 risk-retirement gate remains covered by executable conformance
tests.

## Packages

- `@_89/fold` implements the v0.7 Change Record schema, deterministic replay,
  inclusive fork cursors, provenance/capture metadata, and sensor lifecycle
  freshness.
- `@_89/fold-trace` implements the projection feasibility contract, coverage,
  mapped-edge aggregation, first-divergent-edge analysis, tool-call divergence
  mining, support-based structural merge, and explicit verified/unknown outcome
  accounting. Its two-model test experiment remains a structural fixture, not
  empirical model evidence.
- `@_89/fold-trajectory` records shared decision trees and projected runs as
  scoped canonical Fold events, then rebuilds task coverage, observed routes,
  first divergence, and review-oracle results without hiding projection gaps.
- `@_89/fold-eval` implements the review verdict protocol, command oracle,
  fail-closed oracle configuration, explicit absent results, configurable
  confidence aggregation, and confidence-kernel history integration.
- `@_89/fold-activity` normalizes terminal output, classifies bounded recent
  state, preserves classifier provenance, and maps terminal manager signals to
  canonical lifecycle and observation records with complete source identity.
  Its envelope validator prevents generic or human-authored events from
  masquerading as terminal sensor evidence.
- `@_89/fold-fleet` reconstructs agent/session state from those records at boot,
  separates last-known status from lifecycle freshness, and plans timeout-gated
  orphan reconciliation without interpreting silence as offline.
- `@_89/fold-transcript` owns immutable project, artifact, source-qualified run,
  context-segment, turn, and observable-action records for historical Claude
  Code and Codex imports. Canonical records never contain transcript text or
  private reasoning.
- `@_89/fold-drives` incrementally advances drive and wear state, records causal
  discontinuities as canonical Fold events, and rebuilds surfaced, committed,
  declined, acted, and ended intentions without performing host cognition. The
  SDK and API expose that lifecycle as replayed human steering.
- `@_89/fold-epistemic` records, revises, forgets, and recalls personal memory
  plus immutable memory proposals, decisions, evidence revisions, and usefulness
  feedback. Memory is explicitly scoped by workspace, optional space, audience,
  and projects; access is reapplied after external ranking.
- `@_89/fold-sdk` provides journal-compatible producer and consumer APIs with
  capture-scope enforcement, canonical ordering, access-filtered projection,
  personal-memory lifecycle and authorized ranker orchestration, trajectory
  task/report facades, replay-built fleet reads over validated activity signals,
  and idempotent transcript import/catalog queries.
- `@_89/fold-postgres` is the transactional production store for canonical
  events, durable consumer offsets, and rebuildable projection checkpoints. Its
  optional pgvector ranker is derived from authorized memory and never becomes
  canonical state.
- `@_89/super-brain-client` is the harness-neutral authenticated client for
  append, recall, candidate review, resumable SSE, and principal-scoped durable
  consumer offsets. Codex, Claude, Hermes, or another harness can use the same
  boundary without a repository-specific adapter.
- `@_89/super-brain-api` serves those SDK operations over authenticated HTTP,
  derives authorship and personal-memory capture identity from credentials,
  resolves membership on every request, supplies a pluggable memory-ranker port
  with a deterministic local lexical provider, supplies a pull-reasoner port
  with an explicitly extractive local provider, and gates canonical steering.
  It uses transactional PostgreSQL for multi-process canonical persistence,
  durable consumer offsets, and projection checkpoints when
  `FOLD_DATABASE_URL` is configured; the fsynced JSONL store remains the local
  fallback and migration source.
  Owner-authorized transcript imports and workspace-readable history queries use
  dedicated routes that cannot be bypassed through generic event append.
  Its runtime adds exact-origin CORS, bounded per-address request limiting,
  connection timeouts, graceful lease-releasing shutdown, and an in-process
  validated-entry cache held behind the exclusive writer lease.
- `@_89/super-brain` is the responsive operator client for workspace activity,
  private personal-memory lifecycle and ranked recall, trajectory import and
  analysis, historical project/run inspection, live agent fleet inspection,
  pull reasoning, human steering, canonical/draft event inspection, and
  materialized Fold state. It talks only to the local HTTP API.
- `@_89/super-brain-importer` streams local Claude Code and Codex JSONL, performs
  metadata-only dry runs, writes explicitly requested redacted artifacts to a
  restrictive local vault, and delivers confirmed canonical bundles through
  the authenticated API without modifying source histories.
- `@_89/super-brain-capture-daemon` is the loopback-only live sensor for Claude
  Code, Codex, and compatible harnesses. It durably spools lifecycle, prompt,
  tool, file, verification, structured-reasoning, decision, trajectory, and
  final transcript-import work before acknowledging a hook. Raw prompt and tool
  bodies stay in its secret-redacted private vault rather than canonical Fold.
- `@_89/super-brain-memory-worker` reads only the redacted transcript vault,
  proposes deterministic project-aware memories, consolidates repeated evidence,
  and consumes transcript, live-checkpoint, decision, and trajectory events from
  a durable cursor. A narrow opt-in policy automatically promotes high-confidence
  structured observations, explicit human decisions, and reasoning checkpoints
  cited by a verified successful trajectory; ambiguous proposals remain reviewable.
- `@_89/super-brain-mcp-server` gives any MCP-compatible harness authenticated
  memory search, cited context assembly, structured checkpoint and proposal
  capture, and immutable helpful/unhelpful/superseded feedback tools.
- `@_89/confidence-kernel` is the pinned 0.2.0 history-scoring, drift, pooling,
  oracle, and journal implementation imported under its MIT license.
- `@_89/fold-narrative` projects canonical Fold events into arc state,
  apply-time knowledge, journeys, curves, resolution peaks, and convergence. Its
  first slice is pinned to the Mythopia Fellowship fixture without a production
  Mythopia adapter.
- `@_89/fold-storage` provides versioned JSONL append/replay, strict reopen,
  torn-tail recovery, atomic rewrites, and verified materialized-state
  checkpoints. Its format is specified in
  [`docs/storage/JSONL_FORMAT_v1.md`](./docs/storage/JSONL_FORMAT_v1.md).

The target package graph, source ownership rules, and per-repository extraction
map are recorded in
[`docs/EXTRACTION_BLUEPRINT.md`](./docs/EXTRACTION_BLUEPRINT.md). Referenced
repositories are prior art and behavioral evidence; production packages here do
not depend on their worktrees.

This repository does not modify the referenced repositories in
`/Users/jakobgrant/Workspaces`. Their observed baselines are recorded in
[`docs/EVIDENCE_MANIFEST.md`](./docs/EVIDENCE_MANIFEST.md).

## Commands

```bash
pnpm install
pnpm verify
```

Local client setup and proxy configuration are documented in
[`apps/brain/README.md`](./apps/brain/README.md).
Historical transcript identity, privacy, import, and query behavior is recorded
in [`docs/TRANSCRIPT_INGESTION.md`](./docs/TRANSCRIPT_INGESTION.md).
The live architecture, memory lifecycle, harness contract, and PostgreSQL
operations are documented in [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).
The implemented critical-path ledger and remaining deployment choices are in
[`docs/ROADMAP.md`](./docs/ROADMAP.md).

The repository remains private. New Fold packages are `UNLICENSED` until package
ownership and release terms are settled; the imported confidence kernel retains
its MIT license.
