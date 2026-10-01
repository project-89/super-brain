# Material duplication and responsibility overlap

Baseline and feature boundaries: [00-features.md](00-features.md). The within-feature and cross-feature discovery passes were synthesized against the three source-backed flow reports. Explanations of why code diverged below are inferences from current structure, not claims from Git history.

## Consolidate in the shipping work

| Concern | Source evidence | Why it matters | Smallest consolidation |
| --- | --- | --- | --- |
| Live/recovered hook interpretation and outcomes | `apps/capture-daemon/src/capture.ts:71–135,297–305,775–845,945–977`; `apps/capture-daemon/src/recovery.ts:17–57,176–195` | Independent result decoding shares the unsafe missing-evidence-success default; live Git/FileChanged invalidation and recovery tool-name invalidation diverge. Live/recovery effects legitimately differ. | One pure hook normalizer and typed evidence reducer, called by both flows. Share task-key derivation. Keep source I/O and retrospective uncertainty outside the reducer. |
| Native transcript identities reconstructed twice | `apps/importer/src/adapters.ts:98–120,157–171`; `apps/importer/src/builder.ts:155–181`; `apps/memory-worker/src/vault.ts:54–113` | Memory evidence points at canonical turn IDs, but importer and vault reader independently detect turns/messages. Metadata and private text are legitimate different outputs; identity logic should not drift. | Share native-record decoding and the turn-identity state machine. Metadata projection and private-text extraction remain separate consumers. |
| SDK single/batch command commits and independently mutable revisions | `packages/fold-sdk/src/client.ts:317–377,907–958,978–1078`; `packages/fold-postgres/src/store.ts:291–315,322–330,424–441` | Repeated envelope checks, candidate event builders and cache updates have inconsistent retry behavior. Storage and SDK maintain overlapping complete mutable snapshots; the SDK can label an incomplete cache with another writer's revision. | One internal validated entry-batch commit with expected revision and command idempotency; public single/batch methods delegate. Storage returns the exact committed revision/snapshot boundary; SDK owns validated projections, not an independently invented storage revision. |
| Competing memory duplicate definitions | `apps/memory-worker/src/extractor.ts:156–166`; `apps/memory-worker/src/worker.ts:107–112,126–192` | Extractor removes summary matches before worker's source/project key sees them. Worker also drops pending/in-batch repeats and omits audience/space from keys. Distinct support can be lost or suppressed across scopes. | Extraction emits evidence-bearing observations; one scope-aware worker consolidation policy merges unique support before applying proposal budgets. Content conflict and independent-source evidence stay explicit. |
| Canonical HTTP clients and recall telemetry | `apps/brain/src/api.ts:68–93,338–347,430–440,492–543`; `apps/brain/src/ids.ts:16–53`; `packages/super-brain-client/src/index.ts:124–158,208–224,326–367,382–406,465–501` | Routes, stamps, error decoding and memory/reasoning operations are duplicated. Browser cancellation and capture settings are legitimate UI concerns. Harness recall has mandatory awaited telemetry when enabled; UI recall does not share it. | Extend the browser-safe canonical client with cancellation and consistent operations/DTOs. Keep browser connection preferences and loopback operator access in the UI adapter. Use one optional, failure-isolated telemetry contract. |

Single and batch mutation APIs serve different callers; removing their duplicated internal commit behavior must preserve draft handling, atomicity, all-or-nothing expectations and idempotency. Extracting a helper without adding a transactional expected-state check does not solve concurrency.

## Share narrow policies; keep the state machines separate

Import delivery (`apps/importer/src/delivery.ts:93–133`), capture spool delivery (`apps/capture-daemon/src/delivery.ts:21–26,112–136`) and event consumption (`packages/super-brain-client/src/index.ts:571–599`) duplicate HTTP error/retry classification. Their retryable status sets and retry-hint sources differ. Share structured transport errors, deadlines, cancellation and retry-hint parsing, but retain each workflow's own attempts, durable state and acknowledgement policy. A bounded import, durable outbox and subscriber are not the same queue. Avoid nested retries that multiply waits without visibility.

Hook and native transcript formats also require different adapters. Live/recovery should share their actual hook decoder; native transcript adapters should produce compatible success/failure/unknown evidence without pretending raw formats are identical (`capture.ts:129–135`; `recovery.ts:48–54`; `apps/importer/src/adapters.ts:169–171`; `apps/importer/src/builder.ts:214–229`).

## Similarities that should remain

- **Private vault and canonical Fold:** different content, trust, privacy and retention responsibilities. Consolidate reference integrity and restore manifests, not raw storage.
- **PostgreSQL and JSONL:** materially different concurrency and durability contracts. Do not hide the weaker fallback behind a falsely uniform guarantee (`apps/api/src/registry.ts:123–139`; `packages/fold-postgres/src/store.ts:424–441`).
- **Lexical and vector ranking:** different retrieval mechanisms and deliberate weighting (`apps/api/src/recall.ts:18–27`; `packages/fold-postgres/src/embeddings.ts:40–48`). Share authorized document fields; do not force identical representations.
- **Authorization before and after ranking:** intentional protection around an external provider, not redundant validation (`packages/fold-sdk/src/client.ts:1227–1257`).
- **Domain projections:** memory, fleet, narrative and trajectories have different semantics. Share storage/checkpoint contracts where useful; keep their reducers independently testable.
- **Operator and agent credentials:** different authority. The human-decision finding requires strengthening that separation, not merging authentication paths.

## Synthesis

The primary architectural problem is overlapping ownership of identity, outcome meaning, command revision and duplicate evidence. Fixing those responsibilities is valuable. A broad package reshuffle or generic registry would add risk without resolving them. Source detail and confidence limits are in [evidence](01-flowcharts/evidence.md), [memory](01-flowcharts/memory.md), and [platform](01-flowcharts/platform.md).
