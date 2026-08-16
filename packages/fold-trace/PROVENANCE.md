# Provenance

`@_89/fold-trace` is a Super Brain implementation. No production source file is
copied from a sibling workspace.

## Reasoning Tree

- Repository: `git@github.com:project-89/reasoning-tree.git`
- Commit: `e517359966b4310f0c0f00f1a4c94a2da4d6d66a`
- Declared package license: ISC
- Inspected committed files:
  - `src/compiler/trace-divergence.ts`
  - `src/compiler/structural-merge.ts`
  - `src/__tests__/trace-divergence.test.ts`
  - `src/__tests__/structural-merge.test.ts`
- Excluded dirty file: untracked `REPORT_REASONING_TREE.md`

The local package reimplements argument normalization, branch keys, Shannon
entropy, structural divergence filtering, prior-output extraction, and
support-based structural merge against package-owned trace types. It does not
include behavior-tree augmentation, model calls, compiler orchestration, or
Reasoning Tree host types.

## Decision Pathfinder

- Repository: `git@github.com:HaruHunab1320/decision-pathfinder.git`
- Commit: `5ceb7e36b128736bd336d5b0afce9ad4befa8152`
- License: ISC (`LICENSE` present at the pinned commit)
- Inspected committed files:
  - `src/recommendation/RecommendationEngine.ts`
  - `src/core/interfaces.ts`
  - related recommendation tests
- Excluded dirty file: untracked `REPORT_DECISION_PATHFINDER.md`

The local projection analysis owns its route aggregation and
first-divergent-edge API. Parity fixtures retain successful-route selection and
first-edge divergence behavior while adding deterministic lexical tie-breaking.
