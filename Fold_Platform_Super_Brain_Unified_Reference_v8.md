# The Fold Platform / Super Brain — Unified Reference (v8)

*Post-verification + review-disposition edition. v7 preserved the evidence from the ten* *`REPORT_*.md`* *verification passes (2026-08-06); v8 incorporates the execution and spec dispositions from the 2026-08-14 architecture review. Verification-backed claims remain distinct from new normative design decisions. Nothing below rests on an unverified repository claim unless marked BLOCKED; newly adopted design rules are marked as dispositions where useful.*

**The deal, unchanged:** the super brain is the product, the anonymized eval exhaust is the price — teams deploy a central intelligence that sees their work; we harvest trajectory data; the sponsor gets DeepMind-grade step-level eval data across \~30 ventures.

---

## 0. What verification changed (read first)

**Done already (stop planning these):** all three `feat/wave2-improvements` branches are **merged** (0 ahead of main); all hosts on `@_89/confidence-kernel ^0.2.0`; `c2f3e0e` is on main — **do not cherry-pick it**; raven is fully pushed; the v0.2 `resolveEfficiency` API is shipped (`oracle.ts:93-95`); embers has a 24-case golden suite gating its fold refactor.

**The new #1 implementation blocker — the spec cannot express sensed capture (F3).** v0.6's `basis` is the closed enum `authored|estimated|derived` (SPEC:262); `author.kind` has no `sensor` (SPEC:613-614); `{basis, confidence, scale}` exist only on Event `magnitude`/`valence`, never on a Change; there is no `lifecycle` event kind. Canonical L0 record emission cannot ship until F3 settles. **Important distinction:** seam preparation, identity stamping, structured tees, and the projection feasibility spike are *not* blocked by F3. The spec v0.7 revision package (§2) and the projection feasibility spike (§3.3, §6) therefore run in parallel.

