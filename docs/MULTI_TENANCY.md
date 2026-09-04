# Multi-Tenancy Boundary

This document defines the implemented organization isolation boundary and the
remaining infrastructure requirements for a shared production deployment.

## Resource Hierarchy

```text
platform
  organization (security, ownership, billing, and key boundary)
    workspace (independent Fold event log and derived projections)
      space (optional collaboration/access scope)
        project (repository or other work context)
```

Every workspace belongs to exactly one organization. Every event, consumer
offset, projection checkpoint, embedding row, artifact object, encryption key,
cache entry, and stream cursor must be reachable through an organization-owned
workspace. An organization identifier must be resolved from authenticated
membership on the server; clients must not be trusted to assert it.

The API authenticates a credential and resolves current organization/workspace
membership before opening any SDK or storage handle. PostgreSQL persists the
organization and workspace catalogs and current membership projection. The
static credential adapter remains the local bootstrap identity provider; a
hosted deployment should replace its authentication half with the selected
external identity provider while retaining the same membership interface.

## Repository Enrollment

A repository is associated with an organization in this priority order:

1. An organization administrator explicitly enrolls the repository or project.
2. Future verified namespace rules may suggest a target, but cannot enroll it.
3. A capture client may suggest its credential-free normalized remote, but an
   authorized user must confirm it.
4. Until automated quarantine routing is configured, unmatched repositories
   must use a separately provisioned private workspace.

Remote URLs, local paths, folder names, and Git author emails are discovery
hints. They never grant access or move data across an organization boundary.
Changing a project assignment is an audited migration, not an in-place label
change.

## Enforcement

- API routes resolve `organizationId` and `workspaceId` from current membership
  before constructing an SDK or storage handle.
- PostgreSQL policies require an organization claim on all tenant tables. Every
  query also predicates organization and workspace. The application sets
  transaction-local identity claims; `FOLD_REQUIRE_TENANT_RLS=true` rejects
  superuser and `BYPASSRLS` roles at startup.
- Background workers, SSE streams, durable consumers, caches, vector searches,
  imports, migrations, and exports carry the same tenant key.
- Local capture artifacts and encryption keys belong to one configured tenant.
  A hosted object store and KMS must prefix artifacts and version keys by the
  same organization/workspace pair before remote artifact serving is added.
- Cross-organization joins and global semantic searches are unavailable to
  ordinary users, organization administrators, sensors, and agent harnesses.

Isolation tests must attempt hostile workspace IDs, stale memberships, cursor
reuse, cache-key collisions, cross-tenant vector retrieval, artifact traversal,
and worker checkpoint reuse.

## Administration

An organization administrator can manage repository enrollment and inspect
data only in that organization. Static membership changes are deployed through
credential configuration; a hosted identity provider should own its membership
workflow through the same resolver contract. Platform operations and platform
data access are separate capabilities. A support administrator does not receive
content access by default.

Exceptional platform content access requires an explicit `platform:data-read`
grant, a reason, a short expiry, and an append-only audit event visible to the
affected organization. Database superuser access remains an infrastructure
break-glass procedure outside the product path.

## Implemented

1. Organization-qualified API routes and ambiguity-safe legacy local routes.
2. Organization-aware credentials plus durable PostgreSQL membership lookup.
3. `organization_id` backfill and composite keys for events, offsets,
   checkpoints, embeddings, SDK caches, and journal filenames.
4. Forced RLS with transaction-local claims and a production role guard.
5. Organization-admin repository enrollment and audit-log endpoints.
6. Read-only, reason-bearing, expiring, append-only-audited platform access.
7. Tenant propagation through capture, importer, memory worker, MCP, Brain,
   migration, export, SSE, and durable consumers.
8. Adversarial application and PostgreSQL isolation tests.

## Production Gate

Before public hosting, provision a non-bypass PostgreSQL application role and
enable `FOLD_REQUIRE_TENANT_RLS=true`; connect the authentication port to a
durable external identity provider with token rotation and revocation; prefix
any future remote artifact store and KMS keys by tenant; configure a private
quarantine workspace; and exercise backup/restore plus hostile isolation tests
in the production topology. None of those deployment integrations are
represented as simulated product behavior.
