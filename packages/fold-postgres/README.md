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

### Atomic commands and delivery cursor upgrade

PostgreSQL is the supported pilot backend for state-dependent commands. The SDK pins the
snapshot used for validation, stages the complete event batch, then commits with an expected
workspace revision and a durable command receipt in one tenant transaction. Stable command
identity comes from principal, operation and supplied event stamps. Repeating identical input
returns the recorded result across API processes/restarts; changed input conflicts. Benign
revision contention is revalidated a bounded number of times, then returns retryable HTTP 503
`revision_conflict`. Domain conflicts remain HTTP 409. Receipts are protected by tenant RLS.

Canonical replay/fork cursors remain `(t,eventId)`. Delivery and consumer offsets now use
`{version:2,sequence:"123"}` and SSE `afterSequence=123`, preserving PostgreSQL bigint precision.
A legacy event-time stream cursor, or an existing offset row without a delivery sequence,
replays from sequence zero and emits v2 cursors. This intentionally permits duplicate delivery
to repair possible late-event gaps; consumers must make processing idempotent before upgrading.
Legacy offset writes are rejected. Stop old workers/API processes before upgrading, start the
new API once to apply additive DDL, then restart upgraded consumers. Persisted v2 acknowledgments
cannot regress or exceed the committed workspace delivery head. Do not roll back consumers to
old binaries against upgraded offsets without a fresh replay consumer identity.

Initializers share one DDL lock, including fresh-schema creation. Identity provisioning persists
source occurrence times per organization, membership and credential, with deletion winning ties.
A deleted organization blocks subordinate upserts until a newer explicit organization upsert.
Signed Clerk webhooks must include their source `timestamp`; delivery retry timestamps are not
ordering evidence. Existing identity audit history seeds conservative occurrence watermarks using
its receipt time during migration, so older replayed provider events may be deliberately ignored;
reconcile current provider state with a new source event when needed.
