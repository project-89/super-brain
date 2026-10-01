# Super Brain API

Authenticated HTTP delivery for scoped Fold events, projections, personal
memory, trajectory evidence, transcript history, pull reasoning, and human
steering. The service uses `@_89/fold-sdk` for canonical record, recall,
trajectory, fleet, steering, and transcript catalog behavior.

## Configuration

At least one authentication provider is required. `FOLD_API_CREDENTIALS_JSON`
is the local and self-hosted provider. It maps bearer tokens to a principal, an
optional fixed Fold author, and explicit organization/workspace memberships:

```json
{
  "replace-with-a-secret": {
    "principalId": "user-a",
    "author": { "kind": "human", "id": "user-a" },
    "organizations": {
      "organization-1": {
        "role": "owner",
        "workspaces": {
          "workspace-1": {
            "role": "owner",
            "spaces": { "space-a": "admin" }
          }
        }
      }
    }
  }
}
```

Tokens are retained only as SHA-256 lookup keys in process. Unknown fields,
roles, author shapes, empty credentials, and malformed JSON fail at startup.
Do not commit real credentials.

An optional `capabilities` array independently restricts a credential to route
families such as `events:read`, `events:write`, `memories:read`,
`memories:write`, `trajectories:read`, `trajectories:write`,
`transcripts:read`, `transcripts:write`, `fleet:read`, `reasoning:read`, and
`consumers:read`/`consumers:write`. `organization:admin` gates repository and
audit administration in addition to the organization role. `platform:data-read` is reserved for
audited, expiring support access. Omitting it preserves full access for local
operator credentials. Workspace and space roles still apply after capability
checks.

Hosted deployments can enable Clerk with `CLERK_SECRET_KEY`,
`CLERK_PUBLISHABLE_KEY`, `FOLD_CLERK_AUTHORIZED_PARTIES`,
`CLERK_WEBHOOK_SIGNING_SECRET`, and PostgreSQL. Static and Clerk authentication
may run together during migration. The API accepts Clerk session tokens,
organization API keys, and M2M tokens; OAuth access tokens are not accepted.

`POST /v1/webhooks/clerk` verifies Clerk's Standard Webhooks signature and
idempotently provisions organization and user-membership changes. New Clerk
organizations receive `clerk:<organization id>` internally and a `default`
workspace unless `FOLD_CLERK_DEFAULT_WORKSPACE` is set. Webhook IDs are durably
audited and exact retries are no-ops. Organization deletion immediately removes
the external binding and provider-owned memberships while retaining tenant
records for recovery and retention policy.

Clerk identity is resolved through explicit bindings rather than using Clerk
IDs as internal tenant keys. A minimal binding document is:

```json
{
  "organizations": { "org_clerk": "organization-1" },
  "principals": {
    "user:user_clerk": "user-a",
    "api-key:ak_capture": "capture-a",
    "machine:machine_worker": "memory-worker"
  },
  "memberships": [
    {
      "organizationId": "organization-1",
      "organizationRole": "owner",
      "workspaceId": "workspace-1",
      "workspaceRole": "owner",
      "principalId": "user-a",
      "spaceRoles": {}
    }
  ]
}
```

`FOLD_CLERK_BINDINGS_JSON` remains available as a mutually exclusive bootstrap
mode for local migration. All referenced internal organizations and principals
must be bound. Replacing that document at restart replaces Clerk-owned bindings
and memberships, so a removed identity loses access rather than retaining a
stale database row.
Session tokens must carry an active Clerk organization; its role caps the
stored organization role. API keys are bound as `api-key:<Clerk key ID>` and
M2M identities as `machine:<Clerk machine ID>`. Their Clerk scopes must match
an API capability directly or use the `super-brain:` prefix. For example,
`super-brain:events:write` grants only `events:write`.

An organization API key used by capture can carry this backend-issued Clerk
claim to bind its Fold author:

```json
{
  "super_brain": {
    "author": { "kind": "sensor", "id": "urn:sensor:capture:host-a" }
  }
}
```

M2M tokens also require `super_brain.organizationId` containing the external
Clerk organization ID. `CLERK_MACHINE_SECRET_KEY` is optional when a separate
Clerk machine secret is configured. `FOLD_CLERK_AUTHORIZED_PARTIES` is a
comma-separated list of exact HTTP(S) origins allowed in session-token `azp`.

