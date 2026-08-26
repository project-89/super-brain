import { describe, expect, it } from "vitest";

import {
  FoldSdk,
  type FoldSdkSteeringContext,
} from "../src/index.js";
import { access, MemoryStore, stamp } from "./helpers.js";

function context(actorId = "agent-a"): FoldSdkSteeringContext {
  const currentAccess = access({ workspaceRole: "owner" });
  return {
    access: currentAccess,
    actorId,
    author: { kind: "human", id: currentAccess.principalId },
    capture: {
      scope: { workspace: currentAccess.workspaceId },
      identity: { actor: actorId },
    },
  };
}

const candidate = {
  id: "candidate-a",
  sourceDriveId: "delivery",
  satisfier: { kind: "task", ref: "verify-ranked-recall" },
  aim: "Verify ranked recall before rollout",
  trigger: { kind: "threshold" },
} as const;

describe("SDK human steering API", () => {
  it("surfaces, commits, acts on, and ends an intention through canonical replay", async () => {
    const store = new MemoryStore();
    const sdk = new FoldSdk(store);

    const surfaced = await sdk.surfaceIntentionCandidate(context(), stamp("event-a", 100), candidate);
    expect(surfaced.steering.pendingCandidates).toEqual([
      expect.objectContaining({ id: "candidate-a", surfacedAtMs: 100 }),
    ]);

    const committed = await sdk.commitIntentionCandidate(
      context(),
      stamp("event-b", 110),
      candidate.id,
      "intention-a",
      ["event-a"],
    );
    expect(committed.steering).toMatchObject({
      pendingCandidates: [],
      intentions: [{ id: "intention-a", attempts: 0, fromCandidateId: "candidate-a" }],
    });

    const acted = await sdk.recordIntentionAction(
      context(),
      stamp("event-c", 120),
      "intention-a",
    );
    expect(acted.steering.intentions[0]?.attempts).toBe(1);

    const ended = await sdk.endIntention(
      context(),
      stamp("event-d", 130),
      "intention-a",
      { kind: "satisfied" },
    );
    expect(ended.steering.intentions).toEqual([]);
    expect((await sdk.steeringSnapshots(access()))[0]).toMatchObject({ actorId: "agent-a" });
    expect(store.entries.map(({ event }) => event.kind)).toEqual([
      "intention.surfaced",
      "intention.committed",
      "intention.acted",
      "intention.ended",
    ]);
  });

  it("declines a pending candidate with a durable reason", async () => {
    const sdk = new FoldSdk(new MemoryStore());
    await sdk.surfaceIntentionCandidate(context(), stamp("event-a", 100), candidate);
    const result = await sdk.declineIntentionCandidate(
      context(),
      stamp("event-b", 110),
      candidate.id,
      "outside the current release",
    );
    expect(result.steering.pendingCandidates).toEqual([]);
    expect(result.steering.recentDeclines).toEqual([
      expect.objectContaining({
        reason: "outside the current release",
        candidate: expect.objectContaining(candidate),
      }),
    ]);
  });

  it("does not append invalid lifecycle transitions", async () => {
    const store = new MemoryStore();
    const sdk = new FoldSdk(store);
    await expect(
      sdk.commitIntentionCandidate(
        context(),
        stamp("event-a", 100),
        "missing-candidate",
        "intention-a",
      ),
    ).rejects.toThrow(/unknown candidate/);
    expect(store.entries).toEqual([]);
  });
});
