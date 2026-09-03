# Super Brain Implementation Status

This ledger distinguishes implemented behavior from deployment work. Features
listed as complete are backed by code and tests; they are not simulated UI.

## Critical Path

| Area | Status | Implemented boundary |
| --- | --- | --- |
| Real harness capture | Complete | Loopback-authenticated Claude Code, Codex, and Hermes lifecycle/tool ingestion with a durable spool and diagnostics |
| Capture integrity | Complete | Source normalization, orphan finalization, repository mutation tracking, verification invalidation, and causal event/artifact/turn links |
| Historical corpus | Complete | Streaming Claude/Codex import, stable project/run/segment identity, encrypted redacted vaults, and idempotent canonical metadata |
| Fleet | Complete | Authenticated sensor events, replayed session state, freshness, and timeout-gated recovery planning; no simulated mutation route |
| Trajectories | Complete | Empirical steps, verified/success/failure/unknown outcomes, shared semantic task trees, additive branch merge, divergence, and coverage |
| Memory formation | Complete | Transcript and live candidates, conservative evidence-gated promotion, repeated-evidence consolidation, revision, forgetting, and project scope |
| Agent access | Complete | Authenticated HTTP/SSE client plus MCP search, cited context, checkpoint, proposal, and feedback tools for any compatible harness |
| Feedback | Complete | Immutable recalled/helpful/unhelpful/superseded signals tied to memory, task, query, session, and actor context |
| Authorization | Complete | Workspace/space/creator checks plus independently least-privilege credential capabilities on every route family |
| Operations | Complete | Persistent macOS services, AES-256-GCM vault keys, verified exports, raw-hook retention, PostgreSQL backup and restore-check scripts |
| Operator UI | Complete | Live fleet, history, memory review/feedback, trajectory evidence, reasoning, steering, raw event, and projected-state views |

## Deployment Choices

These are environment-specific integrations, not missing simulated product
features:

1. Select and operate a real embedding service before enabling pgvector ranking;
   deterministic lexical BM25 remains the complete default.
2. Put TLS, a durable identity/rotation system, and distributed rate limiting in
   front of the API before exposing it outside a trusted local network.
3. Schedule the supplied PostgreSQL backup and disposable restore verification,
   retain an encrypted off-host copy, and monitor failure/age.
4. Provision one scoped sensor or harness credential per remote machine or agent
   identity; do not share the local operator token.
5. Add a manual project merge/split workflow only when real ambiguous identities
   appear. The stored resolution state already preserves that uncertainty.
