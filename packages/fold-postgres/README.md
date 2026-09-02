# `@_89/fold-postgres`

Transactional PostgreSQL persistence for canonical Fold records. The package
implements `FoldSdkStore` without moving authority into database-specific
projections.

It owns four durable tables:

- append-only workspace events;
- resumable consumer offsets;
- rebuildable projection checkpoints;
- canonical-order and event-kind indexes.

Writes take a workspace-scoped PostgreSQL advisory transaction lock. Event IDs
remain unique, and same-time producer IDs must be monotonic. Batch appends are
atomic when the SDK store supports `appendMany`.

Migrate an existing journal after building:

```bash
FOLD_DATABASE_URL=postgres://... pnpm --filter @_89/fold-postgres migrate -- \
  --workspace local-history \
  --journal .data/fold-history/<workspace-hash>.jsonl
```

The migration is resumable for byte-equivalent events and rejects changed
records.

`PostgresVectorMemoryRanker` is an optional pgvector projection. It accepts a
real `MemoryEmbeddingProvider`, lazily embeds only the already-authorized
documents passed by `FoldSdk.rankMemories`, and restricts every vector query to
those memory IDs. Content digests and revisions make re-indexing deterministic.
The pgvector table is derived and is never authoritative over the Fold log.
