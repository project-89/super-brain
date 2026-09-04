# Super Brain Operations

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
      "memories:write"
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

For a shared deployment, set `FOLD_REQUIRE_TENANT_RLS=true` and use a dedicated
PostgreSQL application role without `SUPERUSER` or `BYPASSRLS`. Do not enable
that guard with a local development superuser.

The organization-key migration changes primary keys and forces RLS. Stop old
API and worker processes before first rollout, migrate by starting the new API,
then start the new workers. Old binaries are intentionally incompatible with
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

If the API accepted later events before an older quarantined event, canonical
ordering will correctly reject the original timestamp. Review that job, then
reissue it at a fresh timestamp while retaining its source ID:

```sh
pnpm --filter @_89/super-brain-capture-daemon start -- retry-failed \
  --rebase-events --confirm
```

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
