# Multi-Tenancy Boundary

This document defines the production isolation target. It is a design contract,
not a claim that the current local deployment is multi-tenant.

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

The current workspace-scoped authorization is the application-level precursor
to this boundary. Production tenancy additionally requires a durable identity
directory, organization/workspace membership tables, PostgreSQL row-level
security, and organization scoping outside the event table.

## Repository Enrollment

A repository is associated with an organization in this priority order:

1. An organization administrator explicitly enrolls the repository or project.
2. An approved remote namespace rule assigns repositories from a verified Git
   host organization to a target organization and workspace.
3. The capture client suggests a match from its normalized remote, but an
   authorized user confirms it.
4. Unmatched repositories enter a private, unassigned quarantine workspace.

Remote URLs, local paths, folder names, and Git author emails are discovery
hints. They never grant access or move data across an organization boundary.
Changing a project assignment is an audited migration, not an in-place label
change.

## Enforcement

- API routes resolve `organizationId` and `workspaceId` from current membership
  before constructing an SDK or storage handle.
- PostgreSQL policies require both IDs for all tenant tables. The application
  sets transaction-local identity claims and does not use a database role that
  bypasses row-level security for normal requests or workers.
- Background workers, SSE streams, durable consumers, caches, vector searches,
  exports, backups, and artifact-store paths carry the same tenant key.
- Organization data-encryption keys are independent and versioned. Key
  rotation and deletion cannot affect another organization.
- Cross-organization joins and global semantic searches are unavailable to
  ordinary users, organization administrators, sensors, and agent harnesses.

Isolation tests must attempt hostile workspace IDs, stale memberships, cursor
reuse, cache-key collisions, cross-tenant vector retrieval, artifact traversal,
and worker checkpoint reuse.

## Administration

An organization administrator can manage membership and inspect data only in
that organization. Platform operations and platform data access are separate
capabilities. A support administrator does not receive content access by
default.

Exceptional platform content access requires an explicit `platform:data-read`
grant, a reason, a short expiry, and an append-only audit event visible to the
affected organization. Database superuser access remains an infrastructure
break-glass procedure outside the product path.

## Delivery Sequence

1. Add organization, workspace, membership, repository-enrollment, and audit
   tables plus a production identity-provider adapter.
2. Put `organization_id` on all PostgreSQL tenant tables and backfill existing
   workspaces into one local organization.
3. Enable and test row-level security before exposing organization routes.
4. Scope workers, SSE, vectors, caches, artifact storage, exports, and keys.
5. Add organization administration and explicit platform break-glass views.
6. Run adversarial isolation and backup/restore tests before a public launch.

Until these steps are complete, Super Brain is appropriate for a trusted local
operator or a separately deployed single organization, not a shared hosted
service.
