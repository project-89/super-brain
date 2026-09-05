# Super Brain Client

Work-focused browser client for the authenticated Fold API. It provides:

- workspace activity and projection totals;
- personal and workspace memory record, project-aware filter,
  provider-ranked full-corpus recall, revision, and forget workflows;
- pending memory proposal review with evidence, extractor identity,
  clearly labeled extractor estimates and explicit accept/reject decisions;
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
corpus size, and relevance score so lexical and semantic retrieval remain
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
`GET /v1/session`, and obtains a fresh short-lived bearer token for each request through Clerk. No previous token is reused when token acquisition fails.
Organization switching refreshes the server-derived workspace list. Without a
Clerk publishable key, the local connection dialog remains the bootstrap path.


## Evidence and review

Brain delegates all canonical requests, session discovery, errors, paging, deadlines and cancellation to `@_89/super-brain-client`. The local adapter only handles connection preferences, stable user command retries and local private capture reads. Empty initial credentials can open the connection dialog; they never fall back to another token.

The memory inventory explicitly includes unresolved and needs-review memories. Ranked/context recall remains current-only by default. The inventory shows applicability and review reasons rather than treating an empty project list as global. Corrections include the displayed `expectedRevision`; a conflict preserves the draft and offers the latest revision for comparison before an explicit retarget. Controls use the authenticated identity's capabilities and workspace/space roles; server authorization remains authoritative.

Evidence and contributor records have separate, bounded pages for an exact memory revision. Accepted proposals retain their acceptance-time evidence snapshot. Source inspection confirms the canonical event exists under current access; it does not claim private bytes or local human authority were verified. Task views show manifest versions, original/final fingerprints, declared reconstruction availability, context references, native/reported runtime observations, intervention and later outcome records. Structural mappings and legacy evaluation estimates are labeled explicitly; unknown usage is never converted to a total or price.

Feedback joins the actual displayed read's organization, workspace, principal, recall ID, rank and exact memory revision, including revision zero. Explicit judgments use the batch endpoint's `expectedSubject` guard. An uncertain retry preserves the original payload and stamps even if another recall completes in the meantime. Judgments do not certify memory accuracy or advance claim revisions.

## Optional browser delivery

`BrowserTelemetryOutbox` stores identifier-only signals in IndexedDB with strict transaction acknowledgement. It never stores credentials or query text. Each durable batch is partitioned by organization/workspace/principal and retains stable batch/item stamps. Account changes defer the previous partition; the API rechecks the real token subject on dispatch. Optional enqueue/drain failure cannot fail an otherwise successful read.

Bounds are 1,000 batches, 8 MiB total serialized payload, 128 KiB per batch and 100 signals per batch. A transaction claims work across tabs for 60 seconds; canonical delivery has a 20-second deadline. Retryable errors use bounded backoff and at most eight attempts; authorization denials and exhausted work remain visible. Token unavailability, cancellation and subject change preserve the batch without consuming attempts. Overview offers explicit retry and discard for the current account's terminal rows. A dropped-enqueue diagnostic is retained until explicitly acknowledged by repair; successful status reads do not erase it. Browser termination before asynchronous enqueue acknowledges its transaction is not a durable write.

The local worker status bridge requires a separately supplied operator token. Capture URLs are restricted to `/capture` or a loopback service distinct from the canonical API; redirects carrying operator credentials are forbidden. Configure the capture service's `processingStatusFile` or `SUPER_BRAIN_WORKER_STATUS_FILE` to the worker's sanitized owner-only publication. The report is unavailable if missing, malformed, wrong-tenant, stopped, or older than 60 seconds. Activity charts label their loaded-page coverage and never claim full-corpus processing totals.

## Disposable browser verification

After building the API, shared client and capture packages, run from the repository root:

```bash
node apps/brain/scripts/disposable-fixture.mjs
```

The script prints a random loopback browser URL and fake owner/reader/operator credentials. It creates only an in-memory canonical API, a temporary Git repository/encrypted capture vault, and an explicitly synthetic processing report. It exercises real capture finalization, private repository references, canonical memory corrections/support, exact-revision evidence pagination and human-authorized task outcome commands. Vite uses an empty temporary environment directory with every connection value explicitly overridden; checkout `.env.local`, live services, live config and private corpora are never read. Stop the fixture to close its services and remove its temporary state. Each restart creates fresh data and a new browser URL.

Browser checks cover reader-disabled edits/import, two-tab revision conflicts with preserved draft, exact-revision helpful judgment, evidence/contributor pagination, task manifests and delayed outcomes, unknown/reference-only labels, local processing freshness, and optional delivery state. Source and HTTP regressions additionally exercise account changes, lost acknowledgements, body-read cancellation, storage failures and outbox repair.
