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
@_89/fold --> fold-storage, fold-narrative, fold-trace, fold-activity,
             fold-epistemic, fold-drives, fold-transcript
@_89/confidence-kernel --> fold-eval
@_89/fold-trace --> fold-eval
@_89/fold-activity --> fold-fleet
@_89/fold-trace + fold-eval + fold-epistemic --> fold-trajectory
@_89/fold + fold-activity + fold-fleet + fold-epistemic + fold-trajectory + fold-transcript --> fold-sdk
@_89/fold-sdk + fold-storage --> apps/api --> apps/brain
fold-transcript --> apps/importer --> apps/api
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
| `@_89/fold-activity` | Captured observations, normalization, sensor lifecycle | pty-state-capture; tmux-manager; Haunt contract | Terminal canonical and envelope-validation slice implemented |
| `@_89/fold-fleet` | Agent/session identity, heartbeats, status, orphan recovery | tmux-manager; Parallax | Replay, orphan, SDK/API, and operator-view core implemented |
| `@_89/fold-transcript` | Historical project, artifact, run, turn, and observable-action metadata | Claude Code and Codex local JSONL formats | Implemented |
| `@_89/fold-epistemic` | Scoped personal memory and recall-time access enforcement | Raven | Recall-enforced personal memory core implemented |
| `@_89/fold-drives` | Incremental intention/metabolism state | Embers | Drive, wear, and intention core implemented |
| `@_89/fold-trajectory` | Scoped tree/run lifecycle and task analysis | Local `fold-trace` and `fold-eval` contracts | Implemented; empirical runs pending |
| `@_89/fold-sdk` | Stable producer and consumer APIs over the packages above | Local packages only | Scoped log, memory, trajectory, activity, fleet, and transcript core implemented |
| `apps/importer` | Read-only historical source adapters and local redacted vault | Local Claude Code and Codex JSONL | Scan and confirmed API delivery implemented |
| `apps/api` | Authenticated service over the local SDK | Local packages only | Event, projection, memory, trajectory, transcript, fleet, steering, and reasoning HTTP core implemented |
| `apps/brain` | Work-focused operator view | Local API; Raven Docs UI patterns where useful | Memory, history, event, state, trajectory, fleet, steering, and reasoning workflows implemented |

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
| Raven | UUIDv7 ordering, workspace/space/creator scope, memory lifecycle and access-control behavior | `packages/fold-epistemic`, `apps/brain` | Clean-room core implemented after pinned schema, write-path, vector-recall, and guard inventory. Local tests correct missing post-ranking creator and explicit space checks. The client adapts committed shell, compact filter, list/detail, and metadata interaction evidence without importing Raven code. |

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
   reconstruction, orphan planning, scoped SDK/API delivery,
   and the operator view are implemented. Authenticated external sensor wiring
   and runtime actuation remain host integrations.
7. **Domain completion:** drive, wear, intention, personal memory, tombstone,
   and recall-time access cores are implemented. Raven vector search and UI stay
   host concerns rather than core dependencies.
8. **Delivery:** `@_89/fold-sdk` exposes scoped journal, projection,
   personal-memory, trajectory, activity, fleet, and transcript APIs. `apps/api` serves that boundary with
   authenticated authors, fresh membership, and durable per-workspace journals.
   The repository-owned view layer covers overview, personal-memory,
   trajectory-analysis, historical project/run, fleet, event, and projected-state workflows against this API.
   Add other domain facades only when product workflows require them.

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

## Epistemic Parity Status

`@_89/fold-epistemic` owns personal memory state and the authorization point:

1. UUIDv7 memories, revisions, and forget records carry explicit workspace,
   optional space, creator, event capture, and authored provenance.
2. Replay is deterministic and fails closed on duplicates, stale or post-forget
   mutations, scope mismatch, and principal spoofing.
3. Creator privacy is mandatory even for workspace administrators; current
   space membership is checked on write and on every recall.
4. Metadata recall and externally ranked semantic candidates share the same
   post-ranking access enforcement, closing the gap found in Raven's pinned
   semantic branch.
5. Persistence, embeddings, vector ranking, memberships, clocks, UUID
   generation, transports, and UI remain delivery-layer responsibilities.

The detailed source, license, finding, and exclusion map is in
`docs/inventory/EPISTEMIC_SOURCES.md`.

## SDK Delivery Status

The first `@_89/fold-sdk` slice establishes the service-facing boundary:

1. A minimal asynchronous store port is satisfied directly by the local
   `FoldJournal` and keeps filesystem concerns out of the SDK bundle.
2. Appends validate canonical events, capture scope, duplicate IDs, and
   same-time producer ordering before writing.
3. Reads enforce current workspace, creator, and space access before returning
   records or building Fold state; raw personal-memory projections are not part
   of the public API.
