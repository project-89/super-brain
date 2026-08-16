# Extraction Blueprint

This document turns the referenced repositories into a concrete implementation
plan for Super Brain. The destination packages in this repository are the source
of truth. Referenced repositories remain independent products and serve only as
pinned source material and behavioral evidence.

## Extraction Rules

1. Production packages must not import code from sibling repositories in
   `/Users/jakobgrant/Workspaces`.
2. Every imported implementation is pinned to a commit recorded in
   `EVIDENCE_MANIFEST.md` and carries its applicable license and provenance.
3. Dirty worktree files are not imported unless they are explicitly reviewed and
   recorded. The committed baseline is the default extraction source.
4. Behavior is established locally with conformance tests and golden fixtures.
   Producer-specific conversion, when needed for a fixture, lives under `test/`
   and is not a production adapter.
5. Code is copied only when its contract already fits the target package. Code is
   adapted when the behavior is reusable but its host types or storage are not.
   A clean-room implementation is preferred when only the observed behavior or
   design rule is reusable.
6. Sharing changes back to Mythopia or another producer is a later decision,
   after the equivalent local package has reached parity and its API has settled.

## Package Graph

The intended dependency direction is:

```text
@_89/fold                    @_89/confidence-kernel
    |                                  |
    +--> @_89/fold-storage             |
    +--> @_89/fold-trace --------------+--> @_89/fold-eval
    +--> @_89/fold-narrative
    +--> @_89/fold-activity --> @_89/fold-fleet
    +--> @_89/fold-epistemic
    +--> @_89/fold-drives
                     |
                     +--> @_89/fold-sdk --> apps/api, apps/brain
```

The diagram shows allowed direction, not a requirement that every pack depend on
every preceding package. In particular, `@_89/confidence-kernel` remains an
orthogonal value algebra and does not become part of the Change Record schema.

| Target | Responsibility | Initial source material | Status |
| --- | --- | --- | --- |
| `@_89/fold` | Change Record schema, ordering, lifecycle, replay, projections | v0.6 spec, v0.7 amendments, Mythopia fold semantics | Implemented |
| `@_89/confidence-kernel` | History scoring, drift, pooling, oracle, journals | confidence-kernel 0.2.0 | Imported |
| `@_89/fold-storage` | JSONL journal, replay, checkpoints, strict reopen | pty-state-capture replay; Mythopia store fixtures | Implemented |
| `@_89/fold-trace` | Trace projection, coverage, divergence, structural merge | decision-pathfinder; reasoning-tree | Implemented |
| `@_89/fold-eval` | Verdict parsing, oracle execution, confidence aggregation | Parallax; confidence-kernel | Implemented |
| `@_89/fold-narrative` | Canon, character knowledge, arcs, curves, convergence | Mythopia | First parity slice implemented |
| `@_89/fold-activity` | Captured observations, normalization, sensor lifecycle | pty-state-capture; tmux-manager; Haunt contract | Terminal canonical slice implemented |
| `@_89/fold-fleet` | Agent/session identity, heartbeats, status, orphan recovery | tmux-manager; Parallax | Replay and orphan core implemented |
| `@_89/fold-epistemic` | Scoped memory and recall-time access enforcement | Raven | Gated on second-pass inventory |
| `@_89/fold-drives` | Incremental intention/metabolism state | Embers | Drive, wear, and intention core implemented |
| `@_89/fold-sdk` | Stable producer and consumer APIs over the packages above | Local packages only | Planned |
| `apps/api`, `apps/brain` | Service and work-focused view layer | Local SDK; Raven Docs UI patterns where useful | Planned |

## Source-to-Target Map

The paths below are relative to each repository named in the first column. The
commit for every repository is in `EVIDENCE_MANIFEST.md`.

