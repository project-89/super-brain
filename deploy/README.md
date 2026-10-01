# Private single-server deployment

This recipe assembles PostgreSQL 17/pgvector, two API processes and the Brain application behind a TLS proxy. It uses pinned image digests, Node 24.20.0, pnpm 10.8.1 and a frozen dependency lock. Only the proxy binds a host port by default, on loopback. Capture, the memory worker and MCP remain on explicitly enrolled local machines. The recipe does not enroll a real machine, activate a public domain or upload data.

`node scripts/deployment-smoke.mjs` creates an isolated Compose project, unique credentials and private files under ignored `.data/deployment`, tests the assembled services, and removes only its own containers and volumes. It verifies the local CA rather than disabling certificate verification. Its report distinguishes tested assembly from a live deployment. Run it after dependencies are installed. The smoke build uses the current source checkout and does not use live local daemon configuration.

## Credentials and initialization

Set `FOLD_DEPLOY_SECRETS_DIR` to a private directory outside the build context (or within ignored `.data`). Its parent must be owner-only. Supply the following files without committing them:

| File | Used by | Content |
| --- | --- | --- |
| `database-admin-password` | PostgreSQL initialization | Administrative password |
| `migration-password` | PostgreSQL initialization | Migration-role password |
| `runtime-password` | PostgreSQL initialization | Runtime-role password |
| `recovery-password` | PostgreSQL initialization | Recovery-role password |
| `migration-database-url` | One-shot migration/bootstrap | URL for `fold_migrator` at `database:5432/super_brain` |
| `runtime-database-url` | API processes | URL for `fold_runtime` at `database:5432/super_brain` |
| `api-credentials.json` | API and explicit enrollment | Static credential configuration with explicit capabilities |

The API runs as the nonroot `node` user. Local Compose file-secret mounts preserve host leaf permissions; arrange read-only access for that container user while retaining an owner-only host parent. The disposable smoke uses read-only leaf files under a private directory and verifies actual startup. Do not put administrative URLs, recovery keys or passwords in a shared `env_file` mounted into every service. Runtime API containers receive only their runtime URL and intended authentication settings.

For a fresh owned database:

```sh
docker compose -f deploy/compose.yaml build api-a proxy
docker compose -f deploy/compose.yaml up -d database
docker compose -f deploy/compose.yaml run --rm migrate
docker compose -f deploy/compose.yaml --profile bootstrap run --rm bootstrap
docker compose -f deploy/compose.yaml up -d api-a api-b proxy
```

`migrate` initializes the supported schema and grants required data privileges; it does not replace memberships. `bootstrap` deliberately enrolls the configured static/Clerk memberships. Run bootstrap only when that replacement is intended. Normal `serve` uses `FOLD_POSTGRES_SCHEMA_MODE=verify`, performs no DDL and never reseeds memberships, so removal persists across restarts. Both APIs must be upgraded together after migration. A required component with a missing/newer version fails closed. Each component migration is transactional; the service remains unavailable until all required components finish. A failed migration does not authorize rolling an old binary forward over a newer schema.

For compatible local use outside this recipe, omitted schema mode retains `migrate`; local serve also retains configured membership replacement unless `FOLD_API_SEED_MEMBERSHIPS=false`. `verify` rejects `FOLD_API_SEED_MEMBERSHIPS=true`. The existing `fold-postgres migrate --journal ...` command imports JSONL and is distinct from API schema migration/bootstrap.

The migration role owns the schema/tables. Runtime has schema usage, required table operations and sequence use, but no table/database/schema ownership, creation, RLS bypass or administrative-role membership. Event/command receipt/audit tables grant only their append/read contract; schema versions and embedding configuration are read-only. Runtime verification checks privileges, exact required component versions, required columns, forced RLS and the expected tenant policy. The recovery role has separate SELECT-only grants and BYPASSRLS to take a complete declared-schema dump; it is never a runtime identity.

## TLS and the hosted application

