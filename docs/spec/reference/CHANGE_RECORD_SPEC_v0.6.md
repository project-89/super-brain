# The Change Record — the altitude-2 interchange format

**Status**: `design v0.6` — **release candidate for v1.0**; all three
implementer vantages examined (ArgOS 5 · Mythopia 6 · Aureum 7 blockers — all
folded).
Reviewed adversarially from **both** implementer sides: ArgOS (5 blockers, closed
in v0.2) and Mythopia (6 blockers, closed here). v0.3 corrected the component
model to structs-of-fields after inspection showed 60 of ArgOS's 76 runtime
components are multi-property. v0.5 closes **O1** (the record channel), **O2**
(group knowers), **O3** (timeline forks) and **O7** (where a Change lives),
adds the **L1r** conformance level, and **carves §13 to v1.1** as a correctness
call. **§16's mapping table is verified at source for all four systems.**
v0.6 folds the **Aureum-side review** (4 blockers CONFIRMED by independent
per-blocker verification, 3 narrowed to documentation gaps — all addressed).
Remaining before lock: **a maintainer signature per §15 row**.
See `CHANGE_RECORD_SPEC_REVIEW.md` (ArgOS side).
**Author**: Michael + Claude, 2026-07-27.
**Answers**: ArgOS `CANON.md` §6 *"The Change Record and the Commit
**[OPEN — yours to standardise]**"*.
**Read with**: `CHANGE_RECORD_SPEC_REVIEW.md` (ArgOS),
`CHANGE_RECORD_SPEC_REVIEW_MYTHOPIA.md` (Mythopia) and
`CHANGE_RECORD_SPEC_REVIEW_AUREUM.md` (Aureum),
`NIT_FORMAT_SPEC.md`, `MYTHOPIA_COMPARISON.md`, ArgOS `CANON.md` §2/§3/§6/§16.

**Normative language**: MUST / MUST NOT / SHOULD / MAY per RFC 2119.

---

## 0. What this is

Four systems converged on the same object and each built a different part:
**ArgOS** simulates (altitude 1) and narrates (altitude 3) with no record
between; the **Narrative Studio** records and versions that middle and produces
media from it; **Mythopia** derives the physics of story from it; **Aureum** runs
rules that mutate it. This specifies the middle: **one typed, versionable,
replayable record of what changed, who changed it, and why.** A book ingested, a
simulation tick, a human authoring, and a card game being played emit the same
thing. A comic, a film, a microdrama, an episode outline and a running world are
animated from it.

**Path to v1.0.** The eleven blockers across two reviews were not successive
passes over one defect pool — they were **first passes from vantages that had
not yet looked**: ArgOS found the identity and fold gaps because it is the
producer with no identity and a foreign fold; Mythopia found clamping and
peak-capture because it is the only party whose tests assert numbers. Vantages
exhaust after their first pass, and as of v0.6 **all three implementer vantages
have looked** — Aureum's found what only it could (no clock, link-key
ambiguity, silent skips, closed node kinds; 4 confirmed, 3 narrowed by
independent verification). The lock rule is therefore not "stop eventually":
carve what is unsound (§13) to v1.1, obtain one maintainer signature per §15
row, and lock — implementation finds what reading cannot, and
the wire already tolerates being wrong safely (`specVersion`,
unknown-verb-means-reject, `declare`).

### 0.1 Changelog — what the review changed

| Blocker | Resolution |
|---|---|
| **B1** `NodeId` undefined; examples used name-derived slugs | **§3 Identity** — new, normative. Opaque `<kind>_<ULID>`, globally unique, MUST NOT derive from mutable fields. All examples corrected. |
| **B2** the fold has no defined result | **§8** — normative sort key, one authoritative field per verb, `before` as assertion with a mismatch policy, explicit fold input set. |
| **B3** no identity-reconciliation verb, list declared closed | **`merge` added** (§6.4). Core is now **12 verbs**. Absorbed id becomes a permanent read-time redirect. |
| **B4** replay may re-execute effects | **§9.1** — at-most-once, commit-arrival-driven, never on replay; stable effect ids; consumer execution ledger. |
| **B5** §4/§5 contradictions; §9 misstated nit readiness | §5 is now an explicit discriminated union with a normative field table; `transfer` inversion fixed; one name (`audience`); `link` gains an edge id; **§11.3 states the real nit gap honestly and corrects the hash-gate claim.** |
| Q1, Q2 (was "open") | **Closed** — §12.6 validity intervals; §6.3 reveal/conceal are not redundant. |
| Q3 (was "open") | **Promoted to MUST** — §4: `kind` is a label, never trusted over `changes`. |

### 0.5 Changelog — v0.6 *(this revision — the Aureum-side review)*

