# Frozen evaluation design — prepared before model execution

Status: design only. No model attempt or empirical result is represented by this document. The implementation agent must finish and hash the concrete prompt, input fixture, independent tree, acceptance checks and annotation rubric before the first real provider run. Keep this preparatory document out of earlier verified source milestones until its experiment phase is implemented.

## Question and scope

Can the existing trace, trajectory and evaluation packages represent two real models solving the same bounded programming task, with independently checked results and honest provenance? A secondary controlled condition checks whether a retrieved, revision-pinned memory changes the observed result or effort. This is a representation and reproducibility experiment, not a model leaderboard or a causal claim from one task.

Use a synthetic event-delivery task. The input contains no project source, private corpus, credentials, local paths, external account data or customer information. Use the available authenticated runtimes with hooks, unrelated integrations, persistent memory and tools disabled where possible. The harness supplies the entire synthetic input and applies returned code into a disposable fixture. Model-generated code runs in a bounded isolated process; it has no credential-bearing environment, network capability or live repository access. A fresh container is preferable for executing generated code. Do not execute arbitrary generated scripts in the application workspace.

## Fixed task

Implement a small JavaScript event-delivery reducer for a supplied synthetic fixture. Each arrival has a decimal-string ingestion sequence and an immutable event with an ID, event-time value and JSON payload. Delivery position is distinct from canonical event-time order.

Acceptance behavior, disclosed in the prompt:

1. A checkpoint filters already consumed ingestion positions, using integer comparisons that remain exact above JavaScript's safe-number range.
2. A newly arrived backdated event remains deliverable. Canonical presentation sorts by event time and then event ID, independently from arrival order.
3. Exact event retries preserve one logical occurrence. Distinct IDs with identical payloads remain distinct occurrences.
4. Reusing one event ID with changed immutable contents fails explicitly. Stable JSON equality ignores object key order while preserving array order and nested content.
5. Invalid decimal positions and inconsistent duplicate ingestion positions fail explicitly. Empty input preserves the supplied checkpoint.
6. Inputs are not mutated. The returned checkpoint is a decimal string and the output is deterministic under the documented arrival contract.

Use this exact module contract: `export function reduceDelivery(state, arrivals)`, where `state` is `{checkpoint: string, events: Array<{id: string, t: number, payload: JSONValue}>}` and each arrival is `{sequence: string, event: {id: string, t: number, payload: JSONValue}}`. Return a fresh `{checkpoint, events}`. The initial state is `{checkpoint:"0",events:[]}`. `events` is the retained set of logical occurrences, not only the newly delivered batch.

Sequences are canonical decimal strings (no sign, whitespace, leading zeroes or decimal point), within PostgreSQL's nonnegative signed-bigint range. A checkpoint may be zero; arrival sequences start at one. Batches may arrive in any order. Validate all input, including older arrivals, before returning a result. A duplicate sequence within this batch must name an identical immutable event. The state does not retain an ingestion-position map, so the task does not require detecting position reuse across separate previous batches. Existing event IDs must have identical time and JSON payload wherever they appear in the supplied state/batch. Object key order is irrelevant, array order matters, and payloads contain JSON values with finite numbers. Event IDs are nonempty strings; times are nonnegative safe integers. Invalid input throws an error and never returns a partial result.

Only arrivals above the supplied checkpoint can add new occurrences. An exact event retry at a higher sequence advances the checkpoint without adding another occurrence. Return the maximum of the old checkpoint and the delivered positions. Sort retained events by numeric `t`, then ordinary JavaScript string ordering on `id`; never use locale-sensitive ordering. Preserve distinct IDs even for identical payloads. Inputs, including nested payload objects, must remain unchanged. Empty input preserves the checkpoint and returns canonical event order.

Before any provider execution, freeze public examples plus independent executable cases for delayed events, large positions, exact retries, identity conflicts, key ordering, arrays, invalid input, checkpoint continuation and mutation protection. Test files and expected results remain outside the model-writable fixture. Record the initial fixture hash and the acceptance-suite hash. The generated function receives test inputs through a fixed container driver; expected answers stay in the host-side oracle runner. The container receives no credentials, host workspace mount or network capability. Resource and output limits apply to every invocation.

## Attempts and conditions

