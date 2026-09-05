# Product and feedback validation

Status: verified. Full `pnpm verify` passed under Node **24.20.0** with the disposable restricted PostgreSQL role: **637 tests across 104 files and 21 packages**, no skips, all typechecks and both builds passed. Log: `/tmp/super-brain-phase4-verify-node24.log`.

All tests use the remediation worktree. Browser verification uses `apps/brain/scripts/disposable-fixture.mjs`: an in-memory canonical API, temporary encrypted capture files, a synthetic worker status publication and a Vite configuration isolated from the original checkout's local environment. Its owner, reader and operator credentials are synthetic. No live corpus or installed services are involved.

## Browser observations

- The memory inspection page includes unresolved applicability, stale derived evidence and opposing evidence. Ordinary current-memory recall remains separate from this inspection view.
- Exact revision 1 evidence paginates from 25 to all 28 references, including later support and opposition. Revision 0 retains its 26 original references and no later contribution records.
- Source inspection resolves a canonical event while explicitly leaving private byte and human-authority verification unavailable in that view.
- A correction submitted through the actual dialog advanced revision 1 to revision 2 and retained the evidence history. In the final two-tab check, the first tab's revision 0 draft conflicted after the second tab saved revision 1. The dialog retained the entire draft, displayed the newer content, and required explicitly targeting revision 1 before saving revision 2. No stale overwrite occurred.
- A reader can inspect memory and evidence. Helpful/unhelpful, revise, forget and trajectory import controls are disabled when their capabilities are absent. The final check repeated account switching after development reloads stopped.
- Task details display the task and attempt versions, goal, starting/final fingerprints, private reconstruction dependencies, acceptance reference and hook-reported runtime metadata. Structural mappings and unavailable independent evaluation remain labeled.
- The first browser pass exposed a default-fetch receiver error in background telemetry. The canonical client now preserves the browser receiver and has a focused regression. The final browser pass observed queued offered signals draining to zero without an error. Explicit helpful feedback appeared against revision 2 while the memory correctly remained in needs-review status.
- The task timeline displayed the authenticated human constraint and later human-reported CI result, each bound to the attempt and revision. Runtime inspection displayed the fixture's reported provider/model and token counts while leaving unknown configuration, cost and usage interpretation unknown.

## Review regressions to retain

Review identified cross-process outbox claims, actual generated-stamp parsing, terminal repair, shutdown cancellation, default browser fetch binding, generated-ID collisions across client instances, revision pagination races and actual-read subject binding for explicit feedback. Each requires source-level regression coverage where applicable. Both outbox adapters retain identifiers rather than query text or credentials, and server batch delivery checks the actual request subject again.

A two-process PostgreSQL test also reproduced a schema-initialization versus static-membership-seeding deadlock. Runtime transactions now acquire a shared schema gate before table/tenant locks, while initialization acquires it exclusively. A deterministic lock-order regression and the actual two-process API tests passed; the fix does not depend on a lucky rerun.

Independent review also reproduced a stale search result when a memory was revised or forgotten while the asynchronous ranker ran. Both the SDK and API now recheck current revision/access before returning the result. Feedback inventory pages carry actual-request subject provenance, and explicit UI judgments submit that subject with their immutable retry payload. Late source/evidence responses are guarded against revision, task and account changes.

The gate includes 16 PostgreSQL tests, 83 API tests with eight real two-process regressions, 61 SDK tests, 22 shared-client tests, 64 capture tests, 50 worker tests, 18 MCP tests and 47 Brain tests. Independent source and code-quality reviews are complete, with all actionable findings resolved. The only build note is the Brain main chunk size warning at 500.46 KB (135.92 KB gzip); the build succeeds. The original checkout remains at `eda5604`, with no tracked-file changes or live-service rebuilds.
