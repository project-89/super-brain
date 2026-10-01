# Implementation planning handoffs

These are proposed next tasks, not work executed by this review. Use the repository baseline and findings in `05-assessment.md`; verify current source before planning. Prompts are ordered by dependency rather than package count.

## 1. Trustworthy receipt and evidence normalization

```text
/make-plan Harden Super Brain evidence receipt and interpretation. Use PATHFINDER-2026-09-04/01-flowcharts/evidence.md and 03-unified-proposal.md as evidence, checking current source first.

Create one pure normalizeHookEvidence entry point shared by live capture and recovery, and one shared native-transcript turn/identity normalizer for importer metadata and memory-worker text extraction. Rewrite the duplicate call sites in apps/capture-daemon/src/capture.ts:71–135,297–305,640–647,742–845,945–977,1140–1160; apps/capture-daemon/src/recovery.ts:17–57,149–217; apps/importer/src/adapters.ts:98–120,157–171; apps/importer/src/builder.ts:155–181,214–229; apps/memory-worker/src/vault.ts:54–113.

Make tool results success/failure/unknown based on explicit evidence. Keep individual checks separate from task acceptance; preserve failed checks after later unrelated success. Gate human-verdict authority independently from agent hook access (server.ts:205–221; MCP main.ts:90–116). Preserve checkpoint promotion only with sufficiently attributable task/revision-bound acceptance evidence. Treat timeout-finalized sessions as unknown unless process liveness is independently established.

Close the relay's pre-receipt durability gap at apps/capture-daemon/src/main.ts:48–80 with stable receipt IDs, quick durable acceptance and recoverable failed payloads. Keep secret redaction/encryption before durable storage. Test daemon downtime, slow Git, burst queueing, lost acknowledgement, hook retry, live/recovery parity, missing result, failed-test-followed-by-lint, source-specific transcript failures and identical turn IDs across consumers.

Do not introduce a registry or generic event framework. Keep source adapters distinct, private text outside canonical records, unknown explicit, and no human provenance inferred solely from a caller's chosen label. Do not treat a timeout counter as a lost-event counter.
```

## 2. Atomic command commits, delivery cursors and revocation

```text
/make-plan Make the existing Fold platform correct under delayed delivery and multiple API writers. Use PATHFINDER-2026-09-04/01-flowcharts/platform.md and the five bounded reproductions, plus 02-duplication-report.md.

Introduce one internal FoldSdk entry-batch commit boundary with command idempotency and expected-state/revision checks. Consolidate appendInternal and appendSequenceInternal at packages/fold-sdk/src/client.ts:317–377 and shared candidate construction at :907–1078. Make storage return an exact committed revision/result; remove independent global revision reads attached to locally patched snapshots. Coordinate validation and event batch append through packages/fold-postgres/src/store.ts:291–330,424–441.

Separate ingestion delivery positions from canonical event-time replay/fork cursors. Migrate readEventPage, API SSE and principal-scoped consumer offsets (store.ts:333–370,491–513; apps/api/src/server.ts:971–1037,1554–1577; packages/super-brain-client/src/index.ts:571–599). Define old-cursor migration and duplicate replay handling. Reauthorize or terminate open streams on membership/token changes. Preserve access checks before and after ranking.

Fix concurrent first initialization in JournalSdkRegistry.sdkFor at apps/api/src/registry.ts:187–201 and explicitly document or strengthen its nontransactional multi-event fallback. Test two actual API processes against restricted PostgreSQL: simultaneous candidate acceptance, duplicate retry, forced snapshot interleaving, backdated event after cursor commit, space/organization/machine revocation during SSE and consumer restart. Also test simultaneous first journal reads.

Do not replace PostgreSQL/Fold, add a message broker, conflate ingestion sequence with canonical world time, or claim that an INSERT advisory lock protects domain validation. Preserve public single/batch APIs and make conflicts explicit.
```

## 3. Durable memory processing and collaborative corrections

```text
/make-plan Make memory formation complete, retryable and correct for shared knowledge. Use PATHFINDER-2026-09-04/01-flowcharts/memory.md, especially missing artifacts, ownership mismatch, forgotten-source cognition and competing dedup policies.

Use one scope-aware consolidateCandidateEvidence policy at the worker boundary. Replace irreversible summary suppression at apps/memory-worker/src/extractor.ts:156–166 and apps/memory-worker/src/worker.ts:107–192; retain unique supporting/opposing evidence, audience, space, project and provenance before applying proposal budgets. Share canonical turn identity with importer normalization rather than maintaining a second parser.

Turn processRun/watch at worker.ts:359–388 into durable artifact/turn/extractor-version jobs with waiting, retry, completed and explicit exclusion states. An unavailable vault must not silently count as completed extraction. Make model synthesis an independently retryable deterministic evidence-set job; select currently active authorized memories instead of stale accepted proposals (worker.ts:258–342). One bad memory/provider call must not stop unrelated extraction. Reconcile late artifacts and capture processing coverage beyond a transport cursor.

Define shared evidence contribution and revision authority without impersonating the original creator (fold-epistemic/access.ts:56–74; SDK/client.ts:991–1003; worker.ts:170–192). Keep personal memory creator-scoped. Add explicit supersession/contradiction, cited memory revisions and dependent-synthesis invalidation; distinguish unresolved project scope from deliberately global memory.

Test late artifact arrival, long-session final correction after the old first-25 cap, repeated pending evidence, cross-space duplicate summaries, human acceptance then worker support, human correction of machine-owned shared knowledge, forgotten-source cognition and repeated model-job replay. Do not solve evidence retention by raising a cap, treating copied evidence as independent confirmation, merging scopes, or promoting model output automatically.
```

