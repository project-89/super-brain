# Judgment Source Inventory

This inventory closes the second-pass review required before extracting the
judgment layer. All paths were read from the pinned commits in
`docs/EVIDENCE_MANIFEST.md`; dirty report files were excluded.

## Reasoning Tree

Reusable pure mechanics:

- `normalizeArgs`: lowercase/trim strings, sort object keys, normalize and sort
  arrays, and collapse nullish values to an empty string.
- `branchKey`: stable tool plus normalized-argument identity.
- `entropyOfCounts`: Shannon entropy in bits.
- `analyzeTraceDivergence`: require at least three active traces, reject
  unanimous and same-tool parameter splits, retain entropy at or above `0.5`,
  order by entropy then position, and cap at three opportunities.
- `priorStepOutputs`: bounded immediate-predecessor evidence.
- `mergeStructuralTraces`: trace-level tool support, majority-derived threshold,
  deterministic extension cap, and longest per-tool subsequence retention.

Excluded host concerns:

- behavior-tree nodes and augmentation;
- skill compiler cluster types;
- Google tool records;
- model-authored discriminators and runtime model configuration;
- compiler I/O and orchestration.

The local API therefore owns `ToolCall` and `ToolTrace`, and exposes only pure
data transformations.

## Decision Pathfinder

Reusable behavior:

- aggregate repeated node paths and their outcomes;
- select a most-successful route;
- compare an observed route to consensus at the first divergent edge;
- preserve empty/indeterminate states rather than inventing a recommendation.

The local projection contract is stricter than the source: ambiguous or unmapped
steps break an edge walk, route ties are deterministic rather than insertion
ordered, and outcome evidence is attached to divergent edges when available.
The recommendation engine, tracker, decision-tree runtime, and host interfaces
are not imported.

## Parallax

Reusable behavior:

- parse the last review verdict and confidence marker from terminal output;
- clamp revise and reject verdicts so confidence-in-the-verdict cannot be
  mistaken for confidence-in-the-work;
- map command exit or a passed/failed regex score to confidence;
- combine verification signals;
- keep thin history neutral through the shared confidence kernel.

Local corrections required by the Fold reference:

- honor the configured combine strategy instead of hardcoding `min`;
- treat an unknown oracle type as a configuration error;
- retain a known oracle with no result as explicit absence;
- exclude absent results from aggregation so non-min strategies do not turn
  absence into positive evidence;
- validate the complete configuration before any handler can cause effects.

The workflow executor, role spawning, reviewer messaging, database stores,
logging, retry/escalation policy, and interpolation remain host concerns.
