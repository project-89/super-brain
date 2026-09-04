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