**Corrected premises:** the Fellowship suite is 28 it()/70 expect(), not 42; Narrative Studio has 30 generation call-sites collapsing to **5 choke points**, not \~78; Narrative Studio has **no user/session identity at all** (re-prompt lineage is entity-scoped only, for now); parallax has **no decision-tree system** (that's decision-pathfinder); the `foldToEvent` O(n²) list gains 5 server-side sites and loses the 3 fabula.ts entries (those are `foldTo`); haunt's sensed-log discipline is **100% doc-only** — a contract to adopt, zero code to import.

**Still unanswered after verification:** the attribution spike's feasibility (reasoning-tree items 2/3/4/6 BLOCKED — second pass needed) and raven's emission inventory + epistemic schemas (items 3/4/5/7 BLOCKED — second pass needed). **v8 disposition:** do not wait for the production trace stack to answer the projection question; run the smallest hand-built cross-model projection experiment now and let its result constrain `fold-trace` before that pack freezes.

---

## 1. The thesis (unchanged, now evidence-backed)

Two pure kernels + a discipline + packs:

- **`@_89/fold`** — event-sourced state kernel (4 derivations; \~700 LOC, zero deps; extraction still pending golden fixtures).
- **`@_89/confidence-kernel`** — ✅ npm 0.2.0, dual CJS+ESM, injectable-now verified clean, all three hosts migrated and merged.
- **The sensed-log discipline** (haunt, doc-only) — lifecycle / observation / belief; observations never promoted to beliefs at write time; heartbeats because silence is uninterpretable; the preprocessor rule: *"may compress what it saw; may never decide what it meant."*
- **Domain packs**: `fold-narrative` (exists in-repo), `fold-trace`/`eval`, `fold-activity`, `fold-fleet`, `fold-epistemic`, `fold-drives`.

One spine, two read-heads: eval = Fold + judgments; swarm = Fold + steering.

### 1.1 Platform invariants (promoted from discipline notes)

These are architectural rules, not implementation suggestions:

1. **Observation is not belief.** Sensed or classified observations are never promoted to truth at write time.
2. **Silence is uninterpretable.** Sensor state requires lifecycle + heartbeat semantics; missing observation is not evidence of failure or offline state.
3. **Identity and capture scope are stamped at the source.** At minimum, a captured record carries the identity available at capture plus the consent/scope envelope available at capture; downstream systems must not reconstruct this from anonymous logs.
4. **Preprocessors may compress what they saw; they may never decide what it meant.** Semantic interpretation belongs above capture.
5. **Absent is not failed. Unknown configuration must not pass.** A missing judgment is epistemically absent/neutral; an unrecognized oracle/verifier type is a configuration error and fails closed.
6. **Everything above the log is rebuildable.** Derived state, indexes, summaries, judgments, and steering surfaces must be reproducible from the canonical log plus declared configuration.
7. **Determinism is contractual.** Event ordering, clamped replay granularity, fork boundaries, serialization, and conformance fixtures are part of the public behavior of Fold.

---

## 2. The weld + the spec v0.7 revision package (the gating artifact)

`@_89/fold` is the **reference implementation** of CHANGE\_RECORD\_SPEC. The spec revision now carries three findings, all evidence-backed:

**F1 — clamped non-commutativity must be kind-scoped (verified AMBIGUOUS; v8 disposition makes replay semantics normative).** §6.2 as written ("adjust is commutative") is false: any `clampedNumeric` field is non-commutative, not just the two drama fields. Fix: §6.2 scopes commutativity to `numeric` fields; §12.2 says "any clampedNumeric field". **Plus a third clause from embers' evidence:** conforming folds over `clampedNumeric` MUST replay incrementally. Embers proved (intention.md:365-390) that incremental vs closed-form replay agree to ten decimals yet land on opposite sides of a 0.2 threshold, so **§8.3's 1e-9 tolerance is necessary but not sufficient**.

**Normative replay unit (v8 disposition):** one canonical **Change application** is one replay step. Events are ordered by the canonical event comparator; Changes inside an Event are applied in their serialized order. A conforming implementation MUST clamp after each Change application that touches a `clampedNumeric` field and MUST NOT algebraically coalesce multiple clamped adjustments into a closed-form sum before clamping. The Embers threshold-crossing case becomes a required conformance fixture, with floats serialized unrounded.

**F2 — fork determinism (verified REAL; two independent fixes, take both; v8 fixes cursor semantics).**

- Fix 1: promote §8.1's parenthetical to normative — producers MUST mint eventIds lexicographically monotonic in authoring order within a `t` (ULID satisfies; mythopia's `evt_001…` satisfies by accident; raven's UUIDv7 ids **already satisfy**). Constructed counterexample: non-monotonic ids diverge folds 100% (convergence 0.16 vs 0.00) and produce an incoherent closed-arc-with-tension state.
- Fix 2: `forkAt` MUST be `{t, eventId}` (or validated single-event `t`) — a bare `t` cannot split a same-`t` pair, and the reference canon's own climax (`evt_014`/`evt_015`, both t=1102722) is exactly such a pair.
- **Cursor semantics (v8 disposition):** canonical order is lexicographic on `(t, eventId)`. `forkAt({t,eventId})` is **inclusive**: the forked state contains every event whose ordering key is `<=` the cursor and excludes every event whose key is `>` the cursor. A bare-`t` shorthand is legal only when validation proves exactly one event exists at that `t`; otherwise it is an error, not a guess.
- Required fixture: two events at one `t`; `forkAt` the first event and prove the first is included while the second is excluded.

**F3 — sensed provenance (NEW; blocks canonical L0 emission, not seam work).** The original draft overloaded `basis` with both epistemic status and production mechanism. v8 separates those concerns.

- Extend **`basis`** to `authored | observed | estimated | derived`. `basis` answers: *what epistemic kind of assertion is this?*
- Add **`sensor`** to `author.kind` (id as sensor URN).
- Promote provenance to a reusable **`Provenance`** struct permitted on a **Change** so provenance is per assertion, not merely per Event. Minimum shape: `{ basis, confidence?, scale?, method? }`.
- **`method`** records how the assertion was produced without polluting `basis`. It is a tagged descriptor such as `{kind: sensor|classifier|oracle|model|human|system, id?}`; implementations may carry namespaced method detail without expanding the `basis` enum. Thus a terminal stall classifier becomes `basis: observed, method.kind: classifier`; a Parallax verifier can be `basis: derived|estimated` as appropriate, with `method.kind: oracle` and the oracle type in `method.id`.
- Add a `lifecycle` event kind for sensor `online | degraded | offline` state plus heartbeats. **No lifecycle transition may be inferred solely from silence.** Silence only makes freshness/status unknown once the declared heartbeat window expires.
- Add a **capture scope envelope** at write time: at minimum `workspace` (mandatory where Raven's schema requires it), optional `space`, optional `creator`, plus producer-local identity that exists at capture. This is capture metadata, not a Wave-5 retrofit.

**F3 conformance fixtures (v8 disposition):** (1) sensor online → heartbeat → observation → classified observation → degraded → offline; (2) two Changes in one Event carrying different provenance; (3) expired heartbeat produces *unknown/stale*, not synthetic `offline`; (4) classifier/oracle mechanism is represented in `method`, never as an undeclared `basis`; (5) capture scope survives projection and replay unchanged.

**Adapter conformance requirements (from the mythopia pass):** mint `t` (derived-from-date `t` is spec-fatal — renumbers on prequel insertion; `toDays` pass-through at store.ts:86 is non-conforming); mint monotonic ids; do NOT assume `hidden_from` parity (mythopia lets `known` win; spec requires individual `conceal` to win — stronger); no Mythopia source exists yet for `create`/`destroy`/`link`/`unlink` (so §6.6 `core.membership` has no producer).

**The D1 result, sharpened:** apply-time and read-time knowledge expansion are **provably equivalent** in Mythopia — membership is static (types.ts:150-151; no event mutates it; unrepresentable, not just untested). The risk is the future: the moment membership becomes event-sourced, equivalence breaks with **zero** test coverage. Ship the adapter with a purpose-built late-joiner fixture.

---

## 3. The two deliverables + the attribution loop (status after verification)

**A. Eval pipeline (the money).** The loop, with each stage's verified status:

1. **Consensus route — EXISTS.** decision-pathfinder's `analyzeHistory()` already returns `mostSuccessfulPath` (deterministic, zero LLM); aggregation is pure, `SessionStore`-decoupled, and externally injectable **today** via `pooledSessions` (RecommendationEngine.ts:149-154). No refactor needed.
2. **First-divergent-edge — small pure walk, not yet written.** Compare a failing run's edge sequence against consensus; `edgeOutcomes` already carries per-edge success mass for the report.
3. **The hard prerequisite — cross-model step projection.** Aggregation keys on shared `NodeId`; "model A's step 4 = model B's step 4" requires projecting trajectories onto a common tree *before* aggregation. **This is now THE central bet** (absorbs old spikes 1+2). Free assist discovered: `pty-state-capture`'s `session-diff.ts` (`diffTranscripts` + `jaccardSimilarity`) gives run-to-run comparison off the shelf. **v8 sequencing change:** feasibility is tested immediately with one task, two models, and a hand-built shared tree; only the hardened general projection implementation remains in Wave 2. The spike's job is to determine whether the representation works and what ambiguity/unmapped-step information `fold-trace` must preserve.
4. **Verdict machinery — verified reusable.** Parallax's `command` oracle is trivially liftable as a standalone free function (the reusable eval verdict primitive); the verdict parser (`review-verdict.ts`) is independently reusable; `scoreDecisionHistory` is a pure exported function. Two bugs to fix before reuse: `spec.combine` is declared but ignored (min hardcoded at :843), and unknown YAML oracle types **silently pass at confidence 1.0** (:925-932) — backwards for eval. **v8 disposition:** an *unknown oracle type* is a configuration/schema error and fails closed; an oracle that is known but has no result is epistemically absent/neutral. Do not collapse these states.
5. **Convergence-as-judgment as a service — BLOCKED**, pending the reasoning-tree second pass.

**Free labels, corrected:** Narrative Studio re-prompt lineage is **entity-scoped only** (no user/session identity exists in Narrative Studio — zero `userId` occurrences, no auth middleware). Emit `{entity, production, prompt, model, output-ref, t}` now; treat per-user attribution as a separate identity project. **The eval plan must not assume user-scoped lineage.**

**Named milestone:** the Sponsor Demo Package (50–100 annotated trajectories + comparative forks + install one-pager). Blocked on the sponsor spec conversation and the projection bet.

**B. The swarm.** Unchanged architecture (thin event-triggered reasoning layer, pull + push; personal Hermes agents as the doers; raven demoted to surface). Fleet heartbeats confirmed cheapest via parallax's existing bidirectional stream (no new protocol) and tmux-manager's already-running stall timer.

---

## 4. Architecture (deltas from verification only)

**L0 capture — canonical emission blocked on F3; seam preparation and identity/scope stamping are not blocked:**

- **Terminal family (readiest sensor).** The seam is `tmux-manager.ts:144-221` — every session transition already funnels through one contiguous re-emission table (\~15 insertions). `pty-state-capture` is **already an event log with replay** (`replayRawJsonl`/`replayTurns`) — the only fold-pattern implementation outside mythopia. `coding-agent-adapters` patterns are data-driven (right layering; brittleness better than feared). Heartbeat = extra emission on the existing stall timer. **Identity gap: stamp** **`{agent, task, repo, branch}`** **plus available capture scope on the session handle at spawn time NOW — retrofitting identity or consent scope onto an accumulating log is the expensive version.** Map: lifecycle ← session\_started/stopped/error/exit; observation ← status\_changed/blocking\_prompt/stall/tool\_running/task\_complete. `StallClassification` is a classifier-produced observation: `basis: observed`, `method.kind: classifier`, never truth. Output → digest via normalize.ts + run-length (the preprocessor rule).
- **Narrative Studio (`narrative-canon`).** Instrument **5 leaf choke points** (image-generator.ts:125, gpt-image-generator.ts:114, video-generator.ts:67, seedance-generator.ts:84, music-generator.ts:13), all in `src/visual/`, none in server.ts; comic/film are compositions needing no sensor. Effort: low — structured tee of existing log lines.
- **Parallax.** `runVerify` (:820-851) is the single verdict funnel; one insertion at :845 emits the assertion + confidence with epistemic `basis` and separate `method.kind: oracle` / `method.id: <oracle-type>` rather than copying oracle type into `basis`. Lifecycle emission points are single (connect :169, spawn :447, status :101); the missing piece is an **orphan timeout sweep** (doesn't exist — the actual bug behind reboot-orphaning) plus a boot-time fold to rebuild the in-memory maps.
- Browser extension + screenpipe sidecar: unchanged, behind adapters.

**L1 Truth.** Extraction work-list updated: golden fixtures first (two serialization hazards: sort Map keys AND inner arrays of `resolvedPeaks`; serialize floats **unrounded** — rounding hides exactly the divergence that matters, per embers); pin bare-reopen semantics (verified unpinned — every reopen test masks the zero with a same-event delta); the per-event fold cost includes 5 server-side render sites; `arcJourney` confirmed as the zero-fold template; epitaph "lossless recovery" requires enumerating rounds (default call is last-round-only — deliberate compression, but not lossless at the call site).

**L1.5 Recall.** Raven's UUIDv7 memory ids are already spec-monotonic (no migration on that axis). Consent envelope shape confirmed from schema: **workspace (mandatory) → space → creator**. **v8 disposition:** the minimal envelope is stamped at capture in L0 and preserved losslessly through Fold/projection; L1.5 owns recall-time enforcement semantics, not first attachment of scope. Embeddings cascade on delete → append-only model needs an explicit supersedes-pointer or the vector index returns superseded rows. Write-path enumeration BLOCKED (second pass).

**L2/L3 Judgment & actuation.** Kernel: `@parallaxai/confidence` is an **orthogonal value algebra, not superseded** — record that decision to stop the question recurring; `confidence-tracker` is dead — delete (\~1h). Kernel v0.3 agenda: resolve `makeHistoryOracle` (shipped v0.2 feature sits on an export **no host imports** — migrate parallax onto it or demote it); give `scoreHistory` the efficiency escape hatch (`efficiency: number | (runs) => number`) since both hosts that fight `efficiencyFactor` call `scoreHistory` directly (two of three hosts cannot use `efficiencyFactor` as shipped — file the issue); delete-or-document `applyProbation` + journals (dead exports). reasoning-tree world-check coverage: exactly **one** production recording site; widen at plan-subtree-node.ts:286 first, fix textproto-eval.ts:758's hardcoded `true`; never default absent→false (deliberately resisted in four places).

---

## 5. Asset map (verified status)

| Asset | Verified state | Next action |
| --- | --- | --- |
| confidence-kernel                 | ✅ 0.2.0 npm, all hosts merged, clean                                                                             | v0.3 agenda (§4); no merges needed                                                                          |
| mythopia / Fold                   | 91/91 green; fixtures outstanding; numerics confirmed (C=0.3667, twin peaks)                                     | Golden fixtures (hazards noted) → pin bare-reopen → adapter (minted t, ULIDs, late-joiner fixture)          |
| CHANGE\_RECORD\_SPEC v0.6         | F1 ambiguous / F2 real / **F3 missing entirely**                                                                 | **v0.7 package**: replay unit + inclusive fork cursor + provenance/method split + lifecycle/scope fixtures  |
| parallax                          | Branches merged; durability gaps confirmed (all process memory); 2 oracle bugs found                             | Fix combine; unknown oracle type = config error; orphan sweep; lifecycle/provenance emission; delete tracker |
| reasoning-tree                    | Merged; world-check = 1 production site                                                                          | **Second pass now**, in parallel with the hand-built two-model projection feasibility spike                 |
| decision-pathfinder               | Aggregation pure + injectable (pooledSessions); consensus route exists                                           | Write first-divergent-edge walk; read TreeEvolution semantics; family-tag declaration (blocked)             |
| narrative-canon / Narrative Studio | 5 choke points; **no identity layer**; extraction pipeline = lift-and-shift (zero Gemini coupling, working mock) | Instrument the 5; entity-scoped lineage now; identity = separate project                                    |
| raven-docs                        | Fully pushed; UUIDv7 ✓; envelope = workspace→space→creator                                                       | **Second pass**: mcp-method-schemas.json first, then 4 activity services                                    |
| hauntjs                           | Discipline 100% doc-only; types drafted in report                                                                | Adopt as contract (blocked on F3); lift preprocessor rule + recapitulation line verbatim into platform spec |
| terminal family                   | Seam + replay log verified; heartbeat cheap                                                                      | **Identity + capture-scope stamping now**; prep seams now; canonical record emission after F3               |
| embersjs                          | **Not parked** — golden suite (24 cases) done; float-threshold evidence quantified                               | Feed intention.md:352-390 into F1 disposition; drive-folding after spec settles                             |
| screenpipe                        | external, unchanged                                                                                              | Sidecar behind adapter; license decision at scale                                                           |

---

## 6. Sequencing (risk retirement first; production waves second)

The roadmap now distinguishes **risk-retirement work** from **production implementation**. A spike may run before its production dependencies if its purpose is to invalidate or constrain the architecture cheaply.

### Now — four parallel tracks

1. **Spec v0.7 package.** Settle F1 (numeric vs clampedNumeric + one-Change replay unit + Embers fixture), F2 (monotonic ids + inclusive `{t,eventId}` cursor + same-`t` fixture), and F3 (basis/method split + sensor author + Change provenance + lifecycle + capture scope + sensed fixtures). Canonical L0 emission waits on F3; seam prep does not.
2. **Projection feasibility spike — run now, before `fold-trace` freezes.** One task, two materially different model trajectories, one hand-built shared tree. Project both trajectories, preserve ambiguous/unmapped steps explicitly, then run existing consensus aggregation and first-divergence logic against the projected identities. `session-diff.ts` is an assist, not the definition of equivalence. **Exit question:** can heterogeneous traces be represented on a shared decision structure without erasing the information needed to explain divergence? If not, change the trace representation before Wave 1/2 harden it.
3. **The two second passes.** reasoning-tree: resolve trajectory/convergence feasibility and trace/export surfaces. raven: emission inventory, epistemic schemas, memory write paths, and access-control guards.
4. **No-regret preparation while those run.** Fix Parallax `spec.combine`; make unknown oracle types configuration errors; delete `confidence-tracker` + stale branches; stamp terminal `{agent, task, repo, branch}` + capture scope at spawn; prepare Narrative Studio's five tees behind an adapter boundary; capture a verification manifest (repo, branch, commit SHA, report date) for every repo used as evidence.

### Freeze gate — before production trace work

Freeze **spec v0.7 + minimum trace/projection contract together**, using the projection spike and second-pass findings. In particular, decide what a trace step is, how ambiguous/unmapped projection is represented, what identity survives projection, and which provenance/scope fields are lossless. Do not let `fold-trace` accidentally encode assumptions that the spike has already disproved.

**Wave 1 — spine + conformance.** Mythopia golden fixtures (unrounded floats, stable serialization) → F1/F2/F3 conformance fixtures → pin bare-reopen → extract `@_89/fold` + kernel/pack split → checkpointing (epitaph=checkpoint primitive) → strict mode. Late-joiner fixture before any event-sourced membership. Minimal capture scope is already part of the record contract here.

**Wave 2 — the money pack.** Spec-conformant adapter (minted t, monotonic ids) → `fold-trace`/eval using the frozen projection contract → Narrative Studio 5-point instrumentation (entity-scoped labels + capture scope) → hardened cross-model projection → consensus-route + first-divergent-edge + lifted command-oracle verdicts. Exit: Sponsor Demo Package.

**Wave 3 — activity + fleet.** Terminal canonical emitter with source identity/scope; Parallax lifecycle events + orphan sweep + boot fold; browser extension; heartbeats both places; fleet first loop ("unknown — sensor silent since 11:04").

**Wave 4 — swarm.** Epistemic pack (post-raven-second-pass) + thin reasoning layer (pull Q&A + salience-triggered push) + memory tier (append-only + supersedes-pointer) + procedure unification.

**Wave 5 — productize.** SDK + public conformance suite; full consent/access enforcement using the capture-time envelope; 30-venture rollout; screenpipe decision. Scope is **not first attached here** — Wave 5 productizes and enforces what L0 has preserved from capture.

---

## 7. Open questions & bets (post-verification)

**THE bet:** cross-model step projection onto shared node identity (§3.3). Everything else in the attribution loop is verified-existing or small pure code. **It is now an active Now-track, not deferred Wave-2 research.** De-risk with one task, two models, a hand-built shared tree, explicit ambiguous/unmapped outcomes, and the existing aggregation. The production implementation remains Wave 2 only if the representational bet survives the spike.

**Blocked, awaiting second passes:** convergence-as-judgment API surface; trace spec shape; eval export formats; raven emission inventory; epistemic schemas; raven memory write paths; TreeEvolution semantics; family-tag declaration.

**Open decisions:** kernel Oracle-vs-primitives public shape (the `makeHistoryOracle` fork); spec v0.7 adoption process across the four producers; exact trace representation for ambiguous/unmapped projection (settle at the freeze gate, not by assumption); team allocation (2 technical, 1 creative) across the waves; identity project for Narrative Studio beyond entity scope; access-control enforcement reading (semantics inferred from schema nullability — verify the guards before relying).

**External:** the sponsor eval spec. Get any concrete artifact.

---

## 8. Discipline notes + verification durability

- **Verify before you plan.** Half of v6's "next actions" were already done; one silent blocker (F3) outranked everything planned. The report pass paid for itself several times over.
- **Pin evidence to a baseline.** File names, symbols, and line numbers are useful but line numbers rot. Every future verification report MUST record `repo`, `branch`, `commit SHA`, and verification date. v8 preserves the 2026-08-06 evidence but does not invent SHAs that were not present in the source document.
- **Serialize floats verbatim; clamp after each canonical Change application.** Tolerance-based comparison cannot detect threshold-crossing divergence (Embers' proof); closed-form coalescing is non-conforming for `clampedNumeric`.
- **Absent is not failed; unknown configuration must not pass.** A known oracle with no result is absent/neutral. An unrecognized oracle type is a configuration error and fails closed.
- **Stamp identity and capture scope at the source.** Anonymous or scope-less logs are cheap to write and expensive—or impossible—to attribute and govern later.
- **Risk-retirement spikes may run ahead of production dependencies.** Cheap experiments exist to invalidate representations before the platform hardens them.
- **Everything above the log is rebuildable.** Unchanged, still the test.
