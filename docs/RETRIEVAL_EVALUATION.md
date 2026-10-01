# Project-scoped retrieval evaluation

The evaluation runner measures retrieval against an explicitly reviewed question
set. It does not promote memories, write canonical feedback, or infer helpfulness
from ranking scores. HTTP operations are limited to listing authorized project
memories and searching them. Local reports may contain full private memory text;
they use mode 0600 and refuse to overwrite files.

## Prepare questions

Build with `pnpm --filter @_89/fold-eval build`. Run commands from the repository
root. Set `FOLD_EVAL_TOKEN` to a workspace read credential using your normal secret
management; do not put it in command arguments. The direct API prefix defaults to
`http://127.0.0.1:3003/v1`; override with `FOLD_EVAL_API` or `--api`.

```sh
node packages/fold-eval/dist/retrieval-main.js prepare \
  --organization local --workspace local-history --project PROJECT_ID \
  --out .data/retrieval/project-draft.json
```

`prepare` fetches the project memory catalog with cursor pagination. The draft
includes decision, failure, and constraint question prompts, full authoring
sources, per-page corpus totals, and an explicit `unreviewed` status. `template`
accepts the same identity flags and creates an offline draft without API access.
The authoring catalog is accepted memories, not pending memory candidates.

Complete a small set of real questions before observing ranked results. For each
question provide `query`, `rationale`, and at least one `expectedEvidence` record:

```json
{
  "eventId": "the-real-source-event-id",
  "projectId": "the-project-id",
  "runId": "the-real-run-id",
  "turnId": "the-real-turn-id"
}
```

Only `eventId` is required; use the other fields when the expected evidence needs
that exact source location. Every supplied field must match the recalled memory's
evidence. Inspect the underlying source rather than trusting a generated memory
summary. Expected references should establish the answer, not merely share a
keyword. Record selection method, reviewer identity and ISO timestamp in
`groundTruth`, and explicitly change its `status` to `reviewed`. Unreviewed or
empty-source question sets cannot run. Reviewer identities are operator-supplied,
not cryptographically authenticated human attestations.

## Run and judge

```sh
node packages/fold-eval/dist/retrieval-main.js run \
  --suite .data/retrieval/project-draft.json --out .data/retrieval/run-1.json
node packages/fold-eval/dist/retrieval-main.js review-template \
  --report .data/retrieval/run-1.json --out .data/retrieval/judgments-1.json
```

The run stores the suite/hash, questions, ranker, per-question authorized corpus
size, top-k results, complete returned memories/evidence, memory revisions, and
timestamps. Scope violations, duplicate results, and failed requests abort the
run instead of producing misleading low-relevance measurements. The authoring
catalog is not included in the evaluation suite hash or sent to the API.

For each recalled memory, a human should judge whether it helped answer that
specific question. Fill `signal` with `helpful`, `unhelpful`, or `superseded`, plus
`reviewer`, `recordedAt`, and a concrete `reason`; set `status` to `reviewed`.
Remove entries not yet judged to obtain an explicitly partial report. Leaving
an unfinished entry causes validation to fail, not an implicit negative verdict.

```sh
node packages/fold-eval/dist/retrieval-main.js summarize \
  --report .data/retrieval/run-1.json \
  --judgments .data/retrieval/judgments-1.json \
  --out .data/retrieval/evaluation-1.json
```

Judgments bind to the exact hash of the returned run and a question/memory pair.
Old judgments cannot silently carry over to changed results or memory revisions.
Keep each run and judgment report to compare later ranker changes against the
same question set. Neither these local judgments nor their summary is published
to canonical memory feedback automatically.

## Read the measurements

- Evidence coverage: matched expected references / all expected references.
- Questions with a source match: questions with at least one matching reference /
  all questions, including questions returning zero results.
- Mean reciprocal evidence rank: sum of reciprocal first matching ranks / all
  questions. A no-match question contributes zero.
- Returned source-link coverage: returned memories with evidence / all returned
  memories. This counts references; it does not prove source reachability.
- Judgment coverage: human-judged results / all returned results.
- Helpful among judged: helpful judgments / all judgments, including superseded
  and unhelpful. Unjudged results remain unknown. Empty denominators report null.

No metric here measures source reachability, semantic alignment, task success,
or correctness of causal trees. Expected-source overlap is not precision or
answer correctness. Each API search sees the live authorized project corpus,
not an atomic frozen database; compare per-question corpus sizes and revisions
before attributing a difference solely to a ranker. Human judgments remain the
gate before calling a memory collection useful or bulk-promoting candidates.

## Local starter drafts (September 11)

Private, ignored drafts exist under `.data/retrieval-evaluation-2026-09-11/`:

- `super-brain-local-root-draft.json`: project
  `project-4152c33e571316a4c6eaf668`, 10 accepted authoring memories.
- `super-brain-remote-draft.json`: project
  `project-de12e153f08f60821053692c`, zero accepted authoring memories.

Both are unreviewed; no real question or helpfulness verdict was fabricated.
These are two existing native project identities for the same repository, not a
merged evaluation scope. Reconciling those identities is separate work. Counts
refer only to accepted memories visible to the local owner, not imported runs,
derived evidence, or pending candidate memories.
