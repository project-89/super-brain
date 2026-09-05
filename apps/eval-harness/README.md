# Frozen synthetic evaluation harness

This harness runs the same frozen event-delivery task with two configured providers, first without memory and then with an exact revision retrieved from an isolated synthetic canonical memory API. Each attempt permits at most three submissions. Automated checks never create human acceptance authority. A small four-attempt comparison is descriptive evidence, not a causal estimate of memory benefit or a model benchmark.

The public task, examples, input module, 59 hidden acceptance cases, tree, annotation rubric, synthetic memory, oracle sources, compiled oracle module, container driver, and runtime contract are hashed before dispatch. Changing an executing component invalidates the approved plan. Oracle expected answers stay on the host; the container receives only synthetic code and case inputs. The model receives only the public task, examples, input, optional retrieved lesson, and actual prior check feedback.

## Runtime setup

Use Node 24 for the harness and Docker with the pinned image in `NODE_IMAGE`. Install/authenticate provider CLIs normally; the harness never reads credential files or changes user configuration. Set `SUPER_BRAIN_EVAL_CODEX` and `SUPER_BRAIN_EVAL_CLAUDE` to explicit executable paths, or provide `codex` and `claude` on PATH. The frozen study expects Codex CLI 0.153.3 and Claude Code 2.1.246; another version requires a newly reviewed freeze. Configured models are `gpt-5.6-sol` and `sonnet`, both with medium effort. Observed model IDs and usage remain absent if the runtime does not report them.

Codex runs in an ephemeral synthetic directory with invocation-only configuration and catalog overrides, read-only sandbox, no project-document discovery, disabled hooks/plugins/apps/memories/shell/browser integrations, and a fresh loopback mock probe before real dispatch. The probe recursively allows only the reviewed `request_user_input` schema, which is advertised as a Plan-only stub and unavailable in the noninteractive Default mode. Every other tool or unexpected context fails the gate. Any actual tool attempt invalidates empirical classification. The fixed instruction is “Use no tools,” rather than claiming the runtime advertises no schemas.

The historical four-attempt run used observation contract v1 and independently verified explicit empty Claude initialization records in every real round. Observation contract v2 additionally rejects missing, duplicate, or incomplete initialization records before code can execute. The historical `fixtures/event-delivery-v1` freeze remains unchanged; the default prospective fixture is `fixtures/event-delivery-v1-runtime2`. No new provider run is claimed for v2.

Claude uses safe mode, empty tools, strict empty MCP configuration, no session persistence, empty settings sources, and a fixed system prompt. Its first native initialization record must show no active tools/plugins/MCP, and actual tool calls invalidate the run. A Codex mock URL is explicitly rejected for Claude. Claude's schema flag is omitted because it introduces a structured-output tool; the same exact `{code,summary}` response contract is validated by the harness. Authentication, provider availability, and unavailable runtime observations are recorded honestly as preparation failures.

## Reproducible commands

From this package after building:

```
node scripts/container-drill.mjs
node dist/main.js probe-codex /absolute/private/probe.json
node dist/main.js prepare /absolute/private/plan.json
node dist/main.js run /absolute/private/plan.json /absolute/private/new-raw-directory APPROVED_PLAN_SHA256
node dist/main.js export /absolute/private/new-raw-directory /absolute/private/annotations /absolute/private/new-selected-directory
node dist/main.js export /absolute/private/new-raw-directory /absolute/private/annotations /absolute/private/new-selected-directory APPROVED_PREVIEW_SHA256
node dist/main.js verify /absolute/private/new-selected-directory
```

The first export writes a private review preview and returns its hash. Final writing requires approval of exactly that preview; it rechecks source eligibility and the same bytes. Raw directories are single-use. Dispatch markers are saved before the provider starts; an interrupted or uncertain attempt is never automatically repeated. A provider preparation failure does not prevent the other independent provider from running. Cancellation prevents new dispatch and terminates the owned process group. Each generated-code container is separately removed in `finally`, including after Docker client failure.

Store study artifacts under the remediation checkout's ignored `.data/evaluation/<unique-run>` directory, with a private root and owner-only files. Never use the live checkout or live memory corpus. Raw CLI streams, stderr, machine paths, canonical subject receipts, and full local canonical projection events remain private. Only explicitly selected, reviewed artifacts enter the bundle. The bundle includes exact submitted code, observations, recomputed checks, per-round runtime/configuration/usage, annotation evidence, synthetic source content, and shared trajectory projections. It excludes unverifiable or unselected sources. Fresh source selection is valid at export time; an offline bundle cannot learn later revocation.

The container has no network, host mounts, credentials, writable root, capabilities, or privileged user. It has bounded CPU, memory, processes, output, and time. A fresh VM per case adds tamper resistance; Docker is the security boundary. Driver slots are reserved before candidate evaluation, input bytes are removed from module globals, and returned values are detached before transport. Observer failures cannot masquerade as expected candidate exceptions. Missing or malformed observations remain unavailable.

The compiled container drill uses authored synthetic modules only: known-good acceptance, global-slot interception, hostile proxies, null output, input prototype mutation, imports, timeouts, and absent process/network globals. Unit tests cover dispatch gating, process-group cleanup, fresh canonical memory retrieval, export joins and explicit review, per-round runtime identity, bounded private reads, and offline deterministic regeneration. No unit fixture is presented as a real provider attempt.

Historical selected bundles remain verifiable with the current `verify` command: verification uses their selected bytes and hashes rather than the current execution freeze. Reassembling the historical raw run requires its preserved executed harness and historical fixture; do not substitute the prospective default freeze. The local study retains those exact runtime/oracle modules and source files privately alongside the reviewed bundle.
