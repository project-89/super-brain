# Super Brain Operations

The private pilot deployment, explicit schema/bootstrap steps, nonowner runtime roles,
TLS proxy, bounded readiness and alert probe are documented in [the deployment runbook](../deploy/README.md).

## Credential Profiles

Static credentials can be restricted independently from workspace roles with a
`capabilities` array. Omitting the array preserves full access for existing
operator credentials. Production and remote credentials should always include
the narrowest set they need.

```json
{
  "capture-secret": {
    "principalId": "local-sensor",
    "author": { "kind": "sensor", "id": "urn:sensor:super-brain-capture:host-a" },
    "capabilities": [
      "events:write",
      "trajectories:read",
      "trajectories:write",
      "transcripts:write"
    ],
    "organizations": { "local": { "role": "admin", "workspaces": { "local-history": { "role": "admin" } } } }
  },
  "memory-worker-secret": {
    "principalId": "memory-worker",
    "author": { "kind": "agent", "id": "super-brain-memory-worker" },
    "capabilities": [
      "events:read",
      "consumers:read",
      "consumers:write",
      "transcripts:read",
      "memories:read",
      "memories:write",
      "reasoning:read"
    ],
    "organizations": { "local": { "role": "admin", "workspaces": { "local-history": { "role": "admin" } } } }
  },
  "harness-secret": {
    "principalId": "agent-user",
    "author": { "kind": "agent", "id": "hermes" },
    "capabilities": ["memories:read", "memories:write", "reasoning:read"],
    "organizations": { "local": { "role": "member", "workspaces": { "local-history": { "role": "member" } } } }
  }
}
```

Credential rotation is a configuration replacement plus a process restart:
add the replacement token, move clients, remove the old token, then restart the
API. Tokens are hashed in process but the configuration remains secret material.

## Clerk Identity

Hosted authentication accepts Clerk sessions, organization API keys, and M2M
tokens while PostgreSQL remains authoritative for workspace membership and
tenant isolation. Configure either Clerk alone or Clerk alongside static
credentials during migration:

```sh
export CLERK_SECRET_KEY=sk_live_replace
export CLERK_PUBLISHABLE_KEY=pk_live_replace
export FOLD_CLERK_AUTHORIZED_PARTIES=https://brain.example.com
export CLERK_WEBHOOK_SIGNING_SECRET=whsec_replace
export FOLD_DATABASE_URL=postgres://...
```

Configure Clerk to deliver organization created, updated, deleted, and
organization membership created, updated, and deleted events to
`POST /v1/webhooks/clerk`. Deliveries are signature-verified, transactionally
applied, durably deduplicated, and audited. `FOLD_CLERK_BINDINGS_JSON` remains a
mutually exclusive explicit bootstrap input in deployed verify mode (legacy local migrate mode can still load it at startup); its format is defined in
`apps/api/README.md`. Clerk user IDs
use `user:<id>`, organization API keys use `api-key:<id>`, and M2M identities
use `machine:<id>`. A token is rejected unless both its external principal and
external organization are bound and the resulting internal principal has a
workspace membership.

Create sensor keys on the backend with only the required Clerk scopes, such as
`super-brain:events:write` and `super-brain:transcripts:write`, and include the
sensor author in the `super_brain.author` claim. Do not allow an unprovisioned
key ID to enter the bindings. M2M tokens require the external organization in
`super_brain.organizationId`. Removing a binding or provider membership and
revoking it through the organization administration route removes Super Brain
access immediately. Clerk API-key validity is
checked during verification; session role and membership changes follow
Clerk's short-lived session-token refresh behavior.

Provision a machine identity into the target workspace after creating it in
Clerk. The caller must be an organization owner/admin with
`organization:admin`:

```sh
curl -fsS -X POST \
  -H "Authorization: Bearer $FOLD_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"externalPrincipalId":"api-key:ak_capture","workspaceRole":"member"}' \
  "$FOLD_API_URL/v1/organizations/$FOLD_API_ORGANIZATION/workspaces/$FOLD_API_WORKSPACE/identity-bindings"

curl -fsS -X DELETE \
  -H "Authorization: Bearer $FOLD_API_TOKEN" \
  "$FOLD_API_URL/v1/organizations/$FOLD_API_ORGANIZATION/workspaces/$FOLD_API_WORKSPACE/identity-bindings/api-key%3Aak_capture"
```

Provisioning never infers access from email domains, repository URLs, or
client-provided organization IDs.

## Tenant Administration

Organization owners and admins can enroll a credential-free repository remote
in a workspace when their credential includes `organization:admin` or omits a
capability list. Enrollment is idempotent for the same target and cannot be silently reassigned:

```sh
curl -fsS -X POST \
  -H "Authorization: Bearer $FOLD_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"remote":"git@github.com:example/project.git","projectId":"project-id"}' \
  "$FOLD_API_URL/v1/organizations/$FOLD_API_ORGANIZATION/workspaces/$FOLD_API_WORKSPACE/repository-enrollments"
```

Platform support credentials receive no implicit content access. An exceptional
read requires `platform:data-read`, a ticket-quality reason, and an expiry no
more than 15 minutes away. The audit record is committed before the read and is
visible to the affected organization's owners and admins at `audit-log`.

For a shared deployment, use `FOLD_POSTGRES_SCHEMA_MODE=verify` and
`FOLD_REQUIRE_TENANT_RLS=true` with a nonowner runtime role. It must have no schema
creation, administrative-role membership, superuser or RLS-bypass privileges.
The separate migration identity owns DDL. Runtime startup verifies schema and
privileges without replacing static or Clerk memberships; revocation survives restart.

