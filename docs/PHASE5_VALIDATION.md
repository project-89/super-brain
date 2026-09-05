# Phase 5 validation evidence

Status: **Phase 5 verified**. Independent source review, focused validation, frozen execution, four real provider attempts, independent annotation, the reviewed local bundle and the complete repository gate passed. This document does not authorize live deployment or publication.

## Scope and evidence boundaries

The experiment uses one independently authored public programming task, two provider runtimes and separate no-memory/memory conditions. The final frozen oracle contains 59 cases in eight groups. The authored reference implementation passes the suite and eight meaningful mutants fail it. These are checker validation fixtures, not empirical model results.

The harness records actual public submissions and actually executed check batches. Shared `fold-trace` and `fold-trajectory` projections retain those observations without inventing intermediate reasoning, model decisions or human approval. Missing checks remain unavailable. The selected report's available confidence is a mechanical 0/1 suite result, not a calibrated probability. A kernel's neutral value for absent evidence is never reported as success.

The memory condition retrieves an exact approved synthetic memory revision through the normal authenticated API. Selection checks the exact revision, current access/currentness, actual recall subject and injected content bytes. The authenticated subject receipt remains private. Prompt injection demonstrates exposure; it does not establish internal use or a causal memory benefit.

## Focused source validation

The platform gate passed 211 tests across its four owned packages after the final per-round runtime addition. Scoped typechecks and builds passed. PostgreSQL integration tests used a disposable PostgreSQL 17 instance with a restricted application role; no live database was used.

| Package | Passing tests | Relevant coverage |
| --- | ---: | --- |
| `fold-eval` | 37 | Strict deterministic JSON, complete frozen case sets, exact code/check joins, unavailable results, same-round annotation evidence, sensitive decoded JSON, per-round runtime identity, missing/tampered files and regeneration |
| `fold-sdk` | 65 | Current exact source revisions, explicit review, scope/deletion/dependency loss, immutable task/attempt/outcome joins and private selection subject |
| `super-brain-client` | 23 | Canonical selected-source transport and existing token, cancellation, deadline, retry and provenance contracts |
| `super-brain-api` | 86 | Selected-source capability checks, exact request subject and membership/space revocation during a deferred read; eight real two-process PostgreSQL regressions remain covered |

Independent review also exercised the source-selection suite and the shared trajectory adapter. The final harness boundary gate passed **21 tests in eight files**, then passed an independent rerun. It covers actual API source selection through preview, exact hash approval and offline regeneration; altered code, cached checks, injected memory, task/runtime identity and impossible failed-runtime/container pairs; bounded process/container dispatch; stable bounded file reads; and shared trajectory projection. These tests are explicitly synthetic. The oracle is verified separately against its final freeze. Harness typechecking and ESM/declaration builds passed.

With the final oracle freeze, the complete harness package gate passed **37 tests in nine files** and its typecheck. These are additional to the four platform package counts above.

After the final parser correction, the affected runtime and harness suites passed another independent **7-test** run. The correction recognizes only the exact observed disabled-discovery diagnostic messages; unknown errors and attempted tools still fail. An omitted top-level tool list is accepted only when the additional-tool records are present and recursively validated.

## Frozen identities

The coordinator independently verified all 11 frozen artifacts under **Node 24.20.0** before provider dispatch. Freeze time: **2026-09-05T07:22:39.508Z**. Task ID: `synthetic-event-delivery-v1`. Task version: `event-delivery-v1:6ee59e426d7ff46998ee1960b12682c939d5c4b0a19cb9a27191a3e2c8d97872`.

| Identity | SHA-256 |
| --- | --- |
| Frozen suite | `6ee59e426d7ff46998ee1960b12682c939d5c4b0a19cb9a27191a3e2c8d97872` |
| Initial input module | `53cff86405fce06c0976d3404b3b4a4ed124e69a60653970d806285dfa42ab7a` |
| Hidden cases | `54101e958eb3d24addefd2da0e9feb170faab43cbc291b0497d68286c87cf48f` |
| Decision tree | `45c6d2e3940700bce080f30de0b9ed69419fd0f22ca0fad3074812a3d96a2c82` |
| Annotation rubric | `3f5dc7d3108f16b73cc4e42c8ccb08aaf9024a92fa4047e5f762ea1665742fa5` |
| Active built oracle module | `0a4a464cea6ac4de489aa1dd039570a083e1f4ddd511afbd405eebd2b80ce36e` |
| Container driver | `79ede1ef6e2a7d00ece901adf7ae39bccb45f69f97a9f881b6899fc7de667f39` |
| Runtime contract | `e931747acef7f679be3ad461580887670cf5322dc583725274c814205cc05790` |