4. Cursors are explicit inclusive `(t, eventId)` values. Canon/draft inclusion
   is never implicit, and malformed read configuration fails closed.
5. Personal-memory mutation and recall delegate to `fold-epistemic`, including
   tombstones, revocation, indistinguishable absent/denied mutations, and
   semantic candidate reauthorization.
6. Shared decision trees and trajectory runs delegate to `fold-trajectory`;
   task reports preserve mapped, ambiguous, and unmapped assignments and expose
   coverage, observed routes, first divergence, and review evaluation.
7. Terminal signals pass through `fold-activity` envelope validation and fleet
   reads rebuild authorized canonical records through `fold-fleet`, including
   freshness and deterministic orphan recovery plans.
8. Intention records pass through `fold-drives` envelope validation; lifecycle
   transitions are replay-validated before append and returned as JSON-safe
   per-actor steering state.
9. Transcript bundles pass through strict `fold-transcript` envelope validation;
   imports append only missing immutable project/artifact/run/chunk records and
   catalog reads remain workspace-authorized.

One SDK instance serializes its read-check-append operations. Authentication,
membership resolution, and HTTP transport now live in `apps/api`;
cross-process transactionality and ranker infrastructure remain follow-on work.

## API Delivery Status

`apps/api` supplies the first application boundary without importing Raven:

1. Static bearer credentials bind a principal and exact Fold author; only token
   digests remain in process and invalid configuration fails at startup.
2. Workspace and space membership is resolved for every request rather than
   cached into stored records or inferred after capture.
3. Generic event append, access-filtered listing, and materialized projection
   are exposed with canonical/draft and explicit cursor controls.
4. Personal-memory record, revise, forget, lookup, metadata recall, external
   candidate recall, and server-ranked search use server-derived creator and
   capture identity. Providers see only an authorized minimized corpus, and
   their output passes through post-ranking authorization.
5. Trajectory tree/run writes use server-derived collaborative scope and expose
   JSON-safe task analysis without accepting client-authored capture identity.
6. Workspace IDs become opaque hashed filenames. A singleton SDK serializes each
   workspace, complete-line journal appends are fsynced, and a single-host
   writer lease is acquired before the HTTP socket binds.
7. HTTP integration tests cover authentication, author spoofing, tenant and
   creator privacy, revocation, conflicts, validation, body limits, projection,
   memory lifecycle, and durable reopen.
8. Fleet reads are always replayed from received canonical sensor records. The
   API exposes no simulated activity mutation route.
9. Pull reasoning ranks authorized memory, optionally includes replayed actor
   state, validates citations, and reports whether its provider is extractive
   or model-backed without appending derived answers as canon.
10. Human steering is owner/admin-only, server-authored, and reserved from the
    generic event route; workspace members retain read access to replayed state.
11. Application routes have bounded per-address rate limiting, exact-origin CORS
    is available by configuration, and HTTP connection and shutdown lifetimes
    are bounded.
12. Owner/admin transcript imports use server-derived ingest identity, immutable
    replay validation, and idempotent retries; project/run history is readable to
    authorized workspace members and reserved from generic append.

Multi-host writer coordination, external identity providers, authenticated
external sensor credentials, recovery actuation, deployment TLS, distributed
proxy rate limiting, production embedding/vector/model infrastructure, and
automated salience producers remain explicit follow-on work.

## Brain Delivery Status

`apps/brain` supplies the first operational client without importing Raven:

1. A persistent responsive shell exposes overview, memory, history,
   trajectories, fleet, steering, events, and state.
2. Personal memory supports local filtering and provider-ranked recall with
   visible provider provenance, source/scope controls, record, revision, and
   explicit forget with server-derived creator identity.
3. Event and projection inspectors expose canonical/draft status, changes,
   nodes, edges, component values, and diagnostics without bypassing the API.
4. Trajectory tasks support JSON import, observed-path and coverage metrics,
   model-run selection, divergence/review status, and per-step assignment
   inspection through authenticated APIs.
5. Fleet workflows expose availability, status, freshness, immutable identity,
   canonical activity, and recovery plans without simulated controls.
6. Pull reasoning visibly distinguishes extractive/model providers and
   lexical/semantic ranking; actor steering supports the complete canonical
   candidate and intention lifecycle with capability-aware controls.
7. The bearer token is session-scoped; workspace and API URL preferences may be
   retained locally. Authentication and access failures remain visible.
8. Historical project/run workflows distinguish stable project identity from
   source-qualified runs and expose context, turn, action, artifact, and privacy
   metadata through authenticated APIs.
9. Browser identifier and API-client tests pin UUIDv7 timestamps, same-time
   event ordering, URL encoding, auth headers, memory payloads, and error maps.

Real two-model capture, production semantic embeddings/model reasoning,
automated salience producers, general graph layout, event authoring,
identity-provider login, and deployment-specific secret delivery remain
follow-on product work.

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