The default proxy uses Caddy's internal CA at `https://localhost:8443`. Keep its `caddy_data` volume so its local trust root survives restarts. Distribute/trust that CA deliberately on enrolled clients; the smoke copies it privately for one explicitly verified request. For a real public hostname, review a separate Caddy configuration using that hostname and the chosen certificate issuer, expose the intended ports, and configure firewall/DNS before activation. This template does not silently request a public certificate.

Brain is built with `/api` as its canonical API base URL. The proxy removes that prefix and forwards API/SSE requests to both healthy API processes. No canonical token is embedded in the JavaScript build. Local capture credentials remain separate; `/capture` returns an explicit unavailable status on the hosted server until the browser is configured to reach its enrolled local relay. Persisted browser connection settings should be reviewed when moving an existing browser profile to a different server.

## Readiness, budgets and alerts

`/health` is process liveness. `/ready` is bounded required-store readiness and returns only `ready` or `unavailable`, without connection details. Database health has a dedicated one-connection pool, server/client query deadlines and one outstanding probe; a timed-out promise retains its slot until actual settlement. The supported lexical service does not require a remote embedding/model health call. Unknown local worker or backup coverage is reported honestly in authorized diagnostics.

An explicit `operations:read` credential with current organization owner/admin membership can read `GET /v1/organizations/:organization/workspaces/:workspace/operations`. It reports sanitized dependency state, request/error/limit counts and duration buckets, plus scoped consumer checkpoint coverage. `largestCursorPositionGap` is an ingestion-position gap, not an event count (positions may include other workspace writes). No registered consumer means unknown pipeline coverage. Counters are process-local; a proxy response samples one API process. Query each replica for a complete operational view.

Request budgets are process-local: `FOLD_API_RATE_LIMIT_PER_MINUTE` controls network-address pre-authentication traffic (the proxy address is shared), `FOLD_API_PRINCIPAL_RATE_LIMIT_PER_MINUTE` controls authenticated principals across token rotation, and `FOLD_API_TENANT_RATE_LIMIT_PER_MINUTE` controls workspaces. Storage capacity rejects new keys until the window expires and never evicts a live exhausted principal. `FOLD_API_STREAM_MAX_CONNECTIONS`, `FOLD_API_STREAM_MAX_PER_PRINCIPAL` and `FOLD_API_STREAM_MAX_PER_TENANT` bound streams; closed/error streams release slots. Two replicas do not imply one distributed quota. Add an operated shared gateway if strict deployment-wide accounting is needed.

The bounded local monitor is `node scripts/check-operations.mjs`. Configure `FOLD_OPERATIONS_API_URL`, `FOLD_OPERATIONS_ORGANIZATION`, `FOLD_OPERATIONS_WORKSPACE`, and `FOLD_OPERATIONS_TOKEN_FILE`; optional `FOLD_OPERATIONS_CONFIG` selects a reviewed threshold file. `deploy/monitoring.json` supplies defaults for checkpoint lag, process-lifetime error count and 25-hour verified backup age. `FOLD_OPERATIONS_BACKUP_RECEIPT` points to a local recovery-verification receipt, not the archive/key. The monitor reads only bounded metadata and emits sanitized JSON with exit 0 (healthy), 1 (action required), or 2 (unknown/unavailable). Run it from the chosen local scheduler and route its result through the operator's approved notification system. It sends no Slack, email or webhook notifications. A local verified archive does not establish an operated off-host backup.

## Restart, migration failure and rollback

Keep PostgreSQL and Caddy data in their named volumes. Graceful API shutdown closes request/stream connections within a bounded drain and then closes dependency pools. Restarting APIs must not restore revoked memberships. Required-store outage leaves liveness available and readiness unavailable; the proxy stops selecting unhealthy backends.

Before a real schema upgrade, create and independently verify the complete encrypted recovery bundle, including private machine state and key inventory. Preserve the previous immutable application image. If an upgrade fails, keep services unavailable while investigating; do not edit schema-version rows to convince an old binary to start. Restore the verified complete boundary into a separately prepared target, verify replay/isolation/consumer continuation there, and switch the target deliberately. The generated-role regression checks incompatible migration rollback; the recovery drill proves restoring a complete declared boundary. Neither substitutes for a rehearsed rollback against a future unknown schema change.