The versioned [freeze manifest](../apps/eval-harness/fixtures/event-delivery-v1/freeze-manifest.json) also binds the public specification, examples, synthetic memory and oracle/snapshot sources. The pinned Node container image is `node@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf`.

## Execution and export gates

Before provider dispatch, the harness requires an exact reviewed execution-plan digest and rechecks the frozen task, oracle, driver, runtime configuration and implementation identity. A fresh local Codex request-shape probe must show the reviewed isolated configuration. That probe is synthetic, makes no empirical model claim, and cannot substitute for a real attempt. The narrowly advertised unavailable Plan-mode input stub is distinguished from executable tools.

The final pre-execution mock probe completed with exit code 0, no protocol issues and the approved request shape. Its request SHA-256 was `f866b599adb0198c62da54097b2acd0e0afd4883e402313224b0f922524e80fa`; the only advertised stub was `request_user_input`, unavailable in this noninteractive Default-mode run. The prepared Node 24 execution-plan digest is `951cec1fac07f50b83ef70045330da8787f33a6f89c7e3c7b9009baa96dbcba6`. Preparation and a mock response do not count as a provider attempt; the execution gate runs a fresh probe again.

The approved plan then completed the real experiment. Its fresh in-run preflight request SHA-256 was `3f3b98846a45182dfed1aac0912ef30ebd86f375f2bc0ea4d4f5516c4b737389`. The retained private attempts file has SHA-256 `e193578d31ff9ccc0d2b073612d1d6523c395141e250c5c07f3f531c4f0a796d`; raw runtime outputs and private locations are not included here.

Generated modules run only after a successful, tool-free, protocol-valid provider response. The pinned container runs without a network, host mounts, writable root filesystem or elevated capabilities, with CPU, memory, process, output and time bounds. Expected oracle answers remain outside the candidate container. Process groups and owned containers are cleaned up after completion, cancellation and failure.

An independent actual-container check used the pinned **Node 24.20.0** image and final driver digest above: the authored correct reducer passed **59/59** frozen cases. Eight scripted boundary cases confirmed that an observer-throwing Proxy stays non-JSON, a null return stays an observed incorrect return, `__candidate` and `__input` setter interception are denied, input prototype mutation is detected, imports are denied, execution timeout stays unavailable, and process/network/pre-call input globals are unavailable. A ninth independently authored boundary confirmed that `Proxy.toJSON` cannot serialize a forged correct result: cloning rejects it and the check fails. None of these fixtures is a model output.

The exporter verifies retained observations against exact submitted code, driver, image and frozen checks. It preserves per-round runtime identities, exact output/check references and annotation chronology. Mixed or unknown runtimes are not relabeled as a single final-round model. File reads are bounded before allocation, require stable regular files and reject unstable or redirected selected-directory traversal.

The first export produces a private preview of the selected sanitized bytes and a content hash. Final local creation requires that exact reviewed hash and a fresh authorization selection. The bundle includes its data dictionary, explicit exclusions, content hashes and deterministic report. Verification rejects missing, extra or altered files and regenerates derived output. Raw runtime streams, authorization receipts, credentials, account IDs and private paths remain outside the selected bundle and this document.

## Observed experiment

All four attempts are actual provider runs, with **six submissions total**. The coordinator independently replayed all six stored observations through the frozen oracle and checked their exact code hashes. Every runtime exited successfully without protocol issues. All four final submissions passed **59/59** checks with zero unavailable checks.

| Provider / configured model | Condition | Observed model | Checks by submission | Submissions | Provider + check execution time |
| --- | --- | --- | --- | ---: | ---: |
| Codex / `gpt-5.6-sol` | No memory | Unavailable | 59/59 | 1 | 73.443 s |
| Codex / `gpt-5.6-sol` | Memory | Unavailable | 59/59 | 1 | 81.061 s |
| Claude / `sonnet` | No memory | `claude-sonnet-5` | 58/59 → 59/59 | 2 | 94.436 s |
| Claude / `sonnet` | Memory | `claude-sonnet-5` | 57/59 → 59/59 | 2 | 92.362 s |

The Claude no-memory first submission failed `arrival-zero`. Its memory first submission failed `older-conflict-validated` and `batch-old-new-id-conflict`. The second submissions corrected those observed failures. Both memory attempts used the exact selected revision **0**, with matching injected content digests. The configured runtime versions were Codex CLI **0.153.3** and Claude Code **2.1.246**; runtime identity observations are preserved separately from those configuration labels.

There was **no reduction in submission count** in this experiment. Codex did not report an actual model identity in either condition, so a matching configured label does not establish matching observed model execution. Durations are the sum of recorded provider and check execution durations, not a controlled speed comparison. This sample supports the capture, attribution and reproduction mechanism; it supports no general memory-effect or model-ranking conclusion.

