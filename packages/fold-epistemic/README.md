# `@_89/fold-epistemic`

Fold-backed personal memory with recall-time workspace, space, and creator
enforcement.

## Proposed Work Episodes

`episodes.ts` defines versioned, cited semantic task proposals, not verified human
conclusions or fictional narrative arcs. One `work.episode-window-recorded` event
atomically retains all input references (up to 200), exact grouped/ungrouped
source-event coverage, and episode snapshots with expected prior revisions. A
chunk containing several tasks can support several episodes only through distinct
validated record-level citations. This does not claim that every message or record
has been semantically assigned. Session or time
boundaries alone do not establish a task. Original project IDs stay distinct;
unresolved project windows record ungrouped coverage only.

Claims cite member event IDs and optional validated record ordinals/lines. A
current assembled memory snapshot has its own semantic digest: historical memory
events are provenance anchors, not independent corroboration or original text.
Metadata-only sources cannot support inferred episodes. Cross-window continuation
and explicitly selected context retain their exact revision dependencies.

The package owns four pure boundaries:

- canonical UUIDv7 memory, revision, and forget records;
- deterministic replay into active memories and durable tombstones;
- personal ownership that workspace administrators cannot override;
- metadata and externally ranked semantic recall with access reapplied after
  ranking.

Memory creation requires a principal and workspace capture identity. A scoped
memory also requires current membership in that space and an event capture
scope naming the same space. Revision and forgetting preserve the original
workspace, space, and creator and fail when applied out of order.

Memory and candidate applicability is independent of audience and authorization:
`project` requires nonempty project IDs, while `general` and `unresolved` require
empty project IDs. Project-filtered recall includes matching project memories and
explicitly general memories, never unresolved records. Unfiltered review retains
all authorized records. Legacy records preserve their missing applicability field;
`effectiveMemoryApplicability` treats them as project-specific when they have
project IDs and unresolved otherwise. No replay migration rewrites old events.
An owner may revise applicability and project IDs together through a normal
memory revision; merged validation runs during construction and replay.

`rebuildMemories` returns the raw internal projection needed by recall. Product
and service boundaries must expose memory through `recallMemories` or
`recallMemoryById`, with a freshly resolved `EpistemicAccessContext`; they must
not return the projection map directly. This ensures that revoked space access
is effective at read time and that semantic candidate IDs cannot bypass creator
or tenant checks.

Embeddings, vector storage, candidate generation, persistence, membership
resolution, clocks, and UUID generation remain host concerns. The package
performs no model, process, filesystem, database, or network I/O.

Pending candidates accept additive `memory.candidate-evidence-added` records.
The original proposal and meaning remain immutable; replay deduplicates support
references and exposes their `supportEventIds`. Accept/reject events must cite
the current support history, preventing a stale review from silently omitting
new evidence. Support after a decision is invalid. Hosts must authorize evidence
sources and enforce atomic candidate transition validation; PostgreSQL does so
under its tenant append lock. Generic in-memory stores do not provide a
cross-process concurrency guarantee.

See [`PROVENANCE.md`](./PROVENANCE.md) and
[`../../docs/inventory/EPISTEMIC_SOURCES.md`](../../docs/inventory/EPISTEMIC_SOURCES.md)
for the pinned Raven evidence, exclusions, and corrected parity cases.
