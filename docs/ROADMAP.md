# Super Brain Implementation Status

This ledger distinguishes implemented local behavior from deployment work.
Features listed as complete are backed by code and tests; they are not simulated
UI. Complete in this table does not mean the hosted product or autonomous
learning vision is complete. The prioritized remaining work and its acceptance
criteria live in [`EXECUTION_BACKLOG.md`](./EXECUTION_BACKLOG.md).

## Critical Path

| Area | Status | Implemented boundary |
| --- | --- | --- |
| Real harness capture | Complete | Loopback-authenticated Claude Code, Codex, and Hermes lifecycle/tool ingestion with a durable spool and diagnostics |
| Capture integrity | Complete | Source normalization, orphan finalization, repository mutation tracking, verification invalidation, private incremental transcript deltas, and causal event/artifact/turn links |
| Historical corpus | Complete | Streaming Claude/Codex import, stable project/run/segment identity, encrypted redacted vaults, and idempotent canonical metadata |
| Fleet | Complete | Authenticated sensor events, replayed session state, freshness, and timeout-gated recovery planning; no simulated mutation route |
| Trajectories | Complete | Empirical steps, configurable periodic reasoning-tree snapshots, verified/success/failure/unknown final runs, shared semantic task trees, additive branch merge, divergence, and coverage |
| Memory formation | Complete | Transcript and live candidates, conservative evidence-gated promotion, repeated-evidence consolidation, revision, forgetting, and project scope |
| Agent access | Complete | Authenticated HTTP/SSE client plus MCP search, cited context, checkpoint, proposal, and feedback tools for any compatible harness |
| Feedback | Complete | Immutable recalled/helpful/unhelpful/superseded signals tied to memory, task, query, session, and actor context |
| Authorization | Complete | Organization/workspace/space/creator checks plus independently least-privilege credential capabilities on every route family |
| Operations | Complete | Persistent macOS services, AES-256-GCM vault keys, verified exports, raw-hook retention, PostgreSQL backup and restore-check scripts |
| Operator UI | Complete | Live fleet, history, memory review/feedback, trajectory evidence, reasoning, steering, raw event, and projected-state views |
| Capture privacy | Complete | Mandatory secret redaction, optional stable pseudonymous/strict anonymization, separate exposed/opaque reasoning controls, and a dedicated local operator settings credential |
| Multi-tenant application boundary | Complete | Organization routes and memberships, tenant-keyed storage/workers/vectors/caches, forced PostgreSQL RLS, repository enrollment, and audited platform reads |
| External identity | Complete | Clerk browser sessions, organization switching, signed idempotent membership provisioning, scoped API-key/M2M administration, role ceilings, and fail-closed revocation |

## Deployment Choices

These are environment-specific integrations, not missing simulated product
features:

1. Select and operate a real embedding service before enabling pgvector ranking;
   deterministic lexical BM25 remains the complete default.
2. Configure Clerk production keys, authorized parties, the implemented signed
   tenant webhook, TLS, and distributed rate limiting before exposing
   the API outside a trusted local network.
3. Schedule the supplied PostgreSQL backup and disposable restore verification,
   retain an encrypted off-host copy, and monitor failure/age.
4. Provision one scoped sensor or harness credential per remote machine or agent
   identity; do not share the local operator token.
5. Add a manual project merge/split workflow only when real ambiguous identities
   appear. The stored resolution state already preserves that uncertainty.
6. Before public hosting, complete the production gate in `MULTI_TENANCY.md`:
   automated identity provisioning, non-bypass database role, remote
   artifact/KMS namespacing, quarantine provisioning, and topology-level
   restore/isolation drills.

## Active Execution

The remaining execution order is:

1. let normal capture reach at least 50 finalized evaluation units and run a
   controlled same-task comparison across two materially different models;
2. deploy real reasoning and optional embedding providers, then validate live
   cited cognition and retrieval feedback;
3. configure and drill the hosted PostgreSQL, Clerk, TLS, rate-limit,
   quarantine, backup, monitoring, object-storage, and KMS topology;
4. select the project license before publishing packages or accepting reusable
   third-party contributions.

Progress must be updated in `EXECUTION_BACKLOG.md`; the absence of source-code
`TODO` comments is not evidence that these milestones are complete.