The six submissions contain **354 observed case checks** and received **12 independent annotations**, one for each actual output/check step. The selected assembly applied those annotations through the shared trajectory replay, refreshed actual canonical source eligibility and recomputed all six oracle results. Its private preview contains **62 selected artifacts** and has review SHA-256 `5d4ce6b56a58d56dafb0dbb074e79beb8b1b024ba9db2037e696d2f26f148eec`. Pure creation, self-verification and deterministic regeneration passed before approval of those exact bytes.

The coordinator approved that exact preview and independently verified the final selected directory through the original Node 24 CLI. The final manifest/bundle SHA-256 is **`f732859e08f70a71872f767bcea6558f3e066fb78e9ca2688fd817adddbedde6`**. Filesystem verification and report regeneration passed. The bundle remains a private local artifact; no external publication occurred.

## Historical execution and subsequent hardening

The recorded experiment used the executed version and frozen identities above. A subsequent review found that its Claude parser checked initialization lists when present but could accept a result-only stream without initialization evidence. All **four actual Claude rounds** in this experiment had explicit empty initialization tool, plugin and MCP lists; their recorded evidence and results are unaffected. A verified private archive preserves **34 exact historical files**, including the executed compiled module, source, runtime configuration and fixtures. The original tracked fixture remains `apps/eval-harness/fixtures/event-delivery-v1`.

The prospective observation contract is separately versioned as **2** and requires exactly one Claude initialization record with explicit empty `tools`, `mcp_servers` and `plugins` arrays. Result-only, duplicate and missing-field regressions passed in the affected eight-test runtime/harness gate. Its default fixture is separately frozen at [event-delivery-v1-runtime2](../apps/eval-harness/fixtures/event-delivery-v1-runtime2/freeze-manifest.json), timestamp **2026-09-05T07:44:55.291Z**. The complete prospective harness gate passed **38 tests in nine files**, typechecking and ESM/declaration builds. The rebuilt CLI also verified the historical selected bundle offline.

| Prospective runtime 2 identity | SHA-256 |
| --- | --- |
| Frozen suite | `f37f9b4c3da7469cb1af0e366f90f444a00dfd3545eaa88c71be6d2ec0509a71` |
| Active built oracle module | `a4dcbec08ead58261d0f383d763739f4b063366f51c01e60e9f53e4864c14c47` |
| Runtime contract | `b3f019a97f1afb2754416e3065cd0ea1cf83fa29cef0f3ae3818b296f6ee19a7` |

No provider calls were made under runtime 2, and no historical task/result identities were rewritten. The tighter future parser was not a prerequisite retroactively enforced on the recorded six submissions.

## Complete repository verification

The coordinator ran the complete `pnpm verify` gate under **Node 24.20.0** with disposable PostgreSQL 17 and a restricted application role. It exited successfully with **699 tests across 116 files and 22 packages**, **zero skipped tests**, all workspace typechecks and both builds passing. The rebuilt runtime 2 oracle retained its exact frozen module digest. The rebuilt CLI independently verified and regenerated the original historical selected bundle again. No live database, original checkout, installed service or external publication was changed by this verification.

The staged Phase 5 change set also passed the pinned **Gitleaks 8.30.1** local scan with redaction and no leaks found, plus `git diff --cached --check`. The scan did not include ignored private state or upload any content. The preparatory Phase 6 operations document is excluded from this phase's commit.

## Final evidence ledger

| Evidence | Status |
| --- | --- |
| Final frozen task/oracle/tree/rubric and driver identities | Passed: 11 artifacts verified under Node 24.20.0 before dispatch; identities above |
| Actual isolated request-shape preflight | Passed: pre-execution and fresh in-run request digests above |
| Actual pinned-container reference check | Passed: final driver/image, 59/59 authored correct cases and nine independent boundary checks |
| Four real provider attempts | Complete: six submissions independently replayed; all four final results 59/59, no unavailable checks |
| Independent evidence-based annotations | Complete: 12 annotations for six actual output/check pairs; shared trajectory replay passed |
| Reviewed selection digest and local bundle digest | Complete: exact 62-artifact preview approved; final manifest/bundle digest above |
| Independent local bundle verification/regeneration | Passed through original Node 24 CLI against final local selected directory |
| Prospective runtime 2 hardening | Passed: distinct future freeze, 38 tests, types/builds and historical offline bundle verification; no new empirical runs |
| Complete Node 24 / disposable PostgreSQL repository gate | Passed: 699 tests / 116 files / 22 packages, zero skips, all types and both builds |

One task and four attempts establish a small reproducibility and representation exercise. They do not establish a model leaderboard, a general memory effect or production readiness. Hashes establish byte consistency; a separately retained digest is needed to detect replacement of an entire bundle. Offline exports cannot discover later revocation, so any new export requires fresh source selection. No external publication is part of this milestone.
