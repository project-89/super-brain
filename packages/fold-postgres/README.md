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
with `schemaMode: "verify"` and `requireRlsEnforcement: true`. Runtime verification
performs no DDL and rejects owner/admin/schema-creation privileges, RLS bypass,
unexpected policies and incompatible component versions. Use a separate migration
owner and explicit API `migrate`/`bootstrap` commands; see [the deployment runbook](../../deploy/README.md).

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
explicit API migration with the migration identity, then start verified runtime
services and upgraded consumers. Persisted v2 acknowledgments
cannot regress or exceed the committed workspace delivery head. Do not roll back consumers to
old binaries against upgraded offsets without a fresh replay consumer identity.

Initializers share one DDL lock, including fresh-schema creation. Identity provisioning persists
source occurrence times per organization, membership and credential, with deletion winning ties.
A deleted organization blocks subordinate upserts until a newer explicit organization upsert.
Signed Clerk webhooks must include their source `timestamp`; delivery retry timestamps are not
ordering evidence. Existing identity audit history seeds conservative occurrence watermarks using
its receipt time during migration, so older replayed provider events may be deliberately ignored;
reconcile current provider state with a new source event when needed.

### Ingestion subscriptions

The ingestion API (`readIngestionPage`, `latestIngestionCursor`, `commitIngestionCursor`)
exposes the same immutable `fold_events.sequence` as `{kind:"ingestion",sequence:"123"}`
and stores consumer progress in the v2 delivery offset (`fold_consumer_offsets.cursor_sequence`).
This is arrival order, not source time; chronological lists, event payloads, and projection
cursors are unchanged. Both append and import acquire the workspace transaction advisory lock
**before** sequence allocation and retain it through commit, so a reader cannot skip a lower
uncommitted sequence. Sequence gaps from other tenants or rolled-back transactions are valid and
are not record counts. Direct SQL ingestion that bypasses this locking protocol is unsupported.

`ingestionConsumerStatus` reports a legacy offset row without a delivery sequence as
`migrationRequired`; `commitIngestionCursor` refuses it until `migrateConsumerCursor` explicitly
initializes replay at sequence 0. Migration retains the old event-time position for audit and
cannot rewind an already-migrated consumer. Never translate the old timestamp watermark to one
sequence: that would omit late historical events. Replay is at-least-once; consumers must
deduplicate deterministic event/job identities.

An explicit administrative cursor reset (`resetConsumerCursor`) compares the current sequence
under the tenant transaction lock, writes an append-only `fold_ingestion_cursor_resets` audit row,
then resets it to 0 in the same transaction. It retains legacy offsets and event/job data. All
consumer instances must be stopped: the reset is not a generation fence against a stale remote
process committing an old checkpoint afterward.

Selected stores (`database.store(tenant, selection)`) read a pinned subset of the log; their
revision is the head of that selection, and commands committed through them compare the same
selected head.
