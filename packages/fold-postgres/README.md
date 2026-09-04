# `@_89/fold-postgres`

Transactional PostgreSQL persistence for canonical Fold records. The package
implements `FoldSdkStore` without moving authority into database-specific
projections.

It owns organization-scoped durable tables for:

- append-only workspace events;
- resumable consumer offsets;
- rebuildable projection checkpoints;
- semantic memory embeddings;
- organizations, workspaces, memberships, repository enrollments, and
  append-only platform-access audits.

Writes take an organization/workspace-scoped PostgreSQL advisory transaction lock. Event IDs
remain unique, and same-time producer IDs must be monotonic. Batch appends are
atomic when the SDK store supports `appendMany`.

Migrate an existing journal after building:

```bash
FOLD_DATABASE_URL=postgres://... pnpm --filter @_89/fold-postgres migrate -- \
  --workspace local-history \
  --organization local \
  --journal .data/fold-history/<workspace-hash>.jsonl
```

The migration is resumable for byte-equivalent events and rejects changed
records.

`PostgresVectorMemoryRanker` is an optional pgvector projection. It accepts a
real `MemoryEmbeddingProvider`, lazily embeds only the already-authorized
documents passed by `FoldSdk.rankMemories`, and restricts every vector query to
those memory IDs. Content digests and revisions make re-indexing deterministic.
The pgvector table is derived and is never authoritative over the Fold log.

All tenant tables have forced PostgreSQL row-level security. Operations set
`app.organization_id` transaction-locally and also include explicit
organization/workspace predicates. Shared deployments must construct stores
with `requireRlsEnforcement: true`; this rejects superuser and `BYPASSRLS`
application roles at startup.
