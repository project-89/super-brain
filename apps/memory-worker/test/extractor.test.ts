import { describe, expect, it } from "vitest";
import type { FoldEvent } from "@_89/fold";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encryptVaultLine } from "@_89/super-brain-importer";

import { extractLiveMemoryCandidates, extractMemoryCandidates, messagesFromVaultRecords, readVaultMessages } from "../src/index.js";

const run = {
  id: "claude-code:run-a",
  nativeId: "run-a",
  source: "claude-code" as const,
  artifactId: `artifact-${"a".repeat(64)}`,
  projectId: "project-a",
  projectResolution: "resolved" as const,
  startedAt: "2026-08-20T12:00:00.000Z",
  counts: { records: 2, turns: 1, messages: 2, actions: 0, unknown: 0 },
  segments: [{ id: "segment-a", ordinal: 0, projectId: "project-a", resolution: "resolved" as const, startedAt: "2026-08-20T12:00:00.000Z" }],
};

describe("transcript memory extraction", () => {
  it("extracts structured Claude-Mem observations with deterministic evidence", () => {
    const messages = messagesFromVaultRecords("claude-code", "run-a", [
      { type: "user", isMeta: true, message: { content: "Hello memory agent" } },
      { type: "assistant", timestamp: "2026-08-20T12:01:00.000Z", message: { id: "m1", content: [{ type: "text", text: "<observation><type>decision</type><title>Postgres is canonical</title><subtitle>Fold events use Postgres.</subtitle><facts><fact>Postgres stores canonical Fold events.</fact></facts><narrative>The journal remains a migration source.</n</narrative><concepts><concept>trade-off</concept></concepts></observation>" }] } },
    ]);
    const first = extractMemoryCandidates(run, "run-event", messages);
    const second = extractMemoryCandidates(run, "run-event", messages);
    expect(first).toEqual(second);
    expect(first[0]).toMatchObject({
      projectIds: ["project-a"],
      source: "claude-mem-observation",
      summary: "Postgres is canonical",
      tags: ["claude-mem", "decision", "trade-off"],
      evidence: [{ eventId: "run-event", runId: run.id, turnId: "claude-code:run-a:turn:0" }],
      confidence: 0.96,
    });
  });

  it("extracts explicit durable statements and ignores injected boilerplate", () => {
    const messages = messagesFromVaultRecords("codex", "run-a", [
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "You are Codex, a coding agent." }] } },
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn-a" } },
      { type: "response_item", timestamp: "2026-08-20T12:02:00.000Z", payload: { type: "message", id: "m1", role: "user", content: [{ type: "input_text", text: "We decided that Postgres must remain the canonical source of Fold events." }] } },
    ]);
    const candidates = extractMemoryCandidates({ ...run, source: "codex", id: "codex:run-a" }, "run-event", messages);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ summary: "We decided that Postgres must remain the canonical source of Fold events.", tags: ["durable-statement", "user"] });
  });

  it("carries an observed primary-session working directory into structured evidence", () => {
    const messages = messagesFromVaultRecords("claude-code", "observer-run", [
      {
        type: "user",
        isMeta: true,
        message: { content: "<observed_from_primary_session><working_directory>/Users/example/Workspaces/project-a</working_directory></observed_from_primary_session>" },
      },
      {
        type: "assistant",
        timestamp: "2026-08-20T12:01:00.000Z",
        message: { id: "m2", content: [{ type: "text", text: "<observation><type>decision</type><title>Use Postgres</title><narrative>Postgres is canonical.</n</narrative></observation>" }] },
      },
    ]);
    expect(messages[0]?.projectPath).toBe("/Users/example/Workspaces/project-a");
    const candidates = extractMemoryCandidates({ ...run, cwd: "/Users/example/.claude-mem/observer-sessions" }, "run-event", messages);
    expect(candidates[0]?.content).toMatchObject({ files: ["/Users/example/Workspaces/project-a"] });
  });

  it("extracts live reasoning checkpoints with event and turn evidence", () => {
    const event = {
      id: "019c0000-0000-7000-8000-000000000001",
      kind: "terminal.observation",
      at: { t: 1_787_000_000_000 },
      capture: {
        scope: { workspace: "workspace-a" },
        identity: {
          repo: "project-a",
          session: "session-a",
          turn: "turn-a",
          runtime: "codex",
          model: "gpt-5.6",
        },
      },
      changes: [{
        verb: "create",
        nodeKind: "x.fold.activity-observation",
        after: {
          observation: "reasoning_checkpoint",
          data: {
            summary: "Postgres remains canonical",
            hypothesis: "One durable event log avoids split truth.",
            evidence: "The projection rebuilds from the Fold log.",
            artifactId: "artifact-a",
            confidence: 0.91,
          },
        },
      }],
    } as unknown as FoldEvent;

    expect(extractLiveMemoryCandidates(event)).toEqual([expect.objectContaining({
      source: "live-reasoning-checkpoint",
      summary: "Postgres remains canonical",
      projectIds: ["project-a"],
      evidence: [{ eventId: event.id, projectId: "project-a", turnId: "turn-a" }],
      confidence: 0.91,
      content: expect.objectContaining({
        artifactId: "artifact-a",
        sessionId: "session-a",
        turnId: "turn-a",
        runtime: "codex",
      }),
    })]);
  });

  it("ignores ordinary terminal observations", () => {
    const event = {
      kind: "terminal.observation",
      capture: { identity: { repo: "project-a" } },
      changes: [{ verb: "create", nodeKind: "x.fold.activity-observation", after: { observation: "tool_result" } }],
    } as unknown as FoldEvent;
    expect(extractLiveMemoryCandidates(event)).toEqual([]);
  });

  it("reads authenticated encrypted vault artifacts", async () => {
    const vault = await mkdtemp(join(tmpdir(), "memory-worker-vault-"));
    const directory = join(vault, "claude-code", "aa");
    await mkdir(directory, { recursive: true });
    const key = new Uint8Array(32).fill(9);
    const record = JSON.stringify({
      type: "user",
      uuid: "message-a",
      timestamp: "2026-08-20T12:00:00.000Z",
      message: { content: "We decided that canonical evidence remains immutable." },
    });
    await writeFile(join(directory, `${"a".repeat(64)}.jsonl.enc`), `${encryptVaultLine(record, key)}\n`, "utf8");
    await expect(readVaultMessages(vault, run, key)).resolves.toEqual([
      expect.objectContaining({ text: "We decided that canonical evidence remains immutable." }),
    ]);
    await expect(readVaultMessages(vault, run, new Uint8Array(32))).rejects.toThrow(/authentication/);
  });
});

it("examines the whole long session and retains the final correction beyond the proposal budget", () => {
  const messages = Array.from({ length: 30 }, (_, index) => ({ role: "user" as const, turnId: `turn-${index}`,
    text: `We decided that deployment policy number ${index} must preserve explicit evidence.` }));
  messages.push({ role: "user", turnId: "turn-final", text: "We decided that the final correction must supersede the initial deployment assumption." });
  const candidates = extractMemoryCandidates(run, "run-event", messages, 2);
  expect(candidates).toHaveLength(31);
  expect(candidates.at(-1)?.summary).toContain("final correction");
});
