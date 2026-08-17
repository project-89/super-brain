# Provenance

`@_89/fold-epistemic` is a clean-room Super Brain implementation. Production
code has no runtime, build, or filesystem dependency on the Raven workspace.

## Raven

- Repository: `git@github.com:HaruHunab1320/raven-docs.git`
- Pinned commit: `817d7541868cc7947b004b4f59c48da8145f2419`
- License at the pinned commit: GNU Affero General Public License v3.0
- Pinned worktree status when inventoried: two untracked files
- Explicitly excluded: `REPORT_RAVEN.md`, `docker-compose.override.yml`
- Inspected committed areas:
  - memory and UUIDv7 migrations and generated database types;
  - memory DTO, service, controller, vector search, and MCP handler;
  - agent memory-context service;
  - workspace and space ability factories;
  - search-service membership filtering and its tests;
  - memory user and MCP documentation;
  - client memory types and service.

No Raven file was copied. Raven's AGPL implementation was used only to identify
observable schema, write-path, recall, and authorization behavior. The
MIT-attributed UUIDv7 SQL embedded in one Raven migration was also not copied;
the local package uses an independently written validator and comparator.

The local package intentionally closes two gaps found at the pinned commit:
semantic candidate IDs are always filtered again by workspace, creator, and
current space access, and a space-scoped memory cannot be written or recalled
without explicit membership. Raven UI, NestJS services, database queries,
pgvector integration, embeddings, graph/entity extraction, background jobs,
and MCP transport remain excluded.
