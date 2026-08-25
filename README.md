# Super Brain

Implementation workspace for the Fold Platform described in
[`Fold_Platform_Super_Brain_Unified_Reference_v8.md`](./Fold_Platform_Super_Brain_Unified_Reference_v8.md).

The first milestone is the risk-retirement gate from the reference document:

- preserve the verified v0.6 Change Record baseline;
- define the normative v0.7 F1/F2/F3 amendments;
- implement those rules in `@_89/fold`;
- make the required conformance cases executable.

## Packages

- `@_89/fold` implements the v0.7 Change Record schema, deterministic replay,
  inclusive fork cursors, provenance/capture metadata, and sensor lifecycle
  freshness.
- `@_89/fold-trace` implements the projection feasibility contract, coverage,
  mapped-edge aggregation, first-divergent-edge analysis, tool-call divergence
  mining, and support-based structural merge. Its current two-model experiment
  is a structural fixture, not empirical model evidence.
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
- `@_89/fold-drives` incrementally advances drive and wear state, records causal
  discontinuities as canonical Fold events, and rebuilds surfaced, committed,
  declined, acted, and ended intentions without performing host cognition.
- `@_89/fold-epistemic` records, revises, forgets, and recalls personal memory
  with mandatory workspace and creator identity, current space access, durable
  tombstones, and post-ranking authorization for external semantic candidates.
- `@_89/fold-sdk` provides journal-compatible producer and consumer APIs with
  capture-scope enforcement, canonical ordering, access-filtered projection,
  personal-memory lifecycle, trajectory task/report facades, and replay-built
  fleet reads over validated activity signals.
- `@_89/super-brain-api` serves those SDK operations over authenticated HTTP,
  derives authorship and personal-memory capture identity from credentials,
  resolves membership on every request, and persists one fsynced journal per
  workspace.
- `@_89/super-brain` is the responsive operator client for workspace activity,
  private personal-memory lifecycle, trajectory import and analysis, agent
  fleet inspection and local simulation, canonical/draft event inspection, and
  materialized Fold state. It talks only to the local HTTP API.
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

The repository remains private. New Fold packages are `UNLICENSED` until package
ownership and release terms are settled; the imported confidence kernel retains
its MIT license.
