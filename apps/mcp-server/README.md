# Super Brain MCP server

The stdio MCP server gives any compatible harness the same authenticated memory
search, cited context, candidate proposal, trajectory checkpoint, and memory
feedback tools.

```sh
export SUPER_BRAIN_URL=http://127.0.0.1:3003
export SUPER_BRAIN_ORGANIZATION=local
export SUPER_BRAIN_WORKSPACE=local-history
export SUPER_BRAIN_TOKEN=replace-harness-token
export SUPER_BRAIN_CAPTURE_URL=http://127.0.0.1:3210
export SUPER_BRAIN_CAPTURE_HOOK_TOKEN=replace-local-hook-token
export SUPER_BRAIN_HARNESS=hermes
export SUPER_BRAIN_SESSION_ID=hermes-session-id

pnpm --filter @_89/super-brain-mcp-server build
pnpm --filter @_89/super-brain-mcp-server start
```

The API token and loopback hook token remain environment variables and are not
accepted as command-line arguments. Recall remains subject to current workspace,
space, creator, and project authorization. Checkpoints contain concise summaries,
not hidden provider chain-of-thought.

The server requires Node.js 24 or newer. Its build preserves the `node:sqlite`
builtin; the process regression loads the built server, so build before testing.
`createSuperBrainMcpServer` exports the same registration used by the stdio entry
point for embedded harnesses and integration tests.

`super_brain_context` returns current authorized memory IDs and exact revisions,
recall identity and subject, applicability, and a bounded content preview. It
separates omitted items from returned items and never marks delivery as use.
Memory packets stay within 32 KiB after JSON escaping; optional task metadata uses
a separate 24 KiB budget and two records per page. Task records preserve their
canonical task, attempt, revision and source joins, with a cursor for the next
page. `super_brain_memory_evidence` pages complete evidence and contributor
records at the requested revision, including accepted candidate support. The
context's direct evidence count only describes the memory's direct references.

`super_brain_adopt` explicitly reports injected or used revisions, and
`super_brain_feedback` reports helpful, unhelpful or superseded judgments. Copy
the recall ID, subject, ranking/provider identity and exact references from the
read response. Only configure `SUPER_BRAIN_CANONICAL_TASK_ID` when it identifies
an existing canonical task; a harness session identifier alone does not prove a
task/attempt join. Corrections require the observed revision and refuse stale
drafts. Mutation tools require a stable stamp: reuse the entire command after an
uncertain response. A stamp is `{id,t,worldDate}`, where `t` is milliseconds and
`worldDate` follows the canonical date or minute shape (`YYYY-MM-DDTHH:mm`).

Proposals remain model-attributed claims with caller-estimated confidence and
salience. Reasoning checkpoints and ordinary completion reports are agent
reports. They cannot submit human decisions or approvals. Explicit canonical
outcome linking requires a real source event and the corresponding integration
permission. Optional capture failure leaves successful recall and reasoning
intact; explicit capture/reporting tools return their own success or failure.
Caller cancellation reaches canonical requests and private capture requests.

Optional offered-feedback batches are encrypted in a durable SQLite outbox at
`~/.local/state/super-brain/mcp-telemetry`; configure a different location with
`SUPER_BRAIN_TELEMETRY_STATE_ROOT`. Keep its owner-only key and database together.
The outbox persists only exact references and bounded provenance metadata, never
queries, content, free-text details or tokens. The default bounds are 1,000
batches, 8 MiB total encrypted payload and 128 KiB per input batch. Shared SQLite
claims allow multiple harness processes; restart retries preserve event IDs.
Delivery rechecks the actual authenticated organization, workspace and principal
at dispatch. An account change defers the original partition without relabeling
it or consuming retry attempts.

Read-only credentials can recall memory even when feedback is forbidden or local
storage/network is unavailable. `super_brain_telemetry` exposes pending, retry,
denied, exhausted and unavailable delivery; `retry` or `discard-terminal`
explicitly repairs the current account's failed batches. Transient delivery
retries stop after five attempts by default; authorization denial stops that
batch immediately. SIGINT, SIGTERM and transport close cancel outstanding
requests, settle durable work and close the database.

## Task context and deliberate discovery

`super_brain_search`, `super_brain_context` and `super_brain_ask` no longer default to workspace-wide
recall. Supply a nonempty `projectIds` array on each call, or configure known IDs:

```sh
export SUPER_BRAIN_PROJECT_IDS='["project-reviewed-id"]'
```

Use `super_brain_projects` to discover authorized project names, original IDs, and
current canonical IDs. It returns one page (default 50, maximum 100) and an optional
`nextCursor`; pass that value as `cursor` for the next page. Discovery never selects
a project automatically or performs a recall/model request.

The value must be a JSON array of 1 to 20 IDs, not repository names or paths.
`SUPER_BRAIN_PROJECT_ROOT` only supplies capture metadata; it does not select
recall scope. Explicit IDs override configured defaults. The server checks all
selected IDs against the current authorized, cursor-paginated project catalog
before every recall/context call. The harness credential needs `transcripts:read`
for this catalog in addition to its recall/reasoning capabilities. Denied catalog
access does not fall back to broader discovery. An absent, inaccessible, or unknown ID
fails without invoking retrieval or a model. Catalog membership verifies the ID
is available; it is not independent proof of a person's work or ownership.
Project aliases remain resolved by the API without rewriting source IDs.

For an intentional organization/workspace question or cross-project exploration,
set `broaderDiscovery: true` and omit `projectIds`. This explicitly overrides
configured defaults but never bypasses organization, workspace, space, or personal
permissions. Supplying both modes is rejected, as is an empty project array.
No default ID is inferred from a folder basename, agent name, account, or prompt.
Project-scoped retrieval still includes explicitly general knowledge within
authorized access and excludes unresolved applicability.

Tool results include `retrievalScope` identifying project versus broader discovery
and explicit versus configured selection. Project catalog errors, repeated cursors,
and verification exceeding 1,000 pages fail explicitly; they never fall back to
broader discovery. Existing clients that omitted project context must configure
the default or choose their scope explicitly.