The organization-key migration changes primary keys and forces RLS. Stop old
API and worker processes before first rollout, run the explicit API `migrate`
command with the migration identity, then start verified runtime services and
upgraded workers. Run `bootstrap` only for a deliberate initial/replacement enrollment.
Old binaries are intentionally incompatible with
the enforced tenant schema.

After building, install the API and memory worker as persistent macOS services.
The generated plists are `0600` and retain the current required environment, so
run these commands from a shell containing the intended secrets:

```sh
pnpm --filter @_89/super-brain-api start -- install-service

export SUPER_BRAIN_URL=http://127.0.0.1:3003
export SUPER_BRAIN_ORGANIZATION=local
export SUPER_BRAIN_WORKSPACE=local-history
export SUPER_BRAIN_TOKEN=replace-memory-worker-token
export FOLD_TRANSCRIPT_VAULT="$HOME/.local/share/super-brain/vault"
export FOLD_TRANSCRIPT_VAULT_KEY_FILE="$HOME/.config/super-brain/vault.key"
pnpm --filter @_89/super-brain-memory-worker start -- install-service
```

Service logs are under `~/.local/state/super-brain/{api,memory-worker,capture}`.

## Encrypted Vault

New capture configurations generate a separate 32-byte key file and encrypt
redacted hook and transcript records with AES-256-GCM. Existing installations
can enable encrypted writes without rewriting historical artifacts:

```sh
pnpm --filter @_89/super-brain-capture-daemon build
pnpm --filter @_89/super-brain-capture-daemon start -- enable-vault-encryption
```

Restart the daemon afterward. Configure the memory worker with the same key:

```sh
export FOLD_TRANSCRIPT_VAULT_KEY_FILE="$HOME/.config/super-brain/vault.key"
```

Plain redacted historical artifacts remain readable. If an encrypted artifact
exists, a missing or incorrect key fails closed. The key is not stored inside
the vault and must be backed up separately.

## Export And Retention

Create an integrity-manifest export. The vault key is excluded unless explicitly
requested; exports that include it must be handled as secret backups.

Use a credential with `events:read` for the canonical event portion. This can be
different from the write-only capture credential:

```sh
SUPER_BRAIN_EXPORT_TOKEN=replace-export-token \
  pnpm --filter @_89/super-brain-capture-daemon start -- export \
  --output "$HOME/Backups/super-brain-$(date +%Y%m%d)"
pnpm --filter @_89/super-brain-capture-daemon start -- verify-export \
  --input "$HOME/Backups/super-brain-$(date +%Y%m%d)"
```

Raw hook retention is dry-run by default and never deletes canonical Fold
events or transcript artifacts:

```sh
pnpm --filter @_89/super-brain-capture-daemon start -- prune --before 2026-01-01
pnpm --filter @_89/super-brain-capture-daemon start -- prune --before 2026-01-01 --confirm
```

Permanent `4xx` deliveries are quarantined instead of retried forever. After
correcting the schema or authorization problem, inspect and explicitly requeue
them:

```sh
pnpm --filter @_89/super-brain-capture-daemon start -- retry-failed
pnpm --filter @_89/super-brain-capture-daemon start -- retry-failed --confirm
```

Late observations keep their original event time and arrive through the versioned
ingestion cursor. A later accepted observation alone does not require rebasing an
older delivery. Domain mutations still must be valid in canonical replay order;
inspect an actual domain conflict before using any explicit repair/rebase option.
Retry the original durable command identity for transient failures.

## PostgreSQL Backup

The database is the canonical source, so filesystem exports do not replace a
database backup. Install PostgreSQL client tools, then run:

```sh
export FOLD_DATABASE_URL='postgres://.../super_brain'
export SUPER_BRAIN_BACKUP_DIR="$HOME/Backups/super-brain-postgres"
./scripts/backup-postgres.sh
```

Regularly verify the newest backup against a disposable database. The verifier
uses `--clean --if-exists` and must never point at production:

```sh
export SUPER_BRAIN_BACKUP='/path/to/super-brain-YYYYMMDDTHHMMSSZ.dump'
export FOLD_RESTORE_DATABASE_URL='postgres://.../super_brain_restore_test'
./scripts/verify-postgres-restore.sh
```

Keep at least one encrypted off-host copy, apply a documented retention policy,
and alert on both backup age and restore-test failure.

## Hermes

Hermes supports stdio MCP servers directly. Add the built server to
`~/.hermes/config.yaml` and explicitly pass its secrets:

```yaml
mcp_servers:
  super_brain:
    command: "node"
    args: ["/absolute/path/to/super-brain/apps/mcp-server/dist/main.js"]
    env:
      SUPER_BRAIN_URL: "http://127.0.0.1:3003"
      SUPER_BRAIN_ORGANIZATION: "local"
      SUPER_BRAIN_WORKSPACE: "local-history"
      SUPER_BRAIN_TOKEN: "replace-harness-token"
      SUPER_BRAIN_CAPTURE_URL: "http://127.0.0.1:8377"
      SUPER_BRAIN_CAPTURE_HOOK_TOKEN: "replace-local-hook-token"
      SUPER_BRAIN_HARNESS: "hermes"
```

For Hermes gateway sessions, install the lifecycle hook and restart the gateway:

```sh
pnpm --filter @_89/super-brain-capture-daemon start -- install-hermes-hook
```

The gateway currently exposes tool names but not results, so those steps are
captured as observations and their outcome remains unknown unless a verified
result or explicit human verdict is supplied.
