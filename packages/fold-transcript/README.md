# `@_89/fold-transcript`

## Reviewed Workspace Identity

The identity module records append-only, human-admin-reviewed directory changes
as `identity.revised` events. People, accounts, agents, and machines are separate
entities. Account associations describe the current reviewed relationship; they
are not authentication grants or proof of ownership of past activity. Renaming a
person never merges identities, and an active external source account has one
identity representation. Attribution reassignment and revocation retain history.

Project aliases preserve all original project IDs and evidence. Active aliases
form an acyclic directed graph; a project filter expands to the currently linked
group only after authorization. Repointing an alias moves its dependent subtree;
revoking a link splits that subtree from its former canonical project. Neither
operation changes workspace, personal, space, or organization permissions.

The SDK previews affected authorized run/memory/candidate counts before alias
changes. Its token binds the actor, input, identity revision, and selected source
metadata at validation time. Counts are not an atomic tally of concurrent ingest.
Identity revisions use deterministic next-slot IDs, so independent PostgreSQL
writers cannot commit different commands against the same identity revision.
Workspace-visible identity revisions accept only workspace-visible evidence IDs.

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
