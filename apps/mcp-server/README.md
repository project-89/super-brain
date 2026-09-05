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
