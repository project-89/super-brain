# Super Brain Client

Work-focused browser client for the authenticated Fold API. It provides:

- workspace activity and projection totals;
- personal and workspace memory record, project-aware filter,
  provider-ranked full-corpus recall, revision, and forget workflows;
- pending memory proposal review with evidence, extractor identity,
  confidence, salience, and explicit accept/reject decisions;
- shared trajectory task import, coverage, route, divergence, review, and
  per-step projection inspection;
- imported project and source-qualified run history with context, turn, action,
  artifact, and privacy metadata;
- replay-built fleet status, freshness, lifecycle, recovery-plan, and canonical
  activity inspection;
- provider-labeled pull reasoning over authorized memory and optional actor
  context;
- replayed human steering with actor discovery, candidate surfacing,
  commit/decline decisions, action recording, and explicit intention endings;
- canonical and draft event inspection;
- materialized node, edge, component-value, and diagnostic inspection.

Trajectory imports are JSON bundles with a `tree`, optional `spaceId`, and a
non-empty `trajectories` array. Every run must reference the tree's `taskId` and
must include explicit `mapped`, `ambiguous`, or `unmapped` assignments for its
steps. The API owns final schema and scope validation.

The client imports no Raven code. Raven's committed shell, compact filtering,
list/detail, and memory metadata interactions were used only as product evidence.
Ranked results show the server-reported provider kind, identifier, scanned
corpus size, and normalized score so lexical and semantic retrieval remain
operationally distinguishable.
The local reasoning provider is visibly labeled `extractive`; the client does
not present it as a model answer. Steering controls follow the server-reported
owner/admin capability and remain read-only for other workspace roles.

## Development

Run the API on port `3000`, then start the client:

```bash
VITE_FOLD_WORKSPACE=local VITE_FOLD_TOKEN=local-dev-token \
  pnpm --filter @_89/super-brain dev
```

Vite serves `http://127.0.0.1:4173` and proxies `/api` to
`http://127.0.0.1:3000`. Override the proxy with `FOLD_API_PROXY_TARGET` or use
`VITE_FOLD_API_BASE_URL` for a browser-accessible API origin.

Workspace and base URL preferences use local storage. The bearer token uses
session storage and is cleared when the browser tab session ends.
