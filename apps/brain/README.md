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
- replay-built fleet status, freshness, lifecycle, recovery-plan, canonical
  activity, and operator-authenticated raw hook evidence inspection;
- provider-labeled pull reasoning over authorized memory and optional actor
  context;
- replayed human steering with actor discovery, candidate surfacing,
  commit/decline decisions, action recording, and explicit intention endings;
- canonical and draft event inspection;
- cursor-paged materialized node, edge, component-value, redirect, and
  diagnostic inspection with whole-section search.

Trajectory imports are JSON bundles with a `tree`, optional `spaceId`, and a
non-empty `trajectories` array. Every run must reference the tree's `taskId` and
must include explicit `mapped`, `ambiguous`, or `unmapped` assignments for its
steps. The API owns final schema and scope validation.

The client imports no Raven code. Raven's committed shell, compact filtering,
list/detail, and memory metadata interactions were used only as product evidence.
Ranked results show the server-reported provider kind, identifier, scanned
corpus size, and normalized score so lexical and semantic retrieval remain
operationally distinguishable.
The reasoning selector lists native Gemini, Claude, and Codex providers with
their exact model identifiers and visibly disables providers without a
server-side key. Gemini is selected when configured. The local provider remains
visibly labeled `extractive`; the client does
not present it as a model answer. Steering controls follow the server-reported
owner/admin capability and remain read-only for other workspace roles.

## Development

Run the API on port `3000`, then start the client:

```bash
VITE_FOLD_WORKSPACE=local VITE_FOLD_TOKEN=local-dev-token \
VITE_CAPTURE_OPERATOR_TOKEN=local-capture-operator-token \
  pnpm --filter @_89/super-brain dev
```

Vite serves `http://127.0.0.1:4173` and proxies `/api` to
`http://127.0.0.1:3000`; `/capture` proxies to `http://127.0.0.1:8377`. Override
the proxies with `FOLD_API_PROXY_TARGET` and `SUPER_BRAIN_CAPTURE_PROXY_TARGET`, or use
`VITE_FOLD_API_BASE_URL` for a browser-accessible API origin.

Workspace and base URL preferences use local storage. The bearer token uses
session storage and is cleared when the browser tab session ends. The capture
operator token follows the same session-only rule.

For hosted use, configure `VITE_CLERK_PUBLISHABLE_KEY` and
`VITE_FOLD_API_BASE_URL`. Brain then renders Clerk sign-in, requires an active
organization, discovers that principal's current workspaces from
`GET /v1/session`, and keeps the short-lived bearer token only in React state.
Organization switching refreshes the server-derived workspace list. Without a
Clerk publishable key, the local connection dialog remains the bootstrap path.