| Source | Code or behavior to borrow | Destination | Method and parity bar |
| --- | --- | --- | --- |
| confidence-kernel | `src/{score,drift,pool,oracle,curate,journal,types}.ts` and tests | `packages/confidence-kernel` | Copy the clean 0.2.0 committed files. Preserve its golden decision-pathfinder and Parallax cases. |
| mythopia | `src/core/store.ts`: `CanonStore`, `WorldState`, `resolvedPeaks`, `foldToEvent`; `src/core/time.ts` | `packages/fold-narrative` and `packages/fold-storage` | Adapt domain state onto canonical `@_89/fold` records. Match the pinned Fellowship results and add same-time, bare-reopen, and late-joiner fixtures. Do not copy its derived time or visibility semantics into the core record contract. |
| mythopia | `src/engines/query.ts`: `knows`, `arcJourney` | `packages/fold-narrative` | Adapt as pure projections. Prove conceal precedence and static-membership parity locally. |
| mythopia | `src/engines/convergence.ts` and `src/engines/curves.ts` | `packages/fold-narrative` | Copy or adapt pure numerical functions after fixtures pin unrounded outputs, twin peaks, and convergence behavior. |
| pty-state-capture | `src/replay.ts`: `replayRawJsonl`, `replayTurns`; `src/jsonl-writer.ts` journal behavior | `packages/fold-storage` | Reimplemented as versioned Change Record JSONL with streaming replay, serialized appends, byte-stable rewrite, strict recovery policy, and verified checkpoints. |
| pty-state-capture | `src/normalize.ts`, `src/state-rules.ts`, capture types | `packages/fold-activity` | Reimplemented normalization and bounded classification behind sensor-produced observations. Classifier results remain observed assertions with classifier method provenance. |
| pty-state-capture | `src/session-diff.ts`: `diffTranscripts`, `jaccardSimilarity` | `packages/fold-trace` test/tooling surface | Copy only if trace evaluation needs transcript comparison; no core dependency. |
| tmux-manager | `src/tmux-manager.ts` transition re-emission table; `src/tmux-session.ts` stall timers; `StallClassification` | `packages/fold-activity`, `packages/fold-fleet` | Event contract reimplemented without tmux host coupling. Local fixtures pin lifecycle, heartbeat, stall, prompt, tool, completion, classification, and identity/scope behavior. |
| hauntjs | Sensed-log discipline documented by the project | `packages/fold-activity` | Adopted as a contract only: observation/belief separation, reversible compression, lifecycle coverage, and heartbeat semantics. No runtime implementation imported. |
| decision-pathfinder | `src/recommendation/RecommendationEngine.ts`: `analyzeHistory`, `edgeOutcomes`; path interfaces | `packages/fold-trace`, `packages/fold-eval` | Adapt pure aggregation and first-divergent-edge behavior. Test deterministic tie-breaking and empty history. |
| reasoning-tree | `src/compiler/trace-divergence.ts`: `normalizeArgs`, `branchKey`, `entropyOfCounts`, `analyzeTraceDivergence`; `structural-merge.ts` | `packages/fold-trace` | Reimplemented against package-owned tool-trace types. Pure parity fixtures cover normalization, divergence filters, prior outputs, support, caps, and merge order. Host compiler and model code are excluded. |
| Parallax | `packages/control-plane/src/org-patterns/review-verdict.ts`; `workflow-executor.ts` verification funnel | `packages/fold-eval` | Extract the parser and oracle contract. Honor configured combine strategy; reject unknown oracle types as schema errors; represent known-but-absent results as neutral. |
| Parallax | `packages/control-plane/src/org-patterns/decision-history.ts`: `scoreDecisionHistory` | `packages/fold-eval` tests | Retain as parity evidence for confidence-kernel rather than duplicating the scoring implementation. |
| Parallax | connection, spawn, status, and orphan-recovery behavior | `packages/fold-fleet` | Reimplemented as a pure Fold-event projection with boot reconstruction, immutable identity, heartbeat freshness, and orphan timeout tests. Runtime actuation remains adapter work. |
| narrative-canon | Five generator choke points in `image-generator.ts`, `gpt-image-generator.ts`, `video-generator.ts`, `seedance-generator.ts`, `music-generator.ts` | `packages/fold-activity` contract | Define generation-lineage records locally. Narrative Studio instrumentation remains in its own repository until the contract is proven. FABLE is a film fixture/agent name, not this codebase. |
| Embers | `docs/design/v0.3/intention.md`; drive, wear, causal-log, pressure, and intention symbols | `packages/fold-drives` | Reimplemented as immutable incremental state plus canonical samples and discrete records. Exact threshold, clamp-order, wear, intention, urgency, and eligibility fixtures pass locally. Practices, capabilities, prose, and host cognition are excluded. |
| Raven | UUIDv7 ordering, workspace/space/creator scope, memory and access-control behavior | `packages/fold-epistemic`, `apps/brain` | Gated on the second-pass write-path, schema, and guard inventory. Reuse UI patterns only after core behavior is local. |

