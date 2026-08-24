# `@_89/fold-trajectory`

Fold-backed lifecycle for shared decision trees and captured trajectories. The
package keeps raw steps, explicit projection assignments, capture identity, and
review text in canonical records, then rebuilds projection coverage, route
eligibility, consensus, first divergence, and review-oracle results.

This package does not claim a general automatic projector. Manual, rule, and
model assignments remain explicitly identified and `ambiguous`/`unmapped`
outcomes remain first-class. A real empirical two-model run is still required
to validate useful mapped coverage.
