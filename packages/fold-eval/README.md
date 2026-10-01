# `@_89/fold-eval`

Standalone verification primitives for Fold hosts.

## Contracts

- `parseReviewVerdict` parses the final reviewer verdict and confidence marker,
  strips terminal control sequences, and clamps contradictory revise/reject
  pairs to non-approval confidence.
- `runCommandOracle` maps an injected command runner's success, failure, or
  partial test score onto confidence. `nodeCommandRunner` is the provided Node
  shell implementation.
- `evaluateOracles` validates the entire configuration before running handlers,
  executes known oracles, and combines present results with `min`, `mean`,
  `weighted`, or `product`.
- `createHistoryOracleHandler` connects a subject-specific run loader to the
  shared confidence kernel.

Unknown oracle types and combine modes throw `OracleConfigurationError`.
Known-but-unavailable oracles produce an explicit `absent` execution. Absence is
excluded from aggregation; an all-absent evaluation is neutral at confidence
`1`.

```ts
import { evaluateOracles, nodeCommandRunner } from "@_89/fold-eval";

const result = await evaluateOracles(
  {
    oracles: [{ type: "command", run: "pnpm test" }],
    combine: "min",
  },
  { taskId: "task-1" },
  { commandRunner: nodeCommandRunner },
);
```

Command strings are executed by a shell when `nodeCommandRunner` is used. Hosts
must treat oracle configuration as trusted input or supply a restricted runner.

See [`PROVENANCE.md`](./PROVENANCE.md) for pinned sources and extraction limits.
# Project retrieval evaluation

`fold-eval` also provides a read-only, project-scoped retrieval benchmark runner.
Prepare private question/source drafts, capture hash-bound search results, and
summarize explicitly supplied human judgments without promoting memories or
writing canonical feedback. Run `pnpm --filter @_89/fold-eval build`, then
`node packages/fold-eval/dist/retrieval-main.js --help` from the repository root.
See [the workflow guide](../../docs/RETRIEVAL_EVALUATION.md) for authoring, run,
review, denominators, and limitations. Draft ground truth and judgments are
explicitly unreviewed until an operator reviews them.