Optional environment:

- `FOLD_API_HOST`, default `127.0.0.1`;
- `FOLD_API_PORT`, default `3000`;
- `FOLD_DATA_DIR`, default `.data/fold` under the working directory;
- `FOLD_DATABASE_URL`, selects transactional PostgreSQL persistence instead of
  the local JSONL data directory;
- `FOLD_REQUIRE_TENANT_RLS=true`, required for a shared production deployment;
  startup rejects PostgreSQL superuser and `BYPASSRLS` roles;
- `FOLD_API_RATE_LIMIT_PER_MINUTE`, default `300` per client socket address;
  set it to `0` only when an upstream limiter owns that boundary;
- `FOLD_API_CORS_ORIGINS`, an optional comma-separated list of exact `http` or
  `https` origins. Configured origins receive CORS headers and every other
  browser origin is rejected;
- `FOLD_FLEET_ORPHAN_AFTER_MS`, default `86400000` (24 hours). Session
  freshness still becomes unknown after its sensor heartbeat window, while a
  recovery action waits for this longer reconciliation threshold.
- `CLERK_WEBHOOK_SIGNING_SECRET`, enables signed dynamic organization and user
  provisioning and cannot be combined with `FOLD_CLERK_BINDINGS_JSON`;
- `FOLD_CLERK_DEFAULT_WORKSPACE`, default `default`, names the workspace granted
  by Clerk organization membership events.
- `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) enables native Gemini reasoning;
  `FOLD_GEMINI_MODEL` defaults to Google's hot-swapped `gemini-flash-latest`
  alias;
- `ANTHROPIC_API_KEY` enables native Claude reasoning;
  `FOLD_CLAUDE_MODEL` defaults to `claude-sonnet-5`;
- `OPENAI_API_KEY` enables native Codex reasoning;
  `FOLD_CODEX_MODEL` defaults to `gpt-5.3-codex`;
- `FOLD_REASONING_DEFAULT_PROVIDER` accepts a configured provider ID or the
  short provider name (`gemini`, `claude`, `codex`, `custom`, or `local`).
  Gemini is the default whenever its key is configured.

Build and run with:

```bash
pnpm --filter @_89/super-brain-api build
FOLD_API_CREDENTIALS_JSON='{"local-secret":{"principalId":"local","organizations":{"local":{"role":"owner","workspaces":{"local-history":{"role":"owner"}}}}}}' \
  pnpm --filter @_89/super-brain-api start
