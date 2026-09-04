import { mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  SessionStepStore,
  StateStore,
  TranscriptSnapshotStore,
  type CaptureSession,
  type CapturedStep,
} from "../src/index.js";

function session(root: string, steps: readonly CapturedStep[]): CaptureSession {
  return {
    sessionId: "long-session",
    source: "codex",
    agent: "codex",
    startedAt: "2026-09-04T00:00:00.000Z",
    project: { id: root, name: "project", root, branch: "main" },
    steps,
    finalized: false,
    active: true,
    lastSeenAt: "2026-09-04T00:00:00.000Z",
  };
}

function step(index: number): CapturedStep {
  return {
    id: `step-${index}`,
    stepNumber: index,
    nodeKind: index % 2 === 0 ? "action" : "observation",
    role: index % 2 === 0 ? "tool_call" : "tool_call_response",
    content: `Observed step ${index}`,
    artifactId: `artifact-${index}`,
    eventId: `event-${index}`,
  };
}

describe("capture persistence", () => {
  it("persists more than 2,000 ordered steps outside compact daemon state", async () => {
    const root = await mkdtemp(join(tmpdir(), "super-brain-capture-steps-"));
    const stateRoot = join(root, "state");
    const steps = Array.from({ length: 2_105 }, (_, index) => step(index + 1));
    const store = new SessionStepStore(stateRoot);
    const persisted = await store.synchronize(session(root, steps));
    expect(persisted.steps).toHaveLength(2_105);
    expect(persisted.stepCount).toBe(2_105);

    const stateStore = new StateStore(stateRoot);
    await stateStore.save({
      version: 1,
      lastEventTime: 1,
      seenArtifacts: [],
      sessions: { "codex:long-session": persisted },
    });
    const serialized = await readFile(join(stateRoot, "state.json"), "utf8");
    expect(serialized).not.toContain("Observed step 2105");
    expect(serialized.length).toBeLessThan(2_000);

    const checkpoint = (await stateStore.load()).sessions["codex:long-session"]!;
    expect(checkpoint.steps).toEqual([]);
    expect(checkpoint.stepCount).toBe(2_105);
    const hydrated = await new SessionStepStore(stateRoot).synchronize(checkpoint);
    expect(hydrated.steps).toHaveLength(2_105);
    expect(hydrated.steps.at(-1)).toMatchObject({ id: "step-2105", stepNumber: 2_105 });
  });

  it("deduplicates a retried captured step by its evidence identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "super-brain-capture-step-retry-"));
    const store = new SessionStepStore(join(root, "state"));
    const original = await store.synchronize(session(root, [step(1)]));
    const retried = await store.synchronize({
      ...original,
      steps: [...original.steps, { ...step(1), id: "step-2", stepNumber: 2 }, step(2)],
    });
    expect(retried.steps).toHaveLength(2);
    expect(retried.steps.map(({ id, stepNumber }) => ({ id, stepNumber }))).toEqual([
      { id: "step-1", stepNumber: 1 },
      { id: "step-2", stepNumber: 2 },
    ]);
  });

  it("owns a redacted transcript snapshot after the harness source disappears", async () => {
    const root = await mkdtemp(join(tmpdir(), "super-brain-capture-transcript-snapshot-"));
    const source = join(root, "01a06910-6c0e-7e93-a94c-7dfc2c3830be.jsonl");
    await writeFile(source, `${JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "token=sk-abcdefghijklmnopqrst" }],
      },
    })}\n${JSON.stringify({
      type: "response_item",
      payload: { type: "reasoning", summary: "private reasoning" },
    })}\n`, "utf8");
    const snapshots = new TranscriptSnapshotStore(join(root, "state"), {
      reasoningPolicy: "exclude",
    });
    const snapshot = await snapshots.store("codex", source);
    await unlink(source);
    const stored = await readFile(snapshot, "utf8");
    expect(stored).toContain("[REDACTED]");
    expect(stored).not.toContain("sk-abcdefghijklmnopqrst");
    expect(stored).not.toContain("private reasoning");
    await snapshots.complete(snapshot);
    await expect(readFile(snapshot, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
