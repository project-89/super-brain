# `@_89/fold-transcript`

Canonical metadata for historical Claude Code and Codex transcripts.

The package records stable projects, content-addressed artifacts, source-qualified
runs, context segments, turns, and observable actions without storing transcript
text in the Fold journal. Large runs are divided into bounded metadata chunks.
When a harness resumes and extends an already imported native run, the later
artifact is retained as a deterministic immutable snapshot whose
`snapshotOfRunId` points to the original run. Exact snapshot retries remain
idempotent.

Raw source files remain read-only. Artifact storage and source parsing belong to
the importer delivery application. Private thinking blocks are excluded. Project
resolution may be `resolved`, `estimated`, or `unassigned`; missing context is
never silently promoted to fact.

`rebuildTranscriptCatalog` deterministically reconstructs the project/run catalog
and rejects changed snapshot identities, missing references, and chunk gaps.
