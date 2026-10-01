# `@_89/fold-postgres`

Transactional PostgreSQL persistence for canonical Fold records. The package
implements `FoldSdkStore` without moving authority into database-specific
projections.

It owns organization-scoped durable tables for:

- append-only workspace events;
- resumable consumer offsets;
- ingestion-sequence subscription offsets, separately versioned from source-time cursors;
- rebuildable projection checkpoints;
- semantic memory embeddings;
- organizations, workspaces, memberships, repository enrollments, and
  append-only platform-access audits;
- pre-tenant external organization and principal identity bindings used by
  authentication providers such as Clerk.

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

External identity bindings are control-plane lookup tables because they must be
resolved before a tenant is known. They contain mappings only, never Fold
content, and are replaced per provider alongside provider-owned memberships so
removed identities fail closed.

## Ingestion Subscriptions

Subscriptions use the existing immutable `fold_events.sequence` as a decimal-string
BIGINT cursor (`{kind:"ingestion",sequence:"123"}`). This is arrival order, not
source time; chronological lists, event payloads, and projection cursors are unchanged.
Both append and import acquire the workspace transaction advisory lock **before**
sequence allocation and retain it through commit. This serializes commits within
each workspace, preventing a reader from skipping a lower uncommitted sequence.
Sequence gaps from other tenants or rolled-back transactions are valid and are not
record counts. Direct SQL ingestion that bypasses this locking protocol is unsupported.

`fold_ingestion_consumer_offsets` retains new principal-scoped positions independently
of legacy source-time offsets. Migration explicitly initializes replay at sequence 0,
retains the old row, and cannot rewind an already-migrated consumer. Never translate
the old timestamp watermark to one sequence: that would omit late historical events.
Replay is at-least-once; consumers must deduplicate deterministic event/job identities.
Cursor commits reject backward positions and positions beyond the committed log.

Ingestion pagination orders by the qualified numeric `e.sequence`, never the text
projection used to transport a BIGINT. Regression tests enumerate more than 1200
rows through both database pages and real SSE across decimal digit boundaries.
An explicit administrative cursor reset compares the current sequence under the
tenant transaction lock, writes an append-only audit row, then resets it to 0 in
the same transaction. It retains legacy offsets and event/job data. All consumer
instances must be stopped: the reset is not a generation fence against a stale
remote process committing an old checkpoint afterward.
