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

`eventStream` and `consumeEvents` use ingestion order, with decimal-string BIGINT
cursors separate from source timestamps. `consumeEvents` refuses a legacy cursor
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
