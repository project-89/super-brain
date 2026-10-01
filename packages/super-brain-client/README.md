# Super Brain client

Harness-neutral client for authenticated Fold ingestion, project-aware memory recall, memory-candidate review, trajectory delivery, resumable SSE consumption, and durable consumer offsets.

`synthesizeEpisodeWindow` prepares a cited proposal without publishing it, using
up to 200 authorized canonical event IDs and a 210-second request deadline.
`publishEpisodeWindow` persists its exact versioned input with source and revision
checks; changing a retry's content returns a conflict. `workEpisode`,
`episodeWindow`, and `episodePage` expose current authorized records and paged
history/evidence. Evidence pages contain one complete source event with a cursor,
while episode/window lists default to 100. These are proposed interpretations,
never verified conclusions.
Source changes or forgetting withhold affected derived records (404 on detail);
page coverage is explicitly `authorized-current-only`, not all historical work.

JSON requests have a 30-second deadline, including response-body reads. Explicit
transcript catalog deadlines and reasoning deadlines override that default;
reasoning defaults to 60 seconds. Cancellation signals remain honored, timers
and listeners are released after completion, and long-lived SSE is unchanged.

```ts
import { SuperBrainClient } from "@_89/super-brain-client";

const brain = new SuperBrainClient({
  baseUrl: process.env.SUPER_BRAIN_URL!,
  organizationId: process.env.SUPER_BRAIN_ORGANIZATION!,
  workspaceId: process.env.SUPER_BRAIN_WORKSPACE!,
  token: process.env.SUPER_BRAIN_TOKEN!,
});

await brain.consumeEvents({
  consumerId: "hermes-memory-observer-v1",
  replay: "all",
  kinds: ["transcript.chunk", "memory.recorded"],
  async onEvent({ entry }) {
    // The offset advances only after this handler completes.
    console.log(entry.event.id);
  },
});
```

Each harness gets its own bearer credential and consumer ID. Stored offsets are scoped by authenticated principal, so two agents cannot overwrite each other's progress even when they use the same display ID.

## Shared transport and feedback

All workspace reads and mutations use `SuperBrainClient`. `token` accepts a string or an async `TokenSupplier(signal)` and is evaluated for every request and stream reconnect. `signal` and `timeoutMs` can be configured on the client; request overrides also apply to token acquisition and response body consumption. Transport failures are `SuperBrainApiError` with `code`, `status`, `retryable`, `terminal`, and optional `retryAfterMs`. `aborted` preserves cancelled work, `token_unavailable` means credentials must become available, and `feedback_subject_changed` means a queued batch belongs to another account and must remain in its original partition.

`session()` discovers authenticated memberships before selecting a workspace. An empty workspace ID is allowed for this route; workspace operations require one. `identity()` returns current roles, capabilities, and task evidence authority for interface guidance; server authorization remains authoritative. Read pages include stable cursors: `listEventsPage`, `recallMemoryPage`, `listMemoryCandidatePage`, `listTranscriptRunPage`, and `listTrajectoryTaskPage`. Trajectory report continuation uses `runCursor`.

`recallMemoryPacket`, `rankMemories`, and `askReasoning` return server-derived `provenance`: the actual requesting principal/workspace/organization, a recall ID, exact memory revisions, returned ranks, and ranking/provider identity. The ordinary `recallMemories` convenience preserves this same envelope. These labels describe the read; copied client feedback metadata is still actor reported.

New feedback writes require `MemoryFeedbackInputV2`, including `version: 2`, exact `memoryRevision` (zero is valid), `recallId`, and a distinct `offered`, `injected`, `used`, `judged`, or `outcome` signal. Only `judged` takes a judgment; `outcome` requires a canonical task outcome reference. Task/attempt IDs must resolve to compatible authorized canonical manifests in the memory's audience and space. Use session context when no canonical task exists. Historical revisions can be judged after correction while current access and deletion still govern availability.

Optional `telemetryOutbox` queues only offered telemetry after a successful read. Successful reads do not await enqueue or delivery. Enqueue failures remain visible through `telemetryStatus()`; durable delivery begins only after the adapter acknowledges persistence. No query text, reasoning question, token, or credential is added to automatic telemetry. Adapters own bounded storage, retries, account partitioning, and repair controls; they must call `recordMemoryFeedbackBatch(items, { stamp, expectedSubject, signal?, timeoutMs? })` with stable batch and item stamps. The server checks `expectedSubject` against the same request's authenticated account, closing account switches between identity checks and dispatch. Explicit judgments/use reports await their own result and never run as a side effect of receipt alone.

Mutation options preserve stamps across retries. Corrections should additionally pass the displayed `expectedRevision`; a stale editor receives conflict and must refresh before making a new correction. Retrying an already committed identical command still returns its original receipt.

`selectEvaluationSources(request, RequestOptions?)` preserves exact reviewed source refs and the original authenticated `expectedSubject`. The API returns eligible local snapshots and explicit exclusions; `evaluation_subject_changed` requires a new selection for the current account. Keep the returned subject privately, and apply the [selected evaluation contract](../../docs/PHASE5_SELECTED_EVALUATION_CONTRACTS.md) before creating a reviewable bundle.

`eventStream` and `consumeEvents` use ingestion order. Streamed events carry v2 delivery
cursors (`{version:2,sequence}`, decimal-string BIGINT) separate from source timestamps;
`after` also accepts the equivalent `{kind:"ingestion",sequence}` cursor. `consumeEvents` refuses a legacy cursor
until the operator calls `ingestionConsumerStatus` to preview and explicitly calls
`migrateConsumerCursor` to replay all. Migration retains the old offset and is
idempotent. There is no safe timestamp-to-ingestion conversion; handlers must tolerate
replayed event IDs. Unsupported stores fail explicitly, not with source-order fallback.
Fresh tail and replay-all consumers persist their initial boundary before processing,
so reconnecting before the first successful callback cannot advance to a new tail.

`checkpointEvery` defaults to 1 and accepts at most 100. Batched consumers must make
each callback durable/idempotent before returning. Successful partial batches flush
every second and on stream end, callback failure, or cancellation. Checkpoint writes
are serialized; a failed callback is never acknowledged, and a crash can replay at
most the unacknowledged batch. Filter changes require a new consumer/replay when
previously excluded events are needed. `consumerCursor`/`commitConsumerCursor` remain
legacy source-order compatibility methods and are not used by `consumeEvents`.

`resetConsumerCursor(consumerId, expectedCursor, reason, filters)` is an explicit
administrative repair for an already-migrated consumer. Stop all instances first,
preview the current status, and supply that exact cursor plus a 10-2000 character
reason. The server atomically records the reset and starts replay at 0, or rejects
a stale expectation. It does not delete events, receipts, or existing jobs.

`listEvents` reads descending indexed cursor pages of at most 100 events, then returns canonical ascending order. Its optional limit retains the latest N events, including deterministic event-ID ordering at timestamp boundaries. Requests retain authorization and kind filters on every page; malformed or repeated cursors fail rather than silently returning an incomplete catalog. The returned array is still aggregated in client memory, so large ongoing streams should use `consumeEvents`.
