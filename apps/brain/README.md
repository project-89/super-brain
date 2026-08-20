# Super Brain Client

Work-focused browser client for the authenticated Fold API. It provides:

- workspace activity and projection totals;
- private personal-memory record, filter, revision, and forget workflows;
- canonical and draft event inspection;
- materialized node, edge, component-value, and diagnostic inspection.

The client imports no Raven code. Raven's committed shell, compact filtering,
list/detail, and memory metadata interactions were used only as product evidence.

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
