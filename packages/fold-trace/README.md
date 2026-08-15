# `@_89/fold-trace`

Risk-retirement implementation for cross-model projection onto shared decision
identity.

The package deliberately keeps projection outcomes next to the untouched raw
step. `ambiguous` and `unmapped` are first-class outcomes; analysis never joins
mapped nodes across either kind of gap. This makes incomplete projection visible
in coverage and route eligibility instead of silently manufacturing an edge.

The initial fixture is structural, not empirical. See
[`../../docs/spikes/2026-08-14-projection-feasibility.md`](../../docs/spikes/2026-08-14-projection-feasibility.md).

