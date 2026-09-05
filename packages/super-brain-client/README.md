# Super Brain client

Harness-neutral client for authenticated Fold ingestion, project-aware memory recall, memory-candidate review, trajectory delivery, resumable SSE consumption, and durable consumer offsets.

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
