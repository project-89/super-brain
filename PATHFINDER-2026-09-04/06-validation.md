# Validation and observation record

- Repository: `/Users/jakobgrant/Workspaces/super-brain`
- Branch: `main`
- Commit: `eda5604e6e1d06465dac5e1b914c531c96b15031`
- Review date: September 4, 2026, America/Vancouver (September 5 UTC).

## Verification

`pnpm verify` completed with exit code 0. Build and type checking passed. The test suite reported **443 passing tests in 74 files**, plus **12 skipped PostgreSQL tests**. PostgreSQL tests require `FOLD_TEST_DATABASE_URL`; this review did not configure a disposable database or run tests against the user's live database. CI defines a separate PostgreSQL/pgvector job with a restricted role, but this review did not establish the current remote CI result.

Existing test success does not cover all observed architectural failure modes. Additional small synthetic probes are described in `01-flowcharts/platform.md`, with their limits. No production data was mutated by these probes. No hosted deployment, browser interaction, backup restoration, load test or external-provider evaluation was performed.

## Live local observations

Read-only HTTP requests used an existing authorized local operator credential. Credentials and transcript/memory content were not written to this report. Counts are a time-bounded local snapshot, not immutable benchmark results or counts across every possible private principal.

At approximately **2026-09-05 01:25 UTC**:

| Measure | Observed count |
| --- | ---: |
| Canonical events visible to the operator | 38,683 |
| Projects | 81 |
| Imported runs | 770 |
| Active memories visible to the operator | 1,967 |
| Memory candidates | 2,577 |
| Pending candidates | 610 |
| Memory feedback events visible to the operator | 0 |
| Recorded trajectories | 75 |
| Trajectories labeled success | 34 |
| Trajectories labeled unknown | 41 |
| Distinct task groups among those trajectories | 74 |
| Task groups containing more than one model label | 0 |
| Trajectories with a generic harness name as model ID | 12 |
| Steps across recorded trajectories | 13,331 |

Generic model labels were `codex` and `claude-code`. The other recorded labels were `gpt-5.6-sol`, `claude-fable-5`, and `gpt-6-astra`; these are stored labels, not independent verification of the provider/model actually used. The task-group calculation used canonical `trajectory.taskId`, not heuristic prompt matching. Zero multi-model groups therefore establishes a missing recorded comparison, not that nobody ever attempted similar work with different models.

A separate read found zero visible events for `intention.surfaced`, `intention.committed`, `intention.acted`, and `intention.ended`. It did not query `intention.declined`. The memory worker's durable cursor existed; this alone is not a guarantee that every available artifact was extracted.

Shortly before the API census, the local capture `/health` response reported **14,224 received hooks, 72 finalized units, zero truncated steps, two pending jobs, zero failed jobs, and 156 cumulative relay failures**. The last relay error was a timeout. Received-hook count and relay-failure count have different semantics: an ambiguous timeout may have occurred after daemon receipt. **156 failures must not be reported as 156 lost hooks.** Daemon finalized units and canonical trajectory counts are also distinct counters, sampled at different times.

The installed API service configuration selected PostgreSQL, had no Clerk or embedding configuration, and left `FOLD_REQUIRE_TENANT_RLS` unset. That is a local configuration observation, not evidence of an internet-exposed deployment or of actual PostgreSQL role privileges. The API and daemon responded to loopback health requests. Local capture policy included exposed reasoning, retained opaque reasoning, summary trees, and no identity anonymization.

## Evidence limits

- Source and synthetic reproductions support architectural findings; they do not establish that every failure has occurred in the live corpus.
- Success labels are not independently validated task outcomes. The capture implementation's labeling rules are themselves a finding.
- Local service/build success does not establish production TLS, identity, object storage, KMS, alerting, rate limiting, isolation, or recovery readiness.
- Historical planning documents are used for goals and intent. Current source, tests and bounded observations take precedence over their completion labels and older counts.
