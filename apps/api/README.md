# Super Brain API

Authenticated HTTP delivery for scoped Fold events, projections, personal
memory, trajectory evidence, transcript history, pull reasoning, and human
steering. The service uses `@_89/fold-sdk` for canonical record, recall,
trajectory, fleet, steering, and transcript catalog behavior.

## Configuration

`FOLD_API_CREDENTIALS_JSON` is required. It maps bearer tokens to a principal,
an optional fixed Fold author, and explicit organization/workspace memberships:

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

`GET /health` is public. All other routes require
`Authorization: Bearer <token>`.

The canonical route prefix is
`/v1/organizations/:organization/workspaces/:workspace`. In the table below,
`:tenant` means that prefix. The legacy `/v1/workspaces/:workspace` form is
accepted only when the credential resolves the workspace name to exactly one
organization; legacy credential configuration maps to the reserved `local`
organization.

| Method | Route | Behavior |
| --- | --- | --- |
| `GET`, `POST` | `/:tenant/events` | Access-filtered records or authenticated append |
| `GET` | `/:tenant/event-stream` | Resumable filtered SSE after an exclusive cursor |
| `GET`, `POST` | `/:tenant/consumers/:consumerId` | Principal-scoped durable consumer cursor |
| `GET` | `/:tenant/projection` | Access-filtered materialized Fold state |
| `GET`, `POST` | `/:tenant/memories` | Metadata recall or personal-memory creation |
| `POST` | `/:tenant/memories/recall` | Recall with optional semantic candidates |
| `POST` | `/:tenant/memories/search` | Server-ranked recall over an authorized corpus |
| `GET`, `PATCH`, `DELETE` | `/:tenant/memories/:id` | Lookup, revision, or explicit forgetting |
| `GET`, `POST` | `/:tenant/memory-candidates` | Project-aware proposal review or creation |
| `POST` | `/:tenant/memory-candidate-imports` | Atomic proposal batches of at most 100 |
| `POST` | `/:tenant/memory-candidate-promotions` | Atomic accepted-memory batches of at most 100 |
| `GET`, `POST` | `/:tenant/trajectory-tasks` | Task summaries or shared-tree creation |
| `GET` | `/:tenant/trajectory-tasks/:taskId` | Projection, route, divergence, and review report |
| `POST` | `/:tenant/trajectories` | Record a projected model run |
| `GET` | `/:tenant/fleet` | Rebuilt sessions, freshness, and recovery plans |
| `GET` | `/:tenant/transcript-projects` | Imported project summaries |
| `GET` | `/:tenant/transcript-projects/:projectId` | Project summary and runs |
| `GET` | `/:tenant/transcript-runs` | Runs, optionally filtered by project and source |
| `GET` | `/:tenant/transcript-runs/:runId` | Run, artifact, project, turn, and action metadata |
| `POST` | `/:tenant/transcript-imports` | Owner/admin idempotent metadata import |
| `GET`, `POST` | `/:tenant/repository-enrollments` | Organization-admin repository enrollment |
| `GET` | `/:tenant/audit-log` | Organization-visible platform access audit |
| `GET` | `/:tenant/steering` | Replayed per-actor candidates and intentions |
| `GET`, `POST` | `/:tenant/steering/:actorId` | Actor state or owner/admin steering action |
| `POST` | `/:tenant/reasoning/ask` | Noncanonical provider answer over authorized evidence |

Event reads accept `include=canon|canon+draft`, paired `cursorT` and
`cursorEventId`, and repeated `kind` filters. Memory reads accept
`scope=all|workspace|space`, `spaceId`, repeated `tag` and `source`, `from`,
`to`, and `limit`.

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
records in project/artifact/run/chunk order, rejects changed immutable identity,
and makes an exact retry a no-op. Transcript and intention event kinds are
reserved from generic append. The API journal contains metadata only; a local
redacted artifact vault is owned by the importer and is not served by this API.
Project/run reads follow normal workspace authorization, while import requires
an owner or admin role.

Ranked recall defaults to the deterministic `local-bm25-v1` lexical provider.
`ApiDependencies.memoryRanker` is the host port for an embedding or vector
provider. The SDK gives that provider an already-authorized, minimized corpus
(bounded at 10,000 memories) and reapplies current access to every returned
candidate. Responses
identify the provider as `lexical` or `semantic`; the local provider is never
presented as semantic retrieval.

Pull reasoning defaults to `local-evidence-v1`, an explicitly `extractive`
provider that briefs ranked memory and optional actor state. A host may inject a
`model` provider through `ApiDependencies.reasoner`. Provider citations are
restricted to the authorized evidence supplied for that request. Questions and
answers are not appended to Fold implicitly.

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

TLS termination, credential rotation, external identity providers,
authenticated external sensor producers, recovery actuation, embedding/model
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
