# confidence-kernel

Pure, host-agnostic confidence scoring for outcome-labelled history.

One small library that factors out the math three separate systems
(decision-pathfinder, Parallax, reasoning-tree) each re-derived: age-decayed
success rate × efficiency × sample-saturation, with a single **risk-posture
knob** that captures the only axis on which those systems actually differ, plus
oracle-combine, drift detection, family pooling, and a journal interface.

No storage engine, no orchestration, no I/O. Hosts keep their own persistence and
map their records onto one normalized `HistoryRun` shape.

```bash
npm install @_89/confidence-kernel
```

## The posture knob

Every host computes the same `raw = successRate × efficiency` and
`sample = min(weightSum / saturationRuns, 1)`. They differ only in what a *sparse*
history should do — which is exactly what "posture" selects:

| Posture | `confidence` | Sparse history → | Use when the low-confidence action is… | Origin |
|---|---|---|---|---|
| `skip` | `raw × sample` | **0** | cheap/safe (re-ask the LLM). A confident prior *replaces* work. | decision-pathfinder |
| `suppress` | `1 − sample × (1 − raw)` | **neutral 1.0** | costly (retry/escalate). The prior only ever *supplements*, min-combined with real checks. | Parallax |

The `curate` lifecycle (reasoning-tree) isn't a single formula — it's a
weighted multi-signal health mix — so the kernel exposes its shared *primitives*
(`ageDecayWeight`, `efficiencyFactor`, `detectDrift`, `applyProbation`,
`shouldRetire`) to compose, rather than a `scoreHistory` posture.

## Core API

```ts
import { scoreHistory, makeHistoryOracle, combine, detectDrift, pool } from '@_89/confidence-kernel';

const score = scoreHistory(runs, {
  posture: 'suppress',
  halfLifeDays: 30,
  saturationRuns: 8,
  minRuns: 3,          // fewer runs → returns null (host emits neutral)
  efficiency: 0.8,     // fixed number, or a fn over successful runs (default: shortest/avg steps)
});
// → { confidence, raw, sample, weightSum, detail } | null
```

- `scoreHistory(runs, opts)` — the scored prior.
- `ageDecayWeight(ageDays, halfLifeDays, base)` — `base:'2'` = `2^(-t/h)`, `base:'e'` = `exp(-t·ln2/h)` (identical; pick to match a host's exact floats).
- `efficiencyFactor(successfulRuns)` — default shortest/avg steps.
- `detectDrift(runs, { recentN, driftThreshold })` — recent-vs-lifetime success collapse.
- `combine(results, 'min' | 'mean')` — fold oracle results; `min` = "as trustworthy as the weakest check".
- `makeHistoryOracle(loadRuns, opts)` — wrap `scoreHistory` as an `Oracle`, neutral fallback when thin. For hosts whose efficiency varies by subject (e.g. a per-role clean-decision rate loaded with the runs), pass `resolveEfficiency(subject, runs)` instead of the fixed `efficiency`; `formatDetail(score, subject, runs)` keeps the host's own wording.
- `pool(runsByTag, tags)` — merge sibling buckets for cold-start transfer.
- `applyProbation` / `shouldRetire` — curate lifecycle gates.
- `InMemoryJournal`, `JsonlJournal` — reference `Journal` impls; hosts adapt their own store to the interface.

## Migration cheatsheet

**decision-pathfinder** (`RecommendationEngine`): replace the decay + composite
scoring with `posture:'skip'`, `decayBase:'e'`, `saturationRuns:10`, passing your
per-edge efficiency (global-shortest / edge-avg) as the `efficiency` number.

**Parallax** (`decision-history.ts`): replace `scoreDecisionHistory()` with
`posture:'suppress'`, `decayBase:'2'`, `halfLifeDays:30`, `minRuns:3`, passing the
clean-decision rate as `efficiency`; `runHistoryOracle` → `makeHistoryOracle`;
the executor's min-combine → `combine(..., 'min')`.

**reasoning-tree** (`skill-health.ts`): swap the efficiency + recency-decay
primitives for `efficiencyFactor` + `ageDecayWeight(halfLifeDays:7)`, the
recent-vs-lifetime check for `detectDrift`, and probation/fast-kill for
`applyProbation`/`shouldRetire`; keep the domain health mix.

The golden tests in `test/golden.test.ts` reimplement each host's current formula
and assert the kernel reproduces it bit-for-bit — run them as the acceptance bar
for each behavior-preserving migration.

## Development

```bash
npm test          # vitest
npm run typecheck # tsc --noEmit
npm run build     # tsup → dist (ESM + d.ts)
```

MIT
