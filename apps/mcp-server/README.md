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

## Task context and deliberate discovery

`super_brain_search` and `super_brain_context` no longer default to workspace-wide
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
