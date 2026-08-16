# `@_89/fold-trace`

Pure trace projection, route analysis, divergence mining, and structural merge
for Fold.

The package deliberately keeps projection outcomes next to the untouched raw
step. `ambiguous` and `unmapped` are first-class outcomes; analysis never joins
mapped nodes across either kind of gap. This makes incomplete projection visible
in coverage and route eligibility instead of silently manufacturing an edge.

The initial fixture is structural, not empirical. See
[`../../docs/spikes/2026-08-14-projection-feasibility.md`](../../docs/spikes/2026-08-14-projection-feasibility.md).

## Tool Trace Primitives

- `normalizeArgs` and `branchKey` canonicalize cosmetic argument differences.
- `entropyOfCounts` and `analyzeTraceDivergence` find supported structural
  choices while excluding same-tool parameter changes.
- `priorStepOutputs` retains the immediate evidence available before a choice.
- `mergeStructuralTraces` extends a centroid with tools supported across traces,
  preserving the longest per-tool iteration sequence.

Projection gaps remain explicit. Structural mining is deliberately pure: model
authored discriminators and behavior-tree compilation remain host concerns.

See [`PROVENANCE.md`](./PROVENANCE.md) for pinned sources and extraction limits.