## 4. Shared client and useful memory feedback

```text
/make-plan Consolidate the canonical HTTP client and make normal harness use produce measurable, failure-isolated memory feedback. Use PATHFINDER-2026-09-04/01-flowcharts/memory.md and 02-duplication-report.md.

Extend SuperBrainClient as the browser-safe canonical API entry point. Rewrite duplicated transport/stamps/memory/reasoning calls at apps/brain/src/api.ts:68–93,338–347,430–440,492–543 and apps/brain/src/ids.ts:16–53 through packages/super-brain-client/src/index.ts:124–158,208–224,326–367,382–406,465–501. Preserve UI cancellation, Clerk refresh, pagination, local connection preferences and loopback operator-artifact access in adapters.

Create a narrow feedback capability and request/batch contract with recall request ID, exact memory revision, rank/provider, task/attempt/session and offered/injected/used/judged/outcome states. Remove mandatory per-memory telemetry mutations from the success path of reads. Share structured HTTP errors, deadlines/cancellation and retry-hint parsing with importer delivery and capture/SSE callers; each keeps its own durable retry/acknowledgement state machine.

Deliver a bounded project/task context pack using the existing MCP surface and an explicit end-of-task usefulness/correction flow. Include an operator processing/value view showing capture, extraction, memory, recall and use coverage. Test read-only MCP search/context, failed telemetry with successful recall, exact revision joins, no duplicate feedback on retry, browser abort, token refresh, and operator-token separation.

Do not send the loopback operator token to the hosted API, equate recalled with used, call negative feedback 'validated,' add an agent framework, or force all retry loops into one global queue.
```

## 5. Comparable task evidence and a shareable evaluation bundle

```text
/make-plan Fulfill the Super Brain evaluation thesis with an independently assessable task/attempt contract and exporter. Use PATHFINDER-2026-09-04/01-flowcharts/evidence.md E2–E6/E8, 05-assessment.md and the reference's two-model projection bet.

Extend the existing trajectory boundary at apps/capture-daemon/src/capture.ts:1340 and packages/fold-trajectory/src/schema.ts with a versioned task/acceptance contract, attempt lineage, fixed input and starting commit/dirty-patch reference, effective per-turn model/settings/tool/runtime/config identity, available token/time/cost usage, exact memory/context revisions and authenticated intervention/outcome evidence. Preserve sensitive bytes in the private vault. Extend refreshProject at capture-daemon/src/project.ts:39–55 with reconstructible consent-scoped artifact references and explicit fingerprint failures, including untracked content.

First define one fixed task and independent small decision tree, then run two materially different models from the same starting state and preserve manual/reference ambiguous/unmapped assignments. Use fold-trace/trajectory analysis at packages/fold-trajectory/src/project.ts:66; do not use self-mapping confidence 1 as semantic validation. Expand only after the minimum experiment resolves the representation question. Build a task evidence page joining goal, context, changes, checks, intervention, outcome and cost from existing Brain surfaces.

Create a separate selected-evaluation exporter with task/run/annotation/oracle versions, data dictionary, permission/audience and redaction review, content hashes, exclusions and deterministic report regeneration. Keep apps/capture-daemon/src/maintenance.ts:81–124 as the private backup path. A copied vault or a raw turn count is not a sponsor-ready dataset. Do not ship private keys, imply unknown models are exact, invent usage, or claim causal model/memory superiority from uncontrolled observations.
```

## 6. Operated pilot and hosted release gate

```text
/make-plan Define and verify the smallest dependable Super Brain release topology. Use PATHFINDER-2026-09-04/01-flowcharts/platform.md, 05-assessment.md, docs/MULTI_TENANCY.md and docs/OPERATIONS.md. Keep one PostgreSQL-backed API and a small enrolled-repository pilot initially; dependency choices must be concrete before deployment approval.

Choose local-vault worker placement versus tenant-scoped remote artifacts/KMS explicitly. Configure scoped credentials, current membership, enforced non-superuser/non-BYPASSRLS application access, TLS, enrollment/quarantine and identity provisioning/revocation. Add readiness and processing freshness beside apps/api/src/server.ts:1307; structured errors, lag/age metrics, principal/tenant quotas and stream bounds. Set a supported upgrade/migration procedure for startup DDL and schema versions.

Measure full-history memory, cold start, append p95 and capture-to-recall/retrieval p95. Apply paged reads, bounded caches and incremental versioned checkpoints through existing packages/fold-postgres/src/store.ts:516–574 and SDK projection paths where required. Move embedding refresh out of latency-critical reads, bound provider deadlines, and leave semantic indexing optional until a retrieval evaluation demonstrates benefit.

Extend scripts/backup-postgres.sh and scripts/verify-postgres-restore.sh into a scheduled encrypted off-host database-plus-artifact/key recovery drill. Verify restricted-role access, canonical replay, cited artifact decryption, consumer resumption and cross-tenant isolation after restore. Exercise delayed capture and two-process concurrency fixes in the selected topology. Record evidence in the execution backlog and label interfaces, locally tested behavior and operated production separately.

Do not add distributed infrastructure just for future scale, claim /health proves readiness, run destructive restore checks against production, deploy before a reviewable configured result exists, or publish reusable packages before the owner's license decision.
```
