# Provenance

`@_89/fold-eval` is a Super Brain implementation. No production source file is
copied from Parallax.

## Parallax

- Repository: `git@github.com:HaruHunab1320/parallax.git`
- Commit: `e3c98ebba4b3e29959325f2f974cee27c32a24a6`
- License: Apache-2.0 (`LICENSE` present at the pinned commit)
- Inspected committed files:
  - `packages/control-plane/src/org-patterns/review-verdict.ts`
  - `packages/control-plane/src/org-patterns/workflow-executor.ts`
  - `packages/control-plane/src/org-patterns/decision-history.ts`
  - `packages/control-plane/src/org-patterns/types.ts`
  - related verdict, workflow, and history tests
- Excluded dirty files: untracked `REPORT_PARALLAX.md` and
  `patterns/gateway-dryrun.org.yaml`

The local package reimplements the review tail protocol and command scoring. Its
oracle executor fixes two pinned-source gaps: the configured combine mode is
honored, and unknown oracle types fail as configuration errors. Known oracle
types with no available result are retained as explicit `absent` executions and
are excluded from aggregation.

## Confidence Kernel

History scoring and `min`/`mean` aggregation delegate to the workspace package
`@_89/confidence-kernel` 0.2.0. Its MIT license and byte-level import provenance
are retained in that package. Fold Eval does not duplicate its scoring math.
