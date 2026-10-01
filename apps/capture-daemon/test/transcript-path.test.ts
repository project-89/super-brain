import { mkdtemp, mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { locateTranscript } from "../src/transcript-path.js";
import { DurableSpool, TranscriptSnapshotStore } from "../src/storage.js";

const id = "01a06ea8-b61d-7c11-af0d-1fc3dc02779d";
const name = `rollout-2026-09-04T16-02-25-${id}.jsonl`;
async function fixture(identity = id) {
  const root = await mkdtemp(join(tmpdir(), "capture-relocation-"));
  const archived = join(root, "archived_sessions");
  await mkdir(archived);
  const moved = join(archived, name);
  await writeFile(moved, JSON.stringify({ type: "session_meta", payload: { id: identity } }) + "\n");
  return { root, moved, original: join(root, "sessions", "2026", "09", "04", name) };
}

describe("native transcript relocation", () => {
  it("locates an archived native identity and keeps a private durable snapshot", async () => {
    const f = await fixture();
    expect(await locateTranscript("codex", f.original, id)).toBe(f.moved);
    const snapshots = new TranscriptSnapshotStore(join(f.root, "state"));
    const path = await snapshots.store("codex", f.original, id);
    await unlink(f.moved);
    expect(await readFile(path, "utf8")).toContain(id);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("never trusts a matching filename with a different native identity", async () => {
    const f = await fixture("wrong-run");
    await expect(locateTranscript("codex", f.original, id)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects ambiguous duplicate transcripts instead of choosing one", async () => {
    const f = await fixture();
    await mkdir(join(f.root, "sessions"));
    await writeFile(join(f.root, "sessions", name), await readFile(f.moved));
    await expect(locateTranscript("codex", f.original, id)).rejects.toThrow("multiple Codex transcripts");
  });

  it("does not relocate other harnesses or infer identities from arbitrary filenames", async () => {
    const f = await fixture();
    await expect(locateTranscript("claude-code", f.original, id)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(locateTranscript("codex", join(f.root, "sessions", "unknown.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("previews recovery without changing failed jobs, then retains an audit receipt", async () => {
    const f = await fixture();
    const state = join(f.root, "state");
    const spool = new DurableSpool(state);
    const snapshots = new TranscriptSnapshotStore(state);
    await spool.enqueue({ version: 1, kind: "transcript", id: "archived-job", createdAt: new Date(0).toISOString(),
      notBefore: new Date(0).toISOString(), deadlineAt: new Date(0).toISOString(), source: "codex", path: f.original });
    const pending = (await spool.list())[0]!;
    await spool.reject(pending.path, "ENOENT");
    expect(await spool.recoverFailedTranscripts(snapshots)).toMatchObject({ matched: 1, recovered: 0, unavailable: 0,
      jobs: [{ id: "archived-job", status: "recoverable" }] });
    expect(await spool.snapshot()).toMatchObject({ pendingJobs: 0, failedJobs: 1 });
    expect(await spool.recoverFailedTranscripts(snapshots, true)).toMatchObject({ recovered: 1 });
    expect(await spool.snapshot()).toMatchObject({ pendingJobs: 1, failedJobs: 0 });
    const retry = (await spool.list())[0]!.job;
    expect(retry).toMatchObject({ ownedSnapshot: true, originalPath: f.original });
    if (retry.kind !== "transcript") throw new Error("expected transcript");
    expect(Date.parse(retry.deadlineAt)).toBeGreaterThan(Date.now());
    expect(await readdir(join(state, "spool", "resolved"))).toContain("archived-job.json.recovery.json");
  });

  it("reports unavailable source data without clearing its failed-job evidence", async () => {
    const f = await fixture();
    await unlink(f.moved);
    const spool = new DurableSpool(join(f.root, "state"));
    await spool.enqueue({ version: 1, kind: "transcript", id: "lost-job", createdAt: new Date(0).toISOString(),
      notBefore: new Date(0).toISOString(), deadlineAt: new Date(0).toISOString(), source: "codex", path: f.original });
    await spool.reject((await spool.list())[0]!.path, "ENOENT");
    expect(await spool.recoverFailedTranscripts(new TranscriptSnapshotStore(join(f.root, "state")), true))
      .toMatchObject({ recovered: 0, unavailable: 1, jobs: [{ status: "unavailable" }] });
    expect(await spool.snapshot()).toMatchObject({ pendingJobs: 0, failedJobs: 1 });
  });
});