| Blocker | Resolution |
|---|---|
| **B1** no clock vs REQUIRED `worldDate` — Aureum has no time model at all; hosts would fabricate calendar dates that Mythopia then does day-arithmetic over | §7: a clockless producer MUST declare its `t → worldDate` mapping as a world parameter (`{storyEpoch, daysPerT}`) — dates are *derived and declared*, never invented. `granularity` enumerated: `beat\|scene\|chapter\|era\|session`. |
| **B2** narrative-only rules (Aureum's most common shape) emit zero Changes → rejected by §2 *(narrowed: the workaround exists but was undocumented, and §16 pointed at `effects` — the wrong way)* | §6.3.1: the **create+reveal pattern** — `create` a `fact` node holding the text, `reveal` it to the match context or a declared default audience. §16's Aureum effects row corrected. |
| **B3** oneShot spent-ness is behaviour-gating state in no channel *(narrowed: forward-looking — today's replay rehydrates the RuleSet snapshot)* | §12.7.1: **engine state that gates future behaviour MUST be reified as a component write** (`mark x.aureum.spent` on the rule's node, in the firing Event). A vendoring obligation, not an active bug. |
| **B4** one `setLink` maps to four verbs with no discriminator — two conforming emitters, different folds | §12.5.2 **link-key declarations**: per-key `{verb, component}`; undeclared keys fall to `link`/`unlink` with synthesized stable `edgeId`. §16's three `setLink` rows become deterministic. |
| **B5** open tag vocabulary / untyped `setMeta` *(narrowed: mechanism exists; worked example missing)* | §12.5 gains the worked example: runtime tags are per-tag boolean components via `mark`/`unmark`; `core.membership` is a ref-set (different category); `setMeta` declares a concrete type or stays a record. |
| **B6** `applyChanges` silently skips unknown targets → emitted log ≠ applied world, no diagnostic anywhere | §8.3 gains the producer-side twin: an emitter MUST NOT emit a change it did not apply — `unapplied-change`, the mirror of `before-mismatch`. |
| **B7** closed `nodeKind` enum has no value for game-mechanical nodes (GAME, PLAYER, cards) | §3.2: **extension node kinds** `x.<vendor>.<name>`, declared once, tolerated by consumers as opaque nodes — §12.8's selection-pressure design applied to kinds. |
| §15 Aureum row corrected | **L1 emission needs zero evaluator changes** — the emitter is a host wrapper around `step()` (before from the pre-step world, after from the returned clone, participants from the match context); rules stay pure. |

### 0.4 Changelog — v0.5

| Change | Why |
|---|---|
| **§11.5 The record channel** — one commit, two channels: Changes (story time, interval algebra) + Records (edit time, field-level LWW) | Closes **O1**, the highest-cost gap. "Versioned … cited as `record@version`" already implied a revision log — the channel was implied, never drawn. Studio→Simulation instantiation becomes expressible (records first, then changes — a *forced* ordering); a rename stops violating §2 without a `core.name` hack; the authored half of a canon transports. |
| **§12.7 becomes a normative boundary test** — *component iff it varies as a result of story events* | The split needs a test, not an intuition. Applied both ways: location topology crosses to components (a bridge can collapse mid-story); `Arc.planned_tension` stays a record (authored intent — the drift rule exists to compare the two). |
| **§11.6 O7 DECIDED** — option (a); **freeze at canon** scoped to `changes[]`, `at`, `participants`, `timelineId`; labels stay mutable; drafts stay fluid | Whole-Event immutability would delete the shipped authoring surface (`PATCH /events/:id`, the chronology stepper) and the `dramatizedAtEventUpdatedAt` staleness mechanism. Freezing substance-at-canon alone dissolves the append-merge hazard. |
| **§7.1 Timelines** — forks **inherit**; `Timeline{forkedFrom, forkAt, isCanon}` as a hashed node; `timelineId` joins the conflict key | Closes **O3**. Partition was one filter line (`derive.ts:536`), not a decision; ArgOS booting empty forks while the Studio renders full history was the silent-divergence class again. Promotes the shipped-but-unversioned `Timeline{parentTimeline, branchPoint}` (`canon-timeline-manager.ts:31-43`). |
| **§6.6 Group knowers** — reveal records on the group; `core.membership`; **read-time transitive** `knows()` | Closes **O2**. Emit-time expansion loses the group as a knower and disinherits late joiners. Same shape as `merge`'s read-time redirect — an already-accepted pattern. |
| **§15 adds L1r** (emit + rehydrate); ArgOS targets L1r, not "L2 locally" | An altitude-2 table maintained by ArgOS would be provably lossy against its own BitECS state — the twentieth world-state representation. Resolves the §15 ↔ CANON §6 contradiction in favour of the standard. |
| **§13 carved to v1.1** | Correctness, not scope: as specified it is unsound in the **unsafe** direction — silent under-invalidation via `merge`, canonization, and missing intervals. Coarse rules fail safe; "and nothing else" fails silent. |
| **O4** ships implementation-defined | Four defensible resolutions; a consumer MUST document which it takes. |

### 0.3 Changelog — v0.4 (the Mythopia-side review)

| Blocker | Resolution |
|---|---|
| **B1** `worldDate` optional at L1, but Mythopia **throws** without it | **REQUIRED at L1**, grammar pinned (proleptic Gregorian, 1–6 digit years). §7, §15. |
| **B2** `t` as sole order vs Mythopia ordering by date — same log, two folds | **`t` and `worldDate` MUST be non-decreasing together**, checked at commit and merge. §7. |
| **B3** `numeric` fold vs Mythopia's **clamped** fold — changes fixture values its tests assert | Added **`clampedNumeric`**; `drama.tension`/`drama.stakes` are `clampedNumeric[0,1]`. Non-commutativity stated, not hidden. §12.2, §12.3. |
| **B4** no way to capture pre-resolution intensity — convergence loses ~35% of Khazad-dûm | **`drama.peakAtResolution`** as a derived read + **normative intra-event ordering** (`adjust drama.*` before `set drama.state`), since array order alone swung the peak 5×. §12.2.1. |
| **B5** one `audience` field made the fixture's flagship irony **invalid**; `conceal` ≠ inverse of `reveal` | `audience` joins the conflict key; `conceal` is **complementary, not inverse** (it shields; it does not un-know); `core.knowledge` folds as **`timestampedSetFirstWrite`** with two channels. §5, §8.2, §12.1. |
| **B6** mood kernel not computable — `λ` and `B` had no home | **World-parameter `declare`** (§12.5.1); `mood_baseline`/`mood_emission` reclassified as components; §4's "compute your own" MUST softened to scale-declared authority. |
| U3 | `nodeKind` gains **`fact`**, **`theme`**, **`audience`** — `reveal`'s subject *is* a fact. |

### 0.2 Changelog — v0.3

| Change | Why |
|---|---|
| **Components are structs of typed fields** (§12.3); fold rules are **per field** | v0.2 modelled a component as one value with one fold rule. **60 of ArgOS's 76 runtime components are multi-property** (`Vitals{health,energy,hunger,hydration}`); Aureum's entity is three sub-maps; this spec's own `core.containment` is `{parent, mode}`. v0.2's `declare` could express none of them. |
| **Field-path addressing** `(subject, component, field?, object?)` (§12.4) | You `adjust` `Vitals.hunger`, never `Vitals`. Absent `field` = atomic whole-component write, legal only on components declared `atomic: true`. |
| Uniqueness constraint, validity intervals and the stateful lift move from a **triple to a quad** (§8.2, §8.4, §12.6) | Follows from field addressing; also improves merge granularity (two branches writing different fields of one component no longer conflict) and read-set precision. |
| **`declare` carries a field map** + four normative rules: declaration precedes use, idempotent, **conflicting redeclaration rejected**, vocabulary accumulates in the commit (§12.5) | A consumer joining at t=500 must obtain the active vocabulary without replaying from t=0 — ArgOS CANON §16's *vocabulary commit*. |
| Stated explicitly: **runtime-invented components stay in `x.<vendor>.*`** | A GodAI invention has one producer and can never meet the two-producer promotion bar. That is the selection pressure working as intended, not a defect. |

---

## 1. The Three Altitudes (adopted from ArgOS §2)

| | Altitude | Shape | Volume |
|---|---|---|---|
| 1 | **Mechanical** | `component.set`, `relation.add`, `entity.create` | tick-rate, high |
| 2 | **Semantic** | `character.moved`, `secret.revealed`, `regard.fell` | event-rate, low |
| 3 | **Narrative** | prose, panels, shot lists, editions | on demand |

**This spec defines altitude 2 only.** Altitude 1 stays local and is NOT
transported. Altitude 3 is derived — prose and panels are views, never storage.

**Two different filters share the word "lift"; they are not the same** (review
U7):

- **The lift (1→2)** decides *what is worth recording*. Rejection is
  **irreversible** — altitude 1 is a local ring buffer. It is **stateful**
  (§8.4).
- **The gate (draft→canon, §11.2)** decides *what is true*. Rejection is
  **reversible** — the draft persists.

The **lower (2→1)** is how an authored world boots as a simulation.

> **Symmetry requirement.** Simulation→Studio and Studio→Simulation are the same
> operation: applying change records to a graph.

---

## 2. The Keystone Rule, made structural

ArgOS §3, written August 2024, never enforced:

> The narrative engine may only act by (a) injecting an entity, (b) modifying a
> component value, or (c) mutating an agent's motivation. It never commands
> agents directly, and it never emits prose unbacked by a graph change.

Enforced here as a schema constraint:

> **An Event carrying zero Changes is invalid and MUST be rejected at commit.**

**Dialogue is not an exception** (review U9). A line that "reveals nothing" still
changes who has heard it. **A speech act IS a knowledge write**: `reveal` with
the utterance as the fact and the listeners as the audience. Dialogue is backed
by construction; the MUST needs no escape hatch. Producers MUST NOT invent
no-op changes to satisfy this rule.

---

## 3. Identity **[NORMATIVE — read before implementing anything else]**

ArgOS `CANON.md` §4 marks identity **[OPEN]** and ranks it *"blocks everything."*
This closes it.

### 3.1 Grammar and opacity

```
NodeId ::= <kind> "_" <ULID>          e.g.  character_01J8F3K2QX7YB4N0WZ5MV6RTAC
```

1. IDs are **opaque**. Consumers MUST compare byte-wise and MUST NOT parse
   beyond the `<kind>` prefix.
2. An ID MUST NOT be derived from `name` or any other mutable field. Names are
   mutable authored data (§12.7); an ID derived from one is not durable.
3. **Deterministic slugs are forbidden.** Two producers independently creating
   "Malcor" would both mint `character_malcor`, and under a component-granular
   merge rule that **silently fuses two different characters**. Opaque IDs fail
   safe; slugs fail silent.

> Today's shipped scheme is `mintId('entity')` → `entity_<ms>_<8hex>`
> (`src/utils/ids.ts:19`), with name-derived fallbacks live at
> `src/extractors/character.ts:95-100` and `server.ts:10585,10691`. Both are
> non-conforming and are named for migration in §11.3.

### 3.2 Uniqueness, minting, kinds

- **Scope**: globally unique across every world, branch, repository and producer
  — explicitly widening `NIT_FORMAT_SPEC.md:62`'s per-narrative scope.
- **Minting**: any producer MAY mint at the moment it emits `create`, without
  coordination. ULID entropy makes independent minting collision-free.
- **`nodeKind`** — one enum, reconciling ours (9 `EntityType`s) with ArgOS's 6:

`character` · `location` · `object` · `organization` · `faction` · `creature` ·
`concept` · `artifact` · **`media-asset`** · **`narrative-node`** · **`fact`** ·
**`theme`** · **`audience`** · **`timeline`** (§7.1)

> `fact`, `theme` and `audience` are added in v0.4 (Mythopia review U3): all
> three are first-class ids there, and **`reveal`'s `subject` IS a fact**, so
> facts must be nodes. `media-asset` and `narrative-node` are **new to nit**. `narrative-node` is
> load-bearing: the whole `drama.*` story (§12.2) requires arcs and beats to be
> graph nodes. Our legacy `EntityType.event` is **deprecated** — Events are
> records (§4), not nodes.

**Extension node kinds** *(v0.6, Aureum review B7)*: kinds outside the core
enum are legal as `x.<vendor>.<name>` (`x.aureum.card`, `x.lcg.game-state`),
MUST be declared once (the same four rules as §12.5), and MUST be tolerated by
consumers as opaque nodes. §12.8's selection-pressure design applies to node
kinds exactly as it does to components — without this clause the enum silently
excludes an entire class of producer: a card game's GAME, PLAYER and card nodes
are none of the core kinds in any non-arbitrary way.

### 3.3 Identity reconciliation

"These two characters are one character" is the single most consequential edit a
narrative system performs, and it **ships today as history rewrite** —
`entity-similarity.ts:11` (`'merge' | 'alias' | 'review' | 'separate'`),
`git-chunked-extraction.ts:252,435` (rewrites IDs and both relationship endpoints
before commit), `entity-merging-service.ts:227` (`canonicalEntityId` redirect
then `updateMany`). The format MUST be able to express it, or §12.8's *"change
records are the only writers"* is false. See `merge` (§6.4).

---

## 4. The Event

```jsonc
{
  "specVersion": "0.6",                          // §11.4 — REQUIRED
  "id": "event_01J8F3K2QX7YB4N0WZ5MV6RTAC",      // ULID, lexicographically monotonic
  "kind": "object.acquired",                     // a LABEL — see below
  "title": "Malcor takes the tax coins",
  "description": "…",

  "at": { "t": 412, "worldDate": "3019-01-15", "granularity": "scene" },
  "timelineId": "timeline_01J8…",                // ABSENT (not null) = the canon line

  "participants": ["character_01J8…MALC", "character_01J8…GARR"],
  "location":     "location_01J8…FORG",

  "author":   { "kind": "simulation", "id": "argos:run_9f2" },
  "causedBy": ["event_01J7…"],

  "magnitude": { "value": 0.6,  "basis": "estimated", "confidence": 0.5, "scale": "mythopia/v1" },
  "valence":   { "value": -0.4, "basis": "estimated", "confidence": 0.5, "scale": "mythopia/v1" },

  "changes": [ /* §5 — REQUIRED, non-empty */ ],
  "effects": [ /* §9 — optional, never mutating */ ],

  "extensions": { }
}
```

**`kind` is a label. MUST be derivable from `changes`, and a consumer MUST NOT
trust it over `changes`.** Unknown kinds MUST be tolerated by falling back to
`changes`. (Promoted from v0.1's open question Q3.)

**`magnitude`/`valence` carry provenance, and are authoritative on a named
scale.** They carry `basis` (`authored` | `estimated` | `derived`), `confidence`
and a named `scale`. A consumer that **declares it accepts a scale** MAY treat
values on that scale as authoritative; otherwise it SHOULD derive its own from
`changes`.

> v0.3 made "compute your own from `changes` alone" a MUST. That is not
> achievable (Mythopia review B6): these values are consumed verbatim for the
> mood kernel, `paceCurve` sums magnitude, linter rules 1 and 7 threshold on
> magnitude and |v×m|, and **edition register caps filter content by
> `valence_floor`/`magnitude_cap`** — a child-safe filter cannot be built on a
> producer-private hint of unstated scale. Provenance without authority is worse
> than either alone.

---

## 5. The Change Record — a discriminated union on `verb`

The precedent is our own `GraphOperationSchema` (`schemas.ts:373`). Publish as
`z.discriminatedUnion('verb', […])`.

| verb | required | `before` | `after` | authoritative field | inverse |
|---|---|---|---|---|---|
| `create` | `subject`, `nodeKind` | — | initial props | `after` | `destroy` |
| `destroy` | `subject` | props | — | `before` | `create` |
| `set` | `subject`, `component` | prior value | new value | **`after`** (LWW) | swap |
| `adjust` | `subject`, `component`, `amount` | prior num | new num | **`amount`** (commutative) | negate `amount` |
| `mark` / `unmark` | `subject`, `component` | bool | bool | `after` | the other |
| `link` / `unlink` | `subject`, `object`, `edgeType`, **`edgeId`** | — | `payload?` | `edgeId` | the other |
| `transfer` | **`object` = the item**, `subject` = the item's owner-scope | **prior holder** | **new holder** | `after` | swap |
| `reveal` / `conceal` | `subject` (fact), **`audience`**, `object?` | prior state | new state | `after` | **complementary, NOT inverse** (§6.3) |
| `merge` | `subject` = survivor, `object` = absorbed | absorbed props | `null` | `object` | *not invertible* (§6.4) |

Four v0.1 contradictions this closes (review B5):

1. **`transfer` no longer inverts `object`.** `object` is the **item**;
   `before`/`after` are holders. v0.1 said both and the coins ended up held by
   the coins.
2. **Fields §5 required but §4 omitted** — `nodeKind`, `edgeType`, `payload`,
   `audience`, `edgeId` — are now in the table.
3. **One name for the concealment slot: `audience`.** v0.1 said `audience` in a
   table and `hidden_from` in prose two lines below; the hash gate would have
   treated them as different content and concealment would silently vanish.
4. **`before`/`after` are per-verb, not blanket.** `create` has no `before`,
   `destroy` no `after`, `link`/`unlink` neither. Conformance (§13) states this
   per verb, not universally.

**`link` carries `edgeId`** so `unlink` can address one edge in a multi-edge
graph. Without it the verb is 1:1-shaped and does not close Aureum's 1:1 gap the
way v0.1 §15 claimed.

**Why `before` is mandatory where it applies.** It makes a change *invertible*
without the fold, *composable* for squash, and *narratable* (the panel needs the
fall, not the landing). Recovering it by replay is exactly what a producer at the
lift cannot do.

---

## 6. Verb notes

### 6.1 Existence
Aureum **cannot** `spawn`/`destroy` today — verified: `ChangeOperation` is 7
variants (`rules.ts:13-19`), `applyChanges` handles those 7 (`evaluator.ts:315-335`),
`createEntity` (`world.ts:22`) is an API function not reachable from a rule, and
unknown targets are silently skipped (`evaluator.ts:311`). ArgOS requires both
verbs. Closing this is part of the Aureum vendoring, not optional.

### 6.2 `adjust` vs `set`
`adjust` is **commutative** (concurrent deltas compose); `set` is
**last-write-wins** by sort key. This is the difference that makes concurrent
producers converge, and it is why `amount` — not `after` — is authoritative for
`adjust`.

### 6.3 `reveal` / `conceal` are NOT redundant with a knowledge component
*(closes v0.1 Q2 — reasoning adopted from the review.)*
The **verb is the writer; the component is the fold** — identical to `adjust`
writing and `core.regard` folding. Every core component names the verbs that
write it (§12.1). Deleting these would collapse *concealed* into *unknown* and
destroy the dramatic irony that justifies core status. They need their own verb
rather than `set` because the write is **audience-scoped**: a generic `set` would
require supplying the whole post-state for every audience — whole-world-snapshot
semantics, the exact defect this spec charges against Aureum's adapter.

#### 6.3.1 Producers with no knowledge model — the create+reveal pattern *(v0.6)*

§2's dialogue rule generalizes to any producer whose most common output is
*narration with no state change* — Aureum's `narrative:` rules are a
first-class DSL section producing exactly that shape. The conforming emission
is two Changes, both already licensed: **`create` a `fact` node holding the
narrative text** (§3.2 — any producer MAY mint without coordination), then
**`reveal` it** with `audience` = the match context (the trigger entity, the
players present) or a declared default-audience world parameter (§12.5.1).
This is not an invented no-op — it is a genuine `core.knowledge` write, which
is §2's own principle: prose backed by a graph change.

**Narrative side effects map here, NOT to `effects`.** §16's Aureum row is
corrected accordingly — routing narration to `effects` would make the beat
invisible to the fold, and the log would stop being complete.

### 6.4 `merge` — identity reconciliation *(new in v0.2; closes B3)*

```jsonc
{ "verb": "merge", "subject": "character_01J8…SURV", "object": "character_01J8…ABSO",
  "before": { /* absorbed node's props */ }, "after": null }
```

Three normative rules:

1. The absorbed NodeId is **never deleted**. It becomes a permanent **redirect**
   that MUST resolve on read.
2. Resolution is **transitive** and MUST be **cycle-checked**.
3. References (`participants`, `causedBy`, component values, `readSet.node`)
   resolve **through** the redirect at read time and **MUST NOT** be rewritten in
   place.

`merge` is deliberately **not invertible** — un-merging is a new `create` plus
re-attribution, and is out of scope for v0.2.

### 6.5 Semantic kinds (`Event.kind`)
`character.moved` · `relationship.formed` · `relationship.strained` ·
`secret.revealed` · `object.acquired` · `organization.founded` ·
`arc.opened` · `arc.resolved` · `identity.merged` · `world.changed`.
Namespaced and extensible; see §4 on their status as labels.

### 6.6 Group knowers — read-time resolution *(closes O2)*

A `reveal` whose `audience` is a group (an `organization`, `faction`, or any
node with members) records knowledge **on the group node itself**. Membership is
a **component** — `core.membership`, the set of groups a node belongs to at t —
written by `link` / `unlink` with `edgeType: "member-of"`. (Joining the
Fellowship or leaving the Council is a story event, so by §12.7's test
membership cannot be a record.)

`knows` resolves **transitively at read time**, cycle-safe:

```
knows(x, f, t)  =  known(x, f, t)  ∨  ∃ g ∈ membership(x, t) : knows(g, f, t)
```

with an individual `conceal` on `x` shielding `x` regardless of what its groups
know, and the step-function timestamp of inherited knowledge =
`max(revealedAt(g, f), joinedAt(x, g))`.

Emit-time expansion — the tempting alternative — fails twice: it loses the group
as a knower ("the Council knows" stops being a fact *about the Council*, which
institutions-as-agents requires), and it snapshots membership, so a member who
joins later never inherits what the group learned. Read-time resolution over a
versioned membership component is the same shape as `merge`'s read-time redirect
(§6.4) — an accepted pattern, not a new mechanism.

**Divergence note (deliberate).** Mythopia expands groups at *apply* time
(`store.ts:129-133,257`), so its late joiners do **not** inherit. This spec's
semantics are intentionally the institutional-memory ones. The Fellowship
fixture's assertions still hold — every asserted knower is a member at reveal
time — but a conforming Mythopia adapter moves expansion to the read side.

---

## 7. Time and ordering

| Clock | What | Carried? |
|---|---|---|
| **Story time** — `at.t` | when it happens in the world | **yes — the sole ordering key** |
| **Story date** — `at.worldDate` | calendar position | **yes — but NOT for ordering** |
| **Transaction time** | when it was written | on the Commit |
| **Tick / wall clock** | sim step, publication time | **no** — local buffer / ARG schedule |

**`t` is the sole ordering key** (review U10). It is author-assigned, sparse
(leave gaps for insertion), and **immutable once the Event is canon**
(§11.6 — v0.2 said "once committed"; drafts stay re-timeable, which the
shipped chronology stepper depends on). A derived-from-date
`t` would renumber on every prequel insertion and silently re-point every stored
read-set (§13) — fatal.

**`worldDate` is REQUIRED at L1** (Mythopia review B1). v0.3 listed it as merely
"carried", so a producer emitting `at: {t: 412}` alone was conformant — and
Mythopia's `CanonStore` **throws at construction** on an unparseable date
(`time.ts:25`, called unconditionally at `store.ts:86`), before any engine runs.
An optional worldDate makes a fully conformant stream unloadable by the system
whose entire analytical layer depends on it.

**Grammar** (pinned — "a calendar position" with no grammar is not
arithmetic-capable, and "Third Age 3019" would otherwise be legal):

```
worldDate ::= YYYY[-YYYYYY] "-" MM "-" DD [ ("T"|" ") HH ":" MM ]
              proleptic Gregorian, 1–6 digit years, leap-year aware
```

**`worldDate` is authoritative for story-day arithmetic** — salience, pace,
mood-decay and the travel/impulse linter rules are all day-*distance*, which an
ordinal cannot supply. It does **not** participate in ordering.

**But the two orders MUST agree** (review B2). `t` and `worldDate` MUST be
**non-decreasing together**:

> `tᵢ < tⱼ` ⇒ `worldDateᵢ ≤ worldDateⱼ`

Enforced at commit and re-checked at merge, exactly as §7 does for `causedBy`
acyclicity. Without it the same log folds two ways: this spec orders by `t`,
Mythopia orders by date (`store.ts:86-89`), and a retcon committed late with
`t=1600, worldDate="3018-01-01"` applies **last** here and **first** there —
violating §8's headline invariant by construction. Worse, Mythopia mixes the axes
*inside one signal* (arc prefixes by log index, windows by date subtraction), so
disagreement yields a curve non-monotone in its own x-axis.

Sparse `t` still supports insertion: an inserted event takes a `t` in the gap
matching its date. **Telling order is not a counter-example** — that is an
Edition's `sequence` (altitude 3), never the fabula.

**Clockless producers** *(v0.6, Aureum review B1)*: a producer with no story
clock — a rules engine, a card table, a chat — MUST NOT fabricate calendar
dates. It MUST declare its `t → worldDate` mapping as a world parameter
(§12.5.1), e.g. `{storyEpoch: "3019-01-15", daysPerT: 0}`, before emitting, so
every date on the wire is *derived and declared*, never invented. `daysPerT: 0`
makes an entire session share one story-day — day-distance 0, so windowed
signals behave honestly instead of consuming fabricated calendar arithmetic.
`granularity` is enumerated: `beat | scene | chapter | era | session`, with
`session` as the clockless producer's value.

**Causality** is a third, independent partial order. `causedBy` need not agree
with story time — reveals, prophecy and foreshadowing are exactly the cases this
format exists to represent. Acyclicity MUST be enforced **at merge**, not only at
write: the cycle-producing construction is amending E1→cite E2 on one branch and
E2→cite E1 on another; neither branch is cyclic, the merge is.

### 7.1 Timelines and forks *(closes O3)*

`timelineId` names a **Timeline node** (`nodeKind: timeline`) whose record
carries `{forkedFrom: TimelineId | ABSENT, forkAt: t, isCanon: boolean}`. An
Event with no `timelineId` is on the **canon line** — the root timeline.

**Forks inherit.**

```
fold(T, t)  =  fold(forkedFrom(T), min(t, forkAt(T)))  ++  events(T, ≤ t)
```

recursively up the fork chain to the canon line. "Fork" means inheritance
everywhere else in version control; the shipped **partition** behaviour is an
artifact of one filter line (`derive.ts:536`), not a design decision — and it
reproduced the silent-divergence class: ArgOS boots an authored fork and gets an
**empty world** while the Studio renders the same fork with **full history**,
neither wrong under v0.4.

**`timelineId` joins the conflict key** (§12.6). Without it, two branches on
different timelines writing the same component fire a false conflict on every
pair.

This *promotes a shipped model into the hashed tier* rather than inventing one:
`Timeline{parentTimeline, branchPoint}` has existed — structured but unversioned
— at `canon-timeline-manager.ts:31-43`, while the versioned `timelineId` was
structureless. v0.5 closes that split. Migration: the fold becomes
fork-inheriting (§11.3).

---

## 8. The Fold — normative result *(closes B2)*

> **The same committed log MUST fold to the same state in every implementation.**

### 8.1 Sort key
```
ORDER BY  at.t ASC,  eventId ASC        // eventId is a ULID ⇒ lexicographically monotonic
```
No other key participates. `worldDate` does not (§7). Implementations MUST NOT
invent a tiebreak. *(Our shipped fold uses `|| a.id.localeCompare(b.id)` at
`derive.ts:539` — conforming only once ids are ULIDs.)*

### 8.2 Within an Event
Changes apply **in array order**. An Event **MUST NOT** contain two changes to
the same `(subject, component, field, object)` quad — validators MUST reject (§12.4).

### 8.3 Authority and the `before` assertion
Apply the **authoritative field** from §5's table. `before` is an **assertion
about the folded state**, not an input.

- If `before` matches folded state (numeric tolerance `1e-9`), apply normally.
- If it does not, the consumer **MUST** apply the authoritative field anyway and
  **MUST** emit a `before-mismatch` diagnostic. It **MUST NOT** silently diverge,
  and **MUST NOT** hard-fail (that would make async multi-producer
  reconciliation impossible).

> IEEE-754 makes a naive `before + amount === after` check reject this spec's own
> examples. Tolerance is mandatory.

**The producer-side twin** *(v0.6, Aureum review B6)*: an L1 emitter MUST NOT
emit a change it did not apply, and MUST NOT silently drop a change its engine
skipped — Aureum's `applyChanges` skips unknown targets with no diagnostic
(`evaluator.ts:311`), so an emitter reading the rule's declared changes emits
what never happened, and one reading the world diff silently loses the rule's
intent. Either case MUST surface an `unapplied-change` diagnostic — the mirror
of `before-mismatch`. Without it the emitted log and the producer's own world
disagree with no signal anywhere.

### 8.4 The lift is stateful
`before` at the lift means **the `after` of the previous altitude-2 Event on that
`(subject, component, field, object)` quad** — not the previous tick's value. Trust
falling `0.7→0.65→0.6→0.45→0.2` over five ticks, lifted as one Event, is
`{before: 0.7, after: 0.2, amount: -0.5}`. A conforming runtime therefore MUST
maintain a shadow map of last-emitted values. This is a contract obligation, not
an implementation detail.

### 8.5 The fold's input set
`fold(events, { include })` where `include` is `'canon'` or `'canon+draft'`.
**There is no default.** Every call site MUST state it.

> Our reference implementation currently disagrees with itself in one file —
> `worldStateAt` defaults `canonOnly:true` (`derive.ts:524`),
> `validateTemporalConsistency` defaults `false` (`:572`). Both are
> non-conforming until the parameter is made explicit.

### 8.6 Canonicalisation before hashing *(review U1)*
Absent, `null`, `[]` and `{}` MUST all canonicalise to **ABSENT** before hashing.
Otherwise `{"timelineId": null}` and `{}` hash differently — and note zod
`.optional()` (`schemas.ts:245`) *rejects* `null` outright, so v0.1's own example
failed our own validator.

---

## 9. Effects — collected, never executed

```jsonc
"effects": [ { "id": "event_01J8…#0", "type": "channel.post", "payload": { … } } ]
```

Effects are **requests**, not writes. The writer collects; a registered consumer
decides whether to run them (Aureum's proven model). Anything an effect changes
returns as a new Event, so the log stays complete. ArgOS's `run_tool` /
`emit_stimulus` are **effects, not verbs**.

### 9.1 At-most-once execution *(closes B4)*

> **Effects execute at most once, driven by commit arrival, never by replay.
> Fold, replay, checkout, `lower(2→1)` and migration operate exclusively over
> `Event.changes`. Once committed, `Event.effects` is opaque historical data.**

Without this clause, a migration tool or branch-materialisation routine that
walks Events and dispatches `effects` is a *correct reading of v0.1* — and
`channel.post` posts to a real account twice, `render.panel` bills a paid model
twice. Both irreversible; both were v0.1's own worked examples.

Each effect carries a stable `id` (`${eventId}#${index}`). Consumers MUST keep an
execution ledger, checked-and-marked **atomically** around dispatch, so a crash
between execution and the returning Event cannot double-fire, and two replicas
watching one stream cannot both pick it up.

---

## 10. Authorship

```jsonc
"author": { "kind": "human"|"simulation"|"agent"|"rule"|"generator"|"ingest",
            "id": "michael" | "argos:run_9f2" | "aureum:rule_17" | "ingest:dune.epub",
            "productionId": "prod_…" }
```

Authorship (who **wrote** it) is distinct from canonization provenance (who
**blessed** it, §11.2). Every prior attempt conflated them.

> `AuthorRefSchema` ships **3** kinds (`user|ai|system`, `schemas.ts:75-79`)
> against the 6 here. ArgOS CANON §6 req 4 is therefore **presently unmet** on our
> side. Named for migration in §11.3.

---

## 11. Commits, canonization, and the honest state of nit

### 11.1 Commit bounds
Simulation → a **beat**. Human authoring → a **session**. Ingest → a
**document/chapter**.

### 11.2 Canonization
Events arrive `draft` and reach `canon` through a gate (`creator | vote | rule`)
plus a temporal-consistency check, returning four narrative resolutions on
conflict (amend / retcon / bridge / fork). **The gate design is proven and
shipped** (`server.ts:4100-4210`).

Two corrections (review U4, U7):

- **`status` should not live inside the hashed Event.** It does today
  (`schemas.ts:252`), mutated in place by `canonizeEventCore` (`server.ts:4145`),
  so a canonization commit carries **zero change records** — contradicting §2.
  It is also a *transaction-time* fact on a *valid-time* record, so "what was
  canon last Tuesday" is unanswerable and uncanonize is destructive.
  **Recommendation: a separate hashed canonization record pointing at the Event;
  derive `status`.**
- **The gate cannot currently filter the firehose.** `canonizeEventCore` selects
  `production?.canonGate || 'creator'` and only resolves a production when
  `sourceProductionId` is set (`server.ts:4158-4162`). Simulation events have no
  production ⇒ they fall to `creator`, which **approves unconditionally**. And the
  `rule` gate is a hard-coded `approved:false` stub (`server.ts:4128-4129`). The
  filter §1 assigns the firehose to is **both unreachable and unimplemented**.

### 11.3 What nit does NOT yet have *(corrects v0.1's worst error)*

v0.1 said the commit layer *"already exists as nit and is unchanged by this
spec."* **That is materially false**, and it is the sentence most likely to cause
a planning error.

`WorldEventSchema` (`schemas.ts:242-257`) has **none** of: `author`, `causedBy`,
`magnitude`, `valence`, `at`/`worldDate`/`granularity`, `changes`, `effects`,
structured `location`. What exists is `stateChanges[]` — a 9-value enum with
free-text `detail` and no before/after (`schemas.ts:236-240`) — **precisely the
defect this spec was written to fix.** Neither `NIT_FORMAT_SPEC.md` nor
`schemas.ts` contains any notion of a *component* or a *fold*.

Mapping §5's 12 verbs onto nit's 19 operations: **6 have no nit op at all**
(`adjust`, `mark`, `unmark`, `transfer`, `reveal`, `conceal`) — plus `merge`, now
7. Every `UPDATE_*` carries `changes: Partial<T>` with new values only;
`shallowChanges` never captures a `before` (`derive.ts:179`). Conversely **10 of
19** nit ops (Scene/Frame/StyleProfile/Scratchpad) have no verb analogue because
they operate on altitude-3 material.

**The hash gate is narrower than v0.1 claimed.** A round-trip failure refuses the
**nit ledger row** (`server.ts:562-565`) — but the studio's own project save
proceeds deliberately (`server.ts:592`: *"The nit ledger must never block the
studio's own commit flow"*), drift is absorbed into the next successful entry with
a `console.error`, and `metadata`/`formatVersion` are pinned before comparison
(`derive.ts:621-629`) so drift there is structurally invisible. It is application
logic at one route, not a library-level property. **It is a useful bar, not the
anti-drift guarantee v0.1 advertised.**

**Migration list** (all REQUIRED for conformance): add `formatVersion` to
`CommitSchema` (`NIT_FORMAT_SPEC.md:516-518` says REQUIRED; `schemas.ts:449-461`
omits it); widen `AuthorRefSchema` to 6 kinds; add `media-asset` and
`narrative-node` node kinds; deprecate `EntityStateChangeSchema` by name; move
`status` out of the hashed Event; adopt ULID ids; make the fold
fork-inheriting (§7.1); formalize the record channel over the existing
`ADD_*`/`UPDATE_*` record operations (§11.5). Where a Change lives is now
**decided** — §11.6: a field of the Event payload, with `changes[]` frozen at
canon (the whole-array-replacement merge hazard, `derive.ts:331-344`, is thereby
confined to drafts).

### 11.4 `specVersion` and unknown verbs
Every Event carries `specVersion`. **An unknown `verb` MUST be rejected, never
skipped** — skipping silently diverges the fold. Unknown `kind` and unknown
extension namespaces are tolerated (§4, §12.8).

### 11.5 The record channel — one commit, two channels *(closes O1)*

§12.7 already said records are *versioned* and cited as `record@version`.
Versioned means a revision sequence, and a revision sequence is a log — the
channel was implied from the start; v0.5 draws it.

| Channel | Clock | Carries | Merge |
|---|---|---|---|
| **Changes** | story time (`at.t` / `worldDate`) | what **happened** | interval algebra over the conflict key (§12.6) |
| **Records** | edit time (the commit sequence) | what is **authored** | field-level last-write-wins, versioned |

This is what §7's bi-temporality actually implies — the spec declared both
clocks and transported only one. The fold signature becomes honest:

> **`fold(commitRange, storyTime)`** — two coordinates, not one.

A record revision is a commit-level operation (nit's existing
`ADD_ENTITY`/`UPDATE_ENTITY`/`UPDATE_RELATIONSHIP` family is the seed and
remains the shape). It carries no `at`, participates in no story-time fold, and
is ordered by the commit sequence alone.

Four things fall out, all previously open:

1. **Studio→Simulation instantiation works** (`lower(2→1)`, §15 L1r). Apply
   records first — the cast, the places, the arcs *exist* — then changes. The
   ordering is forced, not conventional: there can be no event about a character
   who does not exist. This is the Producer II direction a change-only stream
   cannot express.
2. **A rename stops violating §2.** It is a record revision, not a component
   write — completeness holds without inventing `core.name`, which would have
   been exactly the no-op-backing-change pollution §12.8's promotion rule exists
   to prevent.
3. **`record@version` has a referent** for §13 (v1.1) to cite.
4. **The authored half of a canon transports.** Under §12.7's boundary test:
   `Arc.planned_tension` (the drift rule's whole input), `Theme.constraints`,
   visual identity, names and descriptions travel as records. (Three items the
   Mythopia review listed as exiled records turn out to be *components* under
   the same test: `members` → `core.membership` (§6.6); location topology →
   `link` edges with `edgeType: "passage"` and a `{traversal}` payload (§12.7);
   `mythos.params` → the world-parameter declare (§12.5.1).)

**The honest cost — and the real argument for two channels.** Records need
their own merge semantics, but it is the *smaller* problem: records do not vary
over story time, so there are no validity intervals and no interval
intersection — field-level last-write-wins with a version suffices. That
asymmetry, not "breaks every editor", is the load-bearing justification for
keeping the channels separate.

### 11.6 Where a Change lives — DECIDED *(closes O7)*

**Option (a): `changes[]` is a field of the Event payload**, carried inside
nit's `ADD_EVENT`. No new top-level `GraphOperation` kind.

The objection to (a) was the merge case: two branches appending to one
committed event's `changes[]` diff as a whole-array replacement
(`derive.ts:331-344`). That case is now unrepresentable, because of the second
half of the decision:

> **Once an Event is canon, its `changes[]`, `at`, `participants` and
> `timelineId` are FROZEN.** Labels — `title`, `description`, `notes`, `kind` —
> stay mutable forever. Draft events stay fully mutable.

- **Editing what happened is not editing what you call it.** Altering a canon
  event's substance is what amend / retcon / bridge / fork are for: demote it
  (uncanonize is already a deliberate act in the shipped gate) or supersede it.
- **Whole-Event immutability was considered and rejected against the shipped
  surface**: `PATCH /events/:id` (`server.ts:4055-4062`) drives the entire
  authoring surface — inline title, the chronology stepper, participant editing
  — and `dramatizedAtEventUpdatedAt` staleness *depends* on label mutability.
  Freezing everything would delete a working mechanism to solve a problem that
  freezing substance-at-canon already solves.
- Scope note: two branches editing the same **draft**'s `changes[]` still
  conflict coarsely (whole-array). Accepted — drafts are working material, and
  "you both edited this draft" is the correct experience.
- §2's non-empty rule is thereby a trivial schema constraint on one object —
  the cheapest possible enforcement of the load-bearing rule.

This retro-amends §7: `at.t` is immutable once **canon** (v0.2 said "once
committed"); a draft's chronology stepper keeps working.

---

## 12. Components

State is components on nodes, folded from changes — never stored.

### 12.1 Core vocabulary
Every core component names the verbs that write it and its fold rule.

| Component | Fold rule | Written by |
|---|---|---|
| `core.exists` / `core.alive` | `flag` | `create`/`destroy`, `mark`/`unmark` |
| `core.position` | `ref` | `set`, `link` |
| `core.containment` | `ref` (`{parent, mode}`) | `set` |
| `core.appearance` | `scalarLastWrite` | `set` |
| `core.knowledge` | `timestampedSetFirstWrite`, audience-scoped, **two channels** (`known`, `shielded`) | `reveal` / `conceal` |
| `core.possession` | `ref` | `transfer` |
| `core.membership` | `set` (group refs) | `link` / `unlink`, `edgeType: "member-of"` (§6.6) |
| `core.motivation` | `scalarLastWrite` | `set` — *required by the Keystone Rule's third move* |
| **`core.regard`** | `scopedNumeric` (subject→object, −1..1) | `adjust`, `set` |

> **`core.regard` is new in v0.2** (review U13). v0.1's flagship example used
> `core.trust`, which was not in the core table at all. Every system already has
> this state — ArgOS `Knows{familiarity, sentiment}`, nit `Relationship.strength`
> — so it clears the promotion bar (§12.8) on arrival.

### 12.2 Drama vocabulary
Arcs are `narrative-node`s (§3.2), so Mythopia's arc deltas are ordinary
component writes on them:

| Component | Fold rule | Dynamics |
|---|---|---|
| `drama.tension` | `clampedNumeric[0,1]` | persistent; resolution zeroes it |
| `drama.stakes` | `clampedNumeric[0,1]` | ratchets in practice (a linter concern, not a fold concern) |
| `drama.state` | `scalarLastWrite` | `open`/`closed` + `resolvedBy` |
| **`drama.peakAtResolution`** | derived read (§12.2.1) | intensity at the instant of resolution |

> **v0.3 said these were unclamped `numeric`. That was wrong** (Mythopia review
> B3). Mythopia's fold clamps both to [0,1] (`store.ts:225,231`) and its tests
> assert the clamped values — on `arc_frodo_burden` the deltas sum to tension
> 1.05 / stakes 1.20 where the fixture asserts **1.0 / 1.0**. Since convergence
> *squares* intensity and compares against an absolute threshold, unclamped
> values change which events are climaxes, which changes edition chaptering: two
> conforming implementations, one log, different books.
>
> **The honest cost:** clamped `adjust` is **not commutative**, so §6.2's
> convergence-under-concurrency property does **not** hold for these two
> components. Stated rather than resolved by fiat. "Ratchet" remains a narrative
> tendency enforced by the linter, not by the fold.

#### 12.2.1 Capturing intensity at resolution *(review B4)*

Resolution zeroes `drama.tension`, so the resolving event's own contribution to
convergence would be exactly zero — deleting climax detection. Mythopia captures
tension×stakes *before* zeroing (`store.ts:238-247`) and convergence reads it
back (`convergence.ts:31-33`); at Khazad-dûm that peak supplies **~35% of the
asserted C=0.37**.

Two normative clauses:

1. **Intra-event ordering.** Within one Event, all `adjust drama.*` changes MUST
   precede any `set drama.state`. Without this, array order alone swings the
   captured peak by 5× (0.81 vs 0.36 at `evt_011`) — and §8.2 otherwise makes
   array order free.
2. **`drama.peakAtResolution`** is a **derived read**, defined as the folded
   `tension × stakes` immediately prior to the `drama.state → closed` write in
   the same Event. It MUST NOT be sourced from `before`, which §8.3 labels
   advisory and requires consumers to tolerate mismatching.

**Mood is NOT a component.** It is derived from the `magnitude`/`valence` impulse
stream with a closed-form decay, baselined by location atmosphere. Resist
pressure to add `core.mood`.

### 12.3 Components are structs of typed fields *(v0.3 — corrects a v0.2 error)*

**A component is a named struct of one or more typed FIELDS. A scalar component
is the degenerate one-field case.**

v0.2 modelled a component as a single value with a single fold rule. That is
wrong against every producer: **60 of ArgOS's 76 component definitions are
multi-property** (`v2/data/components/*.json` — `Vitals{health, energy, hunger,
hydration}`, `MarketGoods{supply, price, demand}`); Aureum's entity is three
sub-maps; and this spec's own `core.containment` is `{parent, mode}`. v0.2's
`declare` record could not express any of them.

The closed set of **field** fold rules:
`flag` · `scalarLastWrite` · `numeric` · **`clampedNumeric`** · `set` ·
**`timestampedSetFirstWrite`** · `ref` · `scopedNumeric`

Fold rules are per **field**, not per component — `AnimalState.isFleeing` is a
`flag` while `AnimalState.lastX` is `scalarLastWrite`, in one component.

### 12.4 Addressing: the field path

A change addresses `(subject, component, field?, object?)`.

- **`field` present** — writes that field. This is the normal case: you `adjust`
  `Vitals.hunger`, never `Vitals`.
- **`field` absent** — an **atomic whole-component write**. Legal only for `set`,
  and only on a component declared `atomic: true` (e.g. `core.containment`, whose
  `{parent, mode}` must move together). Producers MUST NOT use it to bulk-write a
  non-atomic component.

Consequences, all improvements:

- **§8.2's uniqueness constraint** extends to the quad — an Event MUST NOT carry
  two changes to the same `(subject, component, field, object, audience)`, nor a
  whole-component write and a field write of the same component. **`audience` is
  part of the key** — a single Mythopia `KnowledgeEntry` reveals to some knowers
  while concealing from others in one atomic write (the fixture's flagship irony:
  the Council learns Boromir desires the Ring while it is hidden *from Boromir*).
  Without `audience` in the key that construction is rejected by validators.
- **Merge granularity improves**: two branches writing `Vitals.hunger` and
  `Vitals.energy` do not conflict.
- **§13 read-sets get field granularity**: an artifact that read
  `AnimalState.isFleeing` is not invalidated by a change to `lastX`.

### 12.5 `declare` — runtime vocabulary *(review U5)*

ArgOS invents components at runtime and CANON §16 makes that load-bearing
(*"GodAI can create components at runtime… a `Paranoia` component plus a system
that reads it, authored live"*). A stream that introduces `Paranoia` at t=200 is
unreplayable past t=200 by any receiver that has never heard of it.

```jsonc
{ "verb": "declare",
  "component": "x.argos.vitals",
  "description": "…",
  "atomic": false,
  "fields": {
    "health": { "type": "number",  "fold": "numeric" },
    "hunger": { "type": "number",  "fold": "numeric" },
    "isFleeing": { "type": "boolean", "fold": "flag" }
  } }
```

Four normative rules:

1. **Declaration precedes use.** A change naming an undeclared component MUST be
   rejected (§11.4's unknown-verb rule, extended to vocabulary).
2. **Declarations are idempotent.** Re-declaring an identical shape is a no-op.
3. **Redeclaring a name with a different shape MUST be rejected**, not merged —
   divergent shapes silently diverge the fold. To change a shape, declare a new
   component; the old one keeps its history.
4. **Vocabulary accumulates in the commit, not only inline.** A consumer that
   checks out a branch at t=500 MUST obtain the full active vocabulary without
   replaying from t=0. This is exactly ArgOS CANON §16's **vocabulary commit** —
   the two documents converged on it from opposite sides.

**Runtime-invented components stay in `x.<vendor>.*` — by design.** A GodAI
invention has one producer, so it can never meet §12.8's "two independent
producers" bar. That is the selection pressure working, not a defect: invented
vocabulary travels, folds and replays correctly forever without polluting
`core.*`. Promotion is for vocabulary that two systems independently found
necessary.

*(Core records: 12 state verbs + `declare` = 13.)*

**Worked example — open tag vocabularies** *(v0.6, Aureum review B5)*: a
producer whose rules invent boolean tags at runtime (`$.blessed`, `poisoned`)
declares each as a one-field boolean component (`x.aureum.blessed`, fold
`flag`) written by `mark`/`unmark` — per-tag validity intervals and merge
granularity are the point. `core.membership` is **not** a precedent for
set-folding tags: it is a *ref-set written by `link`/`unlink`*, a different
category. An untyped bag write (`setMeta`) declares a concrete field type
inferred from the value and folds `scalarLastWrite` — or, if it is
author-display data no rule reads, it is a §12.7 **record** and never enters
the change stream at all.

### 12.5.1 World parameters — a second declarable record *(review B6)*

Some values are neither components nor authored prose: they are **world
constants the fold itself needs**. Mythopia's mood kernel
`M(t) = B + Σ vᵢmᵢ·e^(−λ(t−tᵢ))` needs `λ` (`mythos.params.lambda`), a fallback
`mood_baseline`, and the salience/pace/theme **window sizes** — none of which are
per-node components, and all of which v0.3 left with no home at all.

```jsonc
{ "verb": "declare", "target": "world",
  "params": { "lambda": 0.035, "moodBaseline": 0.0,
              "salienceWindowDays": 30, "paceWindowDays": 14, "themeWindowDays": 45 } }
```

Same four rules as §12.5 (precedes use, idempotent, conflicting redeclaration
rejected, accumulates in the commit).

**Two values v0.3 misfiled as authored records are components after all**:
`atmosphere.mood_baseline` on a location and `mood_emission` on a thing. Both
vary with the fold — the baseline is resolved through the *time-varying*
containment chain, and emission depends on the emitter's *position*. By §12.7's
own test (does it vary over story time?) they belong in the component channel:
`core.atmosphere.moodBaseline` and `core.moodEmission`.

### 12.5.2 Link-key declarations *(v0.6, Aureum review B4)*

A producer whose edges are key-addressed strings (Aureum's
`links: Map<key, targetId>` — `location`, `owner`, free-chosen by a human or an
LLM) MUST declare, per key, which verb and component that key emits as:

```jsonc
{ "verb": "declare", "target": "link-keys",
  "keys": {
    "location": { "verb": "set",      "component": "core.position" },
    "owner":    { "verb": "transfer", "component": "core.possession" }
  } }
```

Undeclared keys fall to `link`/`unlink` with a synthesized stable
`edgeId = hash(subject, key)`. Without this, one `setLink` legitimately maps to
four different verbs (§16 lists three rows for it) and two conforming emitters
reading the same rule produce different folds — the silent-divergence class.
Same four rules as §12.5: precedes use, idempotent, conflicting redeclaration
rejected, accumulates in the commit.

### 12.6 Validity intervals *(closes v0.1 Q1)*
A component write is valid **from `t` until the next write to the same
`(subject, component, field, object)` quad**. Conflict is therefore **interval
overlap on the same timeline**, not field equality — the full conflict key is
`(timelineId, subject, component, field, object[, audience])` (§7.1). This is not deferrable: §13's precision guarantee
and §15's merge rule both already depend on it.

### 12.7 Records vs components — the normative boundary *(v0.5)*

> **A datum belongs in the component channel iff it varies as a result of story
> events. Otherwise it is a record** (§11.5).

A node's authored identity — `name`, `description`, canonical portrait, planned
curves, theme constraints — is a record: versioned on the edit clock, cited as
`record@version`, merged field-level last-write-wins. Components carry what the
story itself moves. Dissolving records into components buys nothing and breaks
every editor; transporting them as changes would backdate authorship into story
time.

The test is applied honestly, in both directions:

- `atmosphere.mood_baseline` and `mood_emission` (v0.4), `membership` (§6.6),
  and **location topology** — `link` edges with `edgeType: "passage"` and a
  `{traversal}` payload — are components. A bridge can collapse mid-story, and
  leaving traversal costs in a record would retroactively change the topology
  used to validate *pre-collapse* events: the impossible-travel rule would
  silently reason about the wrong world.
- `Arc.planned_tension` is a record. Authored *intent* does not move because the
  story moved — the drift rule exists precisely to compare the two.

**Engine state that gates future behaviour is a component** *(v0.6, Aureum
review B3)*: if runtime state changes which events *can happen next* — a
oneShot rule's spent flag, a cooldown, an exhausted deck — it varies as a
result of story events *by definition*, and MUST be reified as a component
write in the Event where it changes (`mark x.aureum.spent` on the rule's node,
in the firing Event; rule instances are `x.<vendor>.*` nodes per §3.2).
Behaviour-gating state that lives in no channel makes replay divergence
possible the moment log-only rehydration (L1r) or forking arrives.
Forward-looking for the Aureum vendoring: today its replay rehydrates a
serialized RuleSet snapshot and spent-ness is derivable from
`match.rule.oneShot`, so this is a vendoring obligation, not an active bug.

### 12.8 Extension and promotion
`x.<vendor>.<name>`. Unknown namespaces MUST be preserved verbatim through edits,
commits and merges.

Promotion to `core.*`/`drama.*` requires **(a)** two independent producers
writing it, **(b)** a declared fold rule from §12.3's closed set (per field), and **(c)** at
least one system reading it. Vocabulary grows by **selection**, not generation —
ArgOS §7 proves open vocabulary self-corrupts without it. The same bar applies to
edge types and event kinds, and `core.*` is held to it too.

---

## 13. Read-sets and invalidation **[CARVED TO v1.1]**

> **Why carved — correctness, not scope management.** As specified in v0.4 the
> headline guarantee ("…and nothing else") is **unsound in the unsafe
> direction**: identity `merge` under-invalidates (panels depicting a pre-merge
> face carry no stale flag), canonization changes the canon-only fold without
> writing any component (invalidating nothing), and retcons have no `t` to key
> on. A coarser whole-entity rule fails **safe**; "and nothing else" fails
> **silent** — and implementers build on guarantees, so shipping an unsound one
> is worse than shipping none. v1.1 lands this together with the validity
> intervals it depends on (§12.6) and canonization-as-record (review U4).

Every generated artifact SHOULD record its **read-set**: which components, of
which nodes, at which `t`, on which `timelineId` — plus prompt and reference
hashes.

```jsonc
"readSet": {
  "components": [ { "node": "character_01J8…", "component": "core.appearance",
                    "at": 412, "timelineId": null } ],
  "promptHash": "…", "anchorHashes": ["…"]
}
```

**Downgraded from v0.1's "and nothing else" guarantee**, which was *unsound*, not
merely imprecise (review U6): identity `merge` (§6.4) under-invalidates — panels
depicting a pre-merge face carry no stale flag; canonization changes the
canon-only fold **without writing any component**, so it invalidates nothing; and
retcons have no `t` to key on.

This section is **entirely new construction** — `promptHash`, `readSet` and
`anchorHash` have **zero occurrences** in `src/`. Today's mechanisms are
whole-entity dirty flags (`server.ts:12149-12179`) and whole-event staleness
(`server.ts:3983`).

---

## 14. Squash is a view

> **Squash MUST NOT rewrite history.** The range stays; the summary is derived.

Composition is **per verb-class**, not universal (review U8):

| Class | Composes to |
|---|---|
| `adjust` (numeric) | one `adjust`, summed `amount` — exact |
| `set` / `mark` / `transfer` | one change, first `before` + last `after` |
| `create`+`destroy`, `link`+`unlink`, `transfer(A→B)`+`(B→A)` | **zero changes** — the squashed view is a valid *view* but MUST NOT be committed as an Event (§2) |
| `reveal`+`conceal` | per-audience map, not one change. **MUST NOT collapse** — "A knew, then was deceived" squashing to "A never knew" destroys the irony the verb exists for |
| `magnitude`/`valence` | **no composition rule** — Mythopia's decay kernel is not invariant under replacing N impulses with one. Squashed views MUST recompute from the underlying range |

Mythopia ships the same idea at altitude 3: an Edition's `compressions` collapse
a span into one beat without touching the fabula.

---

## 15. Conformance

| Level | Obligation |
|---|---|
| **L1 — Emit** | Valid Events: non-empty `changes`, per-verb `before`/`after` (§5), `author`, **`at.t` AND `at.worldDate`** (§7), `specVersion`, ULID ids, stateful lift (§8.4), `t`/`worldDate` monotone together |
| **L1r — Emit + Rehydrate** | L1, plus boot a world from a stream via `lower(2→1)`: **records first (§11.5), then changes**. No obligation to maintain an altitude-2 component table; the fidelity obligation is at the seam — what it re-emits after rehydration MUST be altitude-2 consistent with what it consumed. |
| **L2 — Fold** | §8 exactly: sort key, per-verb authority, `before` diagnostics, explicit input set |
| **L3 — Version** | Commit, branch, merge, blame; `merge` redirects resolve transitively |
| **L4 — Analyse** | Systems over the fold (curves, convergence, linter) |

| System | Today | Target |
|---|---|---|
| **ArgOS** | altitudes 1+3, no middle; serialises raw recycled BitECS eids (**no durable identity at all**) | **L1r** — emit at the lift; boot authored worlds by rehydration (records → changes). *(v0.4 said "L1 + L2 locally"; that would force a second, provably lossy world representation — everything below the lift threshold invisible — against a native substrate that is strictly richer. Resolved per ArgOS CANON §6's L1r.)* |
| **Narrative Studio** | partial L1, L3 (see §11.3 for the real gap) | **L1–L3** |
| **Mythopia** | L2 + L4 | **L4** |
| **Aureum** | rules over local state | **L1** — via a **host wrapper around `step()`**, zero evaluator changes: `before` from the pre-step world, `after` from the returned clone, participants from the match context; rules stay pure. Plus: `spawn`/`destroy` added at vendoring (rules cannot create/destroy), link-keys declared (§12.5.2), clock mapping declared (§7), narrative rules emitted as create+reveal (§6.3.1). |

**§16's mapping table is now VERIFIED at source for all four systems**
(2026-07-27). Verification establishes the table's *facts*; it does **not**
establish agreement. **A maintainer from each system MUST still accept the
conformance obligations above before ratification** — Mythopia to L4, Aureum to
L1 with `spawn`/`destroy` added, ArgOS to L1 (it has already stated in CANON §6
that it will conform to whatever this specifies).

---

## 16. Mapping

**Verification status** (was UNVERIFIED in v0.1/v0.2-draft — the ArgOS reviewer
had neither repo in their workspace):

- **Aureum — VERIFIED 2026-07-27** against
  `g89le/04_wonderlab/03_prototypes/transmedia_engine/packages/aureum/src`.
- **Mythopia — VERIFIED 2026-07-27** against `src/core/types.ts` (cloned working
  copy, `pushed_at` 2026-07-23).
- Verification confirms the *table's facts*. It is **not** ratification —
  §15 still requires a maintainer from each to accept the conformance
  obligations.

| This spec | Ours (`stateChange.kind`) | Aureum (`ChangeOperation`) | ArgOS §6 verbs | Mythopia (`NarrativeEvent`) |
|---|---|---|---|---|
| `create` / `destroy` | `born`, `introduced` / — | **absent — confirmed gap** ¹ | `spawn` / `destroy` | — |
| `set` | `transformed` | `setStat`, `setMeta` | `set_state`, `modify_component` | `restyles[]` → `core.appearance` ² |
| `adjust` | — | `incrementStat` | `modify_component` | `arc_deltas[]`, `stakes_deltas[]` |
| `mark` / `unmark` | `died` (→`core.alive`) | `addTag` / `removeTag` | `add_trait` / `remove_trait` | `resolves[]`/`reopens[]` → `drama.state` |
| `link` / `unlink` | — | `setLink` / `removeLink` ³ | `add_relation` / `remove_relation` | — |
| `set` (containment) | — | `setLink` ³ | — | `reparents[]` → `core.containment` ⁴ |
| `transfer` | `acquired` / `lost` | *(via 1:1 links)* ³ | `transfer` | — |
| `reveal` / `conceal` | `learned` | — | — | `knowledge[]{learners, hidden_from}` ⁵ |
| **`merge`** | *(ships as ID rewrite)* | — | *(name-addressed)* | — |
| `declare` | — | — | *(CANON §16 vocabulary commit)* | — |
| *effects* | — | `sideEffects` — **non-narrative only**; narrative side effects are create+reveal (§6.3.1) | `emit_stimulus`, `run_tool` | — |
| `causedBy` | `preconditions` *(inert)* | — | *(proposed 3×, abandoned)* | `causes[]` ✅ shipped |

¹ `ChangeOperation` is exactly 7 variants (`rules.ts:13-19`) and `applyChanges`
handles exactly those 7 (`evaluator.ts:315-335`). `createEntity` exists as an API
function (`world.ts:22`) but is **not rule-reachable**, and `applyChanges`
silently skips unknown targets (`evaluator.ts:311`). So an Aureum *rule* cannot
spawn or destroy — confirmed, and it is a real gap to close at vendoring.

² `Restyle{entity, appearance, note?}` — "the new canonical appearance from this
event onward" — is a `set` on `core.appearance`, not a generic property write.

³ `links: Map<string, string>` (`world.ts:17`) is **1:1** — one `location`, one
`owner` per entity. Inventories and many-to-many relations are not representable
in Aureum; nit's `Relationship` (which carries an `id`) is what closes this, and
it is why §5's `link` requires an `edgeId`. Which verb a given link key emits
as is declared per key (§12.5.2); undeclared keys default to `link`/`unlink`
with a synthesized stable `edgeId`.

⁴ **Correction to the v0.1 table**, which mapped `reparents` to `link`/`unlink`.
`Reparent{entity, to, mode}` is *containment* (`mode: spatial | mental | virtual
| metaphysical | narrative`), which §12.1 folds as `core.containment` — a `ref`,
not a generic edge.

⁵ `KnowledgeEntry{learners?, hidden_from?, fact}` — one entry carries **both**
directions, so it maps to a `reveal` **and** a `conceal` sharing one `subject`
(the fact) with different `audience`s. See the Mythopia-side review for whether
one `audience` field survives group knowers (`expandKnower`) and edition-scoped
audiences.

---

## 17. Out of scope / still open

**Out of scope for v1.0 — carved to v1.1**: read-sets & precise invalidation
(§13); the full component-granular merge *resolution* algebra (v1.0 specifies
the conflict key — `(timelineId, subject, component, field, object[, audience])`
over validity intervals — but not resolution strategies); altitude-1 transport;
prose in the record; realtime/CRDT co-editing.

| # | Open |
|---|---|
| O1 | **CLOSED (v0.5)** → §11.5 — the record channel: one commit, two channels; `fold(commitRange, storyTime)`. |
| O2 | **CLOSED (v0.5)** → §6.6 — reveal records on the group; `core.membership` component; read-time transitive resolution. |
| O3 | **CLOSED (v0.5)** → §7.1 — forks **inherit**; `Timeline{forkedFrom, forkAt, isCanon}` is a hashed node; `timelineId` joins the conflict key. |
| O4 | **Ships implementation-defined in v1.0.** Dangling `causedBy` has four defensible resolutions; a consumer MUST document which it takes (default SHOULD: tolerate as mystery). Cycles are rejected at merge (§7). |
| O5 | **Lift thresholds** — per-world config or learned? (The *stateful* part is settled in §8.4; only thresholds remain open.) |
| O6 | **Ingest confidence** — judgment-tier fields need a confidence so review UIs sort by what needs a human. `magnitude`/`valence` now carry it; `arc_deltas` do not. |
| O7 | **CLOSED (v0.5)** → §11.6 — changes live in the Event payload; `changes[]`/`at`/`participants`/`timelineId` freeze at canon; labels stay mutable; drafts stay fluid. |

---

## Sources

Review: `CHANGE_RECORD_SPEC_REVIEW.md` (2026-07-24, ArgOS side) — five blockers,
all accepted; every code claim independently re-verified.
Mythopia review: `CHANGE_RECORD_SPEC_REVIEW_MYTHOPIA.md` (2026-07-27) — six
blockers, accepted in v0.4.
v0.5 positions (O1/O2/O3/O7, L1r): proposed from the ArgOS side (2026-07-27);
O7 adopted with the freeze rescoped to canon events after verification against
the shipped authoring surface (`server.ts:4055-4062`, `WorldTimeline.tsx`).
Aureum review: `CHANGE_RECORD_SPEC_REVIEW_AUREUM.md` (2026-07-27, workflow: one
Opus reviewer + independent per-blocker verification) — seven blockers, four
confirmed, three narrowed to documentation gaps; all folded in v0.6.
Ours: `NIT_FORMAT_SPEC.md`, `schemas.ts`, `derive.ts`, `server.ts`,
`entity-similarity.ts`, `entity-merging-service.ts`, `git-chunked-extraction.ts`,
`utils/ids.ts`, `canon-timeline-manager.ts`.
ArgOS: `CANON.md` §0/§2/§3/§4/§5/§6/§7/§9/§13/§16.
Mythopia: design spec v0.8 §4/§6/§12/§14; `src/core/store.ts`.
Aureum: `packages/aureum/src/{world,rules,evaluator,serializer}.ts`;
`packages/nit-aureum-adapter/src/adapter.ts`.
