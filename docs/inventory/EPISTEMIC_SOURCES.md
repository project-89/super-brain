# Epistemic Source Inventory

Audited on 2026-08-16. The Raven worktree was read-only. Its current HEAD and
the manifest-pinned commit were both
`817d7541868cc7947b004b4f59c48da8145f2419`. The worktree contained two
untracked files, `REPORT_RAVEN.md` and `docker-compose.override.yml`; neither was
read or used as evidence.

## Raven Baseline

- Repository: `/Users/jakobgrant/Workspaces/raven-docs`
- Origin: `git@github.com:HaruHunab1320/raven-docs.git`
- Commit subject: `test(server): replace the last 12 scaffolds with real domain coverage`
- License: GNU Affero General Public License v3.0 (`LICENSE` at the pinned
  commit)

Raven's implementation is not license-compatible source for this private
package. All local production code is an independent implementation of the
observed behavior and documented product contract.

## Contract Map

| Pinned source | Inspected contract | Local destination |
| --- | --- | --- |
| `apps/server/src/database/migrations/20251224T102200-agent-memories.ts` | UUIDv7 identity; required workspace and creator ownership; optional space; source, summary, JSON content/tags, timestamps | `src/types.ts`, `src/events.ts`, `src/uuidv7.ts` |
| `apps/server/src/database/migrations/20260210T120001-memory-embeddings.ts` | Embeddings are a separate derived search index | Candidate-only contract in `src/recall.ts`; vector I/O excluded |
| `apps/server/src/database/migrations/20240324T085400-uuid_v7_fn.ts` | Time-ordered UUIDv7 identifiers | Independently written UUIDv7 validation and ordering; SQL not copied |
| `apps/server/src/core/agent-memory/dto/memory.dto.ts` | Workspace/space scope, bounded source and summary, recall filters and limits | Event validation and recall request bounds |
| `apps/server/src/core/agent-memory/agent-memory.service.ts` | Ingest, revise, delete, metadata recall, semantic recall, and daily/entity views | Canonical lifecycle, replay, filters, external candidates |
| `apps/server/src/integrations/vector/vector-search.service.ts` | Workspace/space-scoped vector candidate ranking | Host-supplied `{memoryId, score}` candidates |
| `apps/server/src/core/agent-memory/agent-memory.controller.ts` | Authenticated workspace and creator are injected at the HTTP boundary | Mandatory local access context and capture identity |
| `apps/server/src/integrations/mcp/handlers/memory.handler.ts` | MCP injects authenticated workspace and creator | Transport excluded; same local access contract |
| `apps/server/src/core/casl/abilities/space-ability.factory.ts` | Space membership roles and absent-membership denial | `canAccessSpace` and write/recall denial |
| `apps/server/src/core/search/search.service.ts` and tests | Resolve accessible space IDs and return no results when the set is empty | Fail-closed space checks before and after ranking |
| `apps/docs/docs/guides/memory.md`, `apps/docs/docs/mcp/tools/memory.md` | Memories are described as personal and private | Creator checks cannot be overridden by workspace role |

Generated database types and the client memory service/types were checked as
cross-layer confirmation. No memory-specific server test existed at the pinned
commit, so local parity claims rely on the committed schema, service paths,
authorization patterns, and product documentation together.

## Security Findings

Raven's nonsemantic query branch applies workspace, optional space, and creator
filters. Its semantic branch first asks the vector service for workspace/space
candidates, then fetches the returned memory IDs without reapplying creator
ownership. The vector query itself has no creator filter. A caller can therefore
supply an authenticated creator and still receive another creator's ranked
record when the candidate set contains it.

The internal agent memory-context service also omits creator filters from its
queries, while the public guide describes memories as private. Memory HTTP and
MCP paths verify workspace membership but do not perform the page controller's
explicit space-ability check. These inconsistencies are evidence of boundaries
to strengthen, not behavior to preserve.

`@_89/fold-epistemic` consequently applies access before every filter and again
to every externally ranked candidate. Creator ownership is mandatory, workspace
admins receive no override, inaccessible requested spaces return an empty set,
and a removed space membership immediately excludes previously recorded scoped
memory. Writes require the same workspace, creator, and space decision.

## Parity Evidence

Local tests pin these load-bearing cases:

- canonical lowercase UUIDv7 validation, timestamp extraction, and ordering;
- required workspace and creator identity plus optional exact space scope;
- canonical record, revision, and forget evidence with authored provenance;
- normalized tags, bounded source/summary/entity data, and durable tombstones;
- deterministic replay and rejection of duplicates, spoofed owners, stale
  mutations, and mutation after forgetting;
- creator privacy even for workspace owners and administrators;
- access revocation, workspace-only and exact-space recall, all-tag/source/time
  filtering, bounds, and deterministic ordering;
- semantic candidate reauthorization, including an unauthorized higher-scored
  creator result and duplicate candidate IDs.

Excluded: NestJS controllers and services, MikroORM, PostgreSQL/pgvector,
embedding generation, graph and entity inference, periodic consolidation,
client state, Raven Docs UI, MCP transport, and all untracked worktree files.