```

On macOS, the current `FOLD_*` configuration can be installed as an
owner-readable persistent `launchd` service:

```bash
pnpm --filter @_89/super-brain-api start -- install-service
```

## Routes

`GET /health` is public. `POST /v1/webhooks/clerk` uses a verified webhook
signature. All other routes require `Authorization: Bearer <token>`.

The canonical route prefix is
`/v1/organizations/:organization/workspaces/:workspace`. In the table below,
`:tenant` means that prefix. The legacy `/v1/workspaces/:workspace` form is
accepted only when the credential resolves the workspace name to exactly one
organization; legacy credential configuration maps to the reserved `local`
organization.

| Method | Route | Behavior |
| --- | --- | --- |
| `GET` | `/v1/session` | Active Clerk organization and current workspace memberships |
| `POST` | `/v1/webhooks/clerk` | Signed, idempotent Clerk organization/user provisioning |
| `GET`, `POST` | `/:tenant/events` | Access-filtered records or authenticated append |
| `GET` | `/:tenant/event-stream` | Resumable filtered SSE after an exclusive cursor |
| `GET`, `POST` | `/:tenant/consumers/:consumerId` | Principal-scoped durable consumer cursor |
| `GET` | `/:tenant/projection` | Access-filtered materialized Fold state or cursor-paged state section |
| `GET`, `POST` | `/:tenant/memories` | Metadata recall or personal-memory creation |
| `POST` | `/:tenant/memories/recall` | Recall with optional semantic candidates |
| `POST` | `/:tenant/memories/search` | Server-ranked recall over an authorized corpus |
| `GET`, `PATCH`, `DELETE` | `/:tenant/memories/:id` | Lookup, revision, or explicit forgetting |
| `GET`, `POST` | `/:tenant/memory-candidates` | Project-aware proposal review or creation |
| `POST` | `/:tenant/memory-candidate-imports` | Atomic proposal batches of at most 100 |
| `POST` | `/:tenant/memory-candidate-promotions` | Atomic accepted-memory batches of at most 100 |
| `GET`, `POST` | `/:tenant/trajectory-tasks` | Task summaries or shared-tree creation |
| `GET` | `/:tenant/trajectory-tasks/:taskId` | Projection, route, divergence, and cursor-paged run report |
| `POST` | `/:tenant/trajectories` | Record a projected model run |
| `GET` | `/:tenant/fleet` | Rebuilt sessions, freshness, and recovery plans |
| `GET` | `/:tenant/transcript-projects` | Imported project summaries |
| `GET` | `/:tenant/transcript-projects/:projectId` | Project summary and runs |
| `GET` | `/:tenant/transcript-runs` | Runs, optionally filtered by project and source |
| `GET` | `/:tenant/transcript-runs/:runId` | Run, artifact, project, turn, and action metadata |
| `POST` | `/:tenant/transcript-imports` | Owner/admin idempotent metadata import |
| `GET`, `POST` | `/:tenant/repository-enrollments` | Organization-admin repository enrollment |
| `GET` | `/:tenant/audit-log` | Organization-visible platform access audit |
| `POST`, `DELETE` | `/:tenant/identity-bindings[/:externalId]` | Organization-admin machine identity provisioning or revocation |
| `GET` | `/:tenant/identity-audit-log` | Organization-visible identity provisioning audit |
| `GET` | `/:tenant/steering` | Replayed per-actor candidates and intentions |
| `GET`, `POST` | `/:tenant/steering/:actorId` | Actor state or owner/admin steering action |
| `POST` | `/:tenant/reasoning/ask` | Noncanonical provider answer over ranked evidence or an explicit authorization-checked memory set |
| `GET` | `/:tenant/reasoning/providers` | Configured/default reasoning providers and exact models |

Event reads accept `include=canon|canon+draft`, paired `cursorT` and
`cursorEventId`, repeated `kind` filters, or newest-first `pageCursor`
pagination with capture identity filters. Memory, memory-candidate,
transcript-run, and trajectory-task lists also return an opaque `nextCursor`
and total count. Memory reads accept
`scope=all|workspace|space`, `spaceId`, repeated `tag` and `source`, `from`,
`to`, and `limit`.

New subscriptions use `event-stream?order=ingestion&afterSequence=<decimal>`
(or `replay=all|tail`) with `{kind:"ingestion",sequence:"..."}` positions.
The PostgreSQL stream uses bounded indexed pages, respects socket backpressure,
and retains tenant, creator, space, kind, and canonical/draft visibility checks.
Legacy `order=source` (the old route default) remains compatibility-only and cannot
guarantee late-event delivery. Source-time cursors cannot resume ingestion streams.
Stores without ingestion support return 501 rather than falling back silently.
Ingestion SSE drains committed backlog in 100-row scans, yielding to the event loop
between pages and waiting for socket backpressure before reading another page.
It returns to the normal idle polling interval once a scan makes no progress.

`GET consumers/:id?order=ingestion` reports `cursor`, retained `legacyCursor`,
`migrationRequired`, and an authorized `headCursor`; repeated `kind` and `include`
filters make the head match the subscription. A cursor at or beyond that head is
caught up for that access/filter snapshot, not a permanent completion guarantee.
Preview is read-only. Explicit `POST` with `{migration:"replay-all"}` initializes
sequence 0 without deleting the legacy offset or rewinding existing ingestion progress.
New cursor commits use `{cursor:{kind:"ingestion",sequence:"..."}}` on the same route.
Stop the legacy consumer before migration; changing kinds/access may require a new
consumer identity and replay to obtain previously filtered events.

For an already-migrated consumer requiring a full replay, an administrator may
explicitly POST `{reset:{expectedCursor:{kind:"ingestion",sequence:"..."},reason:"..."}}`.
The reason must contain 10 to 2000 characters. The transaction compares the exact
current cursor, appends an audit record to `fold_ingestion_cursor_resets`, and resets
only that principal's consumer to 0; stale expectations return 409. Original offsets,
events, and worker jobs remain intact. **Stop every instance of that consumer first.**
The local worker CLI lock protects only its own host, not a remote worker or an
already-running remote checkpoint; reset does not provide a cross-process generation fence.

## Work Episodes

`POST work-episodes/synthesize` authorizes at most 200 canonical source events,
calls a configured structured model, and reauthenticates membership and source
dependencies after inference. It requires `reasoning:read` and `events:read`, does
not write, and never opens the private capture vault. Content-less sources produce
explicit ungrouped coverage, not invented conversation summaries. Oversized model
inputs return 413; the worker splits windows with `parentWindowId` lineage.

`POST work-episodes/windows` requires `memories:write`, `events:read`, and space
write permission when scoped. PostgreSQL checks exact window retries, episode
revision CAS, canonical evidence hashes and publication scope under its tenant
append lock. Generic event ingress cannot publish episode records.

`GET work-episodes`, `work-episode-windows`, episode `/:id/history`, and both
resources' `/:id/sources` use cursor pagination. Evidence pages default to and
allow at most one complete source event; episode/window lists default to 100.
Sources include authorized
canonical events and current assembled memory snapshots, not truncated excerpts.
Source assembly has an 8 MB safety bound; larger individual evidence is rejected
explicitly rather than loading an unbounded window or truncating its content.
Episode/window detail and historical dependencies are rechecked before returning
prose. Changed/forgotten/inaccessible dependencies withhold records; list coverage
is `authorized-current-only`. There is no stale-summary regeneration dashboard in
this slice. Original event history remains append-only. Person ownership and
raw-artifact enrichment are not inferred. Context is explicitly selected, not an
exhaustive project search; revisions retain prior and continuation evidence.

The State UI requests `projection` with `section=nodes|edges|values|redirects|diagnostics`,
an optional whole-section `query`, and an opaque `pageCursor`. These responses
include complete collection counts but only one page of state rows. The API
keeps a revision-aware projection and incrementally folds append-only suffixes,
so paging never requires a 100+ MB projection response.

Event append authors must exactly match the author bound to the credential.
Memory authorship, creator scope, principal identity, and workspace are derived
by the server and cannot be supplied by the request. Trajectory authorship and
workspace/optional-space scope are derived the same way, but omit creator scope
because task evidence is collaborative. Trajectory requests may attach bounded
producer identity such as agent, session, project, branch, and comparison key;
reserved principal and workspace identity remain server-derived. Space membership is resolved on every
request, so revocation applies immediately to raw records and every projection.

Transcript imports accept only the strict `@_89/fold-transcript` bundle. The
server derives ingest authorship and workspace capture identity, appends missing
records in project/artifact/run/chunk order, preserves a resumed native run over
a changed source artifact as a deterministic immutable snapshot, rejects
inconsistent changes for the same artifact, and makes an exact retry a no-op.
Transcript and intention event kinds are reserved from generic append. The API
journal contains metadata only; a local redacted artifact vault is owned by the
importer and is not served by this API.
Project/run reads follow normal workspace authorization, while import requires
an owner or admin role.

Ranked recall defaults to the deterministic `local-bm25-v2` lexical provider,
which removes common English question words before matching. Its normalized
scores express relative rank within one query, not a probability of correctness.
`ApiDependencies.memoryRanker` is the host port for an embedding or vector
provider. The SDK gives that provider the complete already-authorized,
minimized corpus and reapplies current access to every returned candidate.
Responses
identify the provider as `lexical` or `semantic`; the local provider is never
presented as semantic retrieval.

Pull reasoning uses native Gemini, Claude, or Codex providers when their
server-side credentials are configured. Gemini is preferred by default;
otherwise `local-evidence-v1` remains an explicitly labeled `extractive`
fallback. A host may also inject a custom provider. Provider citations are
restricted to the authorized evidence supplied for that request. Questions and
answers are not appended to Fold implicitly. Callers may provide up to ten
`memoryIds` when a workflow needs an exact evidence set rather than ranked
retrieval. Every ID is resolved through the caller's current memory access, and
the whole request fails without revealing content when any item is unavailable.

Human steering writes are restricted to workspace owners and admins. Actor,
author, workspace, and capture identity are derived by the server, every
lifecycle transition is validated against replay before append, and intention
records are rejected from the generic event route. Workspace members may read
steering state but cannot mutate it.

Each organization/workspace pair uses an opaque SHA-256 journal filename and one serialized SDK
instance. Appends use complete-line JSONL with `sync: true`. The process
acquires an exclusive writer lease before binding its HTTP socket, removes that
lease on graceful shutdown, and recovers a well-formed lease whose PID no longer
exists. This provides one-writer protection for processes on one host. Multiple
hosts or a shared network filesystem still require a store with distributed
locking or compare-and-append semantics.

When `FOLD_DATABASE_URL` is configured, the service instead uses
`@_89/fold-postgres`. It stores canonical events transactionally, takes a
tenant advisory lock for each append batch, and persists organization-scoped
consumer offsets, projection checkpoints, embeddings, memberships, repository
enrollments, and platform audits. Tenant tables use forced RLS and each
operation sets a transaction-local organization claim. JSONL remains available
for local use, migration, and recovery.

Exceptional platform reads require `platform:data-read`, an explicit
organization-qualified `GET`, `X-Super-Brain-Access-Reason`, and
`X-Super-Brain-Access-Expires-At` no more than 15 minutes in the future. Every
successful attempt is appended to the affected organization's audit log before
content is read. Streaming and all mutations are excluded.

Application routes have a bounded, in-memory fixed-window rate limiter; health
and valid CORS preflight remain observable. It keys the actual socket address
and deliberately does not trust `X-Forwarded-For`. Deployments behind a proxy
should either preserve a meaningful source address or disable the local limit
only after enforcing a distributed limit upstream. HTTP request, header,
keep-alive, per-socket request-count, and shutdown-drain bounds prevent indefinite
connections.

TLS termination, recovery actuation, embedding/model
sidecars, multi-host failover, and distributed proxy rate limits remain
deployment concerns rather than implicit behavior in this local service.

## Semantic memory

Lexical BM25 recall is the default. A real HTTP embedding sidecar plus pgvector
can be enabled with `FOLD_DATABASE_URL`, `FOLD_EMBEDDING_URL`,
`FOLD_EMBEDDING_MODEL`, `FOLD_EMBEDDING_DIMENSIONS`, and optionally
`FOLD_EMBEDDING_TOKEN`. The sidecar contract is `POST { model, inputs }` and
`{ embeddings }`; no placeholder vectors are generated by the API.

Missing document embeddings are requested from the sidecar in batches of 64.
Vector queries remain restricted to the authorized Fold memory IDs supplied by
recall and are partitioned by authenticated organization and workspace.

## Retrospective trajectory verdicts

`POST /v1/organizations/:organization/workspaces/:workspace/trajectory-outcomes`
accepts `{ stamp, input: { taskId, trajectoryId, outcome, reason, previousEventId } }`.
Outcomes are `success`, `failure`, or `unknown` (withdraw verification). The reason
must contain 10 to 4,000 characters. `previousEventId` is null for the first review;
later corrections reference the latest review event. Stale reviews return 409.
The stamp must be later than the run and prior review.

This route requires a human-author credential and `trajectories:review` capability
(or an unrestricted operator credential), plus access to the target run. The
server inherits the run's scope; callers cannot broaden it. Generic event append
routes cannot write retrospective verdicts. Review events preserve the original
run, every previous verdict, actor, reason, and timestamp. A human-author machine
credential establishes authorized operator provenance, not physical human presence.

`GET` on the same route takes `taskId`, `trajectoryId`, `limit` (default 100), and
optional `pageCursor`, returning newest-first history with `nextCursor`.
Reports expose the effective outcome, `recordedOutcome`, and latest `outcomeReview`;
SQL summaries and quality counts use the same effective result. No memory is
automatically accepted because its containing run receives a successful verdict.
## Historical derivations

Workspace-scoped `transcript-derivations` routes add evidence without rewriting
imported transcripts. `GET /sources` pages authorized run/artifact pairs;
`GET ?runId=...` pages manifest summaries; `GET /:derivationId?runId=...` pages
derived records in source order. Lists default to 100 rows, accept `limit` up to
1000, and return `nextCursor` for the next request's `pageCursor`.

Owner/admin `POST` accepts either `{manifest}` or `{chunk}`. Source identity and
the original retention policy must match an existing retained import. Manifests
commit to chunk hashes; chunks must arrive in order with contiguous ordinals.
Exact retries are no-ops. Generic event append cannot bypass these routes.
Writes require `transcripts:write`, reads `transcripts:read`; derived events
inherit the original run's visibility scope. Incomplete manifests are visible
but must not be interpreted as completed extraction. For lossless encoded
payloads, see the importer README.