Run two materially different real model providers or models from the same frozen input. Record both configured identifiers and the actual observed identifiers/versions returned by each runtime, preserving any uncertainty. Prefer one OpenAI model and one Anthropic model if their authenticated isolated runtimes are available. Local help has established usable bundled Codex and Claude executables; authentication and generation are not yet tested.

Use a bounded harness: at most three code submissions per attempt. Each submission receives only the same initial task context, prior public submissions, and its actual acceptance-test feedback. Record every generated output, applied code hash, executed acceptance check, exit status, elapsed time and source-provided usage. A test result is observed evidence; a model's concise decision summary remains self-reported. Do not ask for hidden reasoning or reinterpret a reported rationale as an observed internal decision.

The baseline condition supplies no memory. The memory condition starts fresh and injects an actually retrieved synthetic approved memory with an exact revision and recall ID. Its content may state the general lesson that ingestion positions, canonical timestamps and occurrence identity are distinct, and that large sequence positions require exact arithmetic. Record the retrieval request, returned revision and injected bytes. Hold the task, initial code and acceptance checks fixed. Report raw per-attempt results and effort; acknowledge the small sample and runtime differences. Neither a synthetic fixture nor a dry run counts as a real provider attempt.

## Independent tree and annotations

Freeze a small decision tree before any model output, with nodes for identifying delivery versus presentation order, choosing exact sequence arithmetic, preserving occurrence identity, validating immutable retries, and testing checkpoint continuation. Include alternative branches where implementations can meet the same requirement in different ways.

Annotations cite observable code spans, submitted actions or check results. They must distinguish structural mapping from semantic interpretation. Keep ambiguous and unmapped steps rather than forcing complete coverage. A model-generated rationale alone cannot certify semantic equivalence. Do not turn a one-output run into invented intermediate actions; only the actual harness rounds and checks form its trace.

The report states which attempts are comparable by exact task version, input state and condition, and which evidence is absent. Acceptance is determined by the frozen executable suite and is labeled as an automated check result, not human approval. Preserve the original model outcome label separately.

The existing `fold-eval` arithmetic kernel retains a neutral numeric identity for all-absent inputs. The experiment/report boundary must inspect execution availability and represent a missing or failed-to-run suite as unavailable, not as a passing score. Reuse the Phase 3 explicit availability representation; only actual completed checks contribute to reported acceptance.

## Artifacts and publication boundary

Produce a local deterministic evaluation bundle containing the frozen task, fixture, tree and oracle versions; selected real attempt outputs; observed runtime/configuration metadata; annotations; acceptance results; a data dictionary; known exclusions; and content hashes. Regeneration must reproduce the report from those selected inputs. Explicitly label any synthetic unit-test fixtures and preparation failures.

Use the selected evaluation exporter with permission, audience, current-revision and redaction review. Exclude local credentials, account identifiers, raw runtime headers, private artifact paths, keys and unrelated transcripts. Creating a local reviewed bundle does not publish it externally. Real provider unavailability remains a named dependency; never substitute fabricated outputs.

## Runtime isolation discovery

The bundled Codex `0.153.3` executable's local `features list` confirms controls for `shell_tool`, `unified_exec`, `hooks`, `plugins`, `apps`, `memories`, `multi_agent`, browser/computer/image tools, `skill_search`, and `skip_host_skill_discovery`. Configure the experiment explicitly; installed defaults enable several integrations. Use `exec --ignore-user-config --ephemeral --json`, a synthetic working directory, disabled tools/integrations and zero project-document discovery where supported. Confirm effective isolation from the runtime's actual behavior before accepting an empirical run. These are observed configuration capabilities, not proof that generation or authentication has succeeded. Do not modify the user's installed configuration.

Local mock preflight found that the configured model catalog can inject tool namespaces despite feature flags. The invocation-only catalog override and bounded empty skill context must therefore be verified against the recursively inspected actual request. The reviewed configuration removes executable/file/patch/collaboration tools, plugins and private home skill context. It retains an advertised `request_user_input` stub documented as unavailable in the noninteractive Default mode; record this residual schema honestly and reject any actual tool attempt in the experiment. The system prompt instructs the model to use no tools. Both bundled Codex 0.153.3 and an isolated official npm Codex 0.153.4 installation produced this same residual schema against the loopback mock; no real model generation was involved. Retain the chosen runtime/configuration unchanged across its two conditions. This acceptance is specific to the inspected harmless stub, not a blanket exception for unreviewed tools or private context.
