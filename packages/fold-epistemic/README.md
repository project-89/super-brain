# `@_89/fold-epistemic`

Fold-backed personal memory with recall-time workspace, space, and creator
enforcement.

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

`rebuildMemories` returns the raw internal projection needed by recall. Product
and service boundaries must expose memory through `recallMemories` or
`recallMemoryById`, with a freshly resolved `EpistemicAccessContext`; they must
not return the projection map directly. This ensures that revoked space access
is effective at read time and that semantic candidate IDs cannot bypass creator
or tenant checks.

Embeddings, vector storage, candidate generation, persistence, membership
resolution, clocks, and UUID generation remain host concerns. The package
performs no model, process, filesystem, database, or network I/O.

See [`PROVENANCE.md`](./PROVENANCE.md) and
[`../../docs/inventory/EPISTEMIC_SOURCES.md`](../../docs/inventory/EPISTEMIC_SOURCES.md)
for the pinned Raven evidence, exclusions, and corrected parity cases.