## Implementation Order

1. **Spine:** finish `@_89/fold` conformance and keep the v0.6 evidence file
   immutable. This package is already underway.
2. **Confidence:** import `@_89/confidence-kernel` 0.2.0 as an independently
   tested workspace package.
3. **Narrative parity:** build `@_89/fold-narrative` around local canonical
   records and port the Mythopia golden behavior. No runtime Mythopia adapter.
4. **Durability:** JSONL replay, checkpoints, strict reopen, and corrupted-input
   tests are implemented in `@_89/fold-storage`.
5. **Judgment:** reasoning-tree inventory, trace mining/merge, decision-path
   parity, and standalone eval/oracle primitives are implemented.
6. **Sensing and fleet:** terminal normalization, canonical lifecycle and
   observations, complete source identity, heartbeat freshness, boot
   reconstruction, and orphan planning are implemented. Producer wiring and
   runtime actuation remain host integrations.
7. **Domain completion:** the drive, wear, and intention core is implemented.
   Raven memory and recall-time access enforcement are the remaining domain
   inventory and implementation milestone.
8. **Delivery:** expose settled APIs through `@_89/fold-sdk`, then build the API
   and Raven-inspired view layer exclusively against local packages.

## Drive Parity Status

`@_89/fold-drives` owns its state, records, and replay API:

1. Drive and wear state advances immutably and step by step.
2. The pinned 48-hour path retains the exact `19/24` chronic load, including the
   floating-point threshold crossing that closed-form replay misses.
3. Explicit samples restore continuous state; satiations and wear transitions
   retain discrete causal evidence.
4. Canonical intention records replay deterministically and fail closed on
   missing origins, duplicate resolution, inactive actions, and cap overflow.
5. Eligibility only signals candidates. Hosts own perception, quiet detection,
   aim authorship, adjudication, and action.

The detailed source and exclusion map is in
`docs/inventory/DRIVES_SOURCES.md`.

## Narrative Parity Status

The first `@_89/fold-narrative` slice is deliberately narrow and complete:

1. Narrative state and projection types are owned by this repository.
2. Pinned Mythopia input is retained under
   `packages/fold-narrative/test/fixtures/mythopia/`.
3. `knows`, `arcJourney`, resolution peaks, tension/stakes/felt-intensity curves,
   convergence, climaxes, cascades, and counterpoints run over canonical Fold
   records.
4. Focused Fellowship expectations pin group knowledge, arc curves, the Moria
   peak, Amon Hen maximum, and the bridge cascade. Unrounded numeric values are
   asserted directly.
5. Super Brain cases cover conceal precedence, same-time ordering, bare reopen,
   and a late-joining group member.

Any one-time fixture conversion belongs under `test/compat/mythopia/`. There is
no `src/adapters/mythopia` package in this phase. Completion means the local API
and fixtures stand alone after `/Users/jakobgrant/Workspaces/mythopia` is removed
from the module resolution and test environment.

Not yet claimed as extracted: occupancy and containment, effective location
rules and travel, mood decay, salience/pace/theme/irony curves, lint rules,
editions, and rendering. Those remain separate follow-on slices rather than
implicit coverage from the Fellowship fixture.

## Definition of Extracted

A source mechanic is considered extracted only when:

- its target package owns the types and public API;
- production code has no filesystem, package, or build dependency on the source
  repository;
- the source commit and applicable license are recorded;
- local tests demonstrate the claimed parity and Super Brain-specific
  conformance behavior; and
- root `pnpm verify` builds, typechecks, and tests the package.
