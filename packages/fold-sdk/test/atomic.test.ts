import { describe, expect, it } from "vitest";
import type { FoldLogEntry } from "@_89/fold";
import { FoldSdk, FoldSdkConflictError, type FoldCommandReceipt, type FoldCommitOptions, type FoldSdkStore } from "../src/index.js";
import { access, event } from "./helpers.js";

class AtomicStore implements FoldSdkStore {
  entries: FoldLogEntry[] = [];
  receipts = new Map<string, FoldCommandReceipt>();
  beforeCommit: (() => void) | undefined;
  revisionCalls = 0;
  async read() { return { entries: [...this.entries], revision: String(this.entries.length) }; }
  async append(entry: FoldLogEntry) { this.entries.push(entry); }
  async revision() { this.revisionCalls += 1; return String(this.entries.length); }
  async commandReceipt(id: string) { return this.receipts.get(id); }
  async commit(entries: readonly FoldLogEntry[], options: FoldCommitOptions) {
    const prior = this.receipts.get(options.command.commandId);
    if (prior !== undefined) return prior;
    this.beforeCommit?.(); this.beforeCommit = undefined;
    if (options.expectedRevision !== String(this.entries.length)) throw Object.assign(new Error("changed"), { code: "revision_conflict" });
    this.entries.push(...entries);
    const receipt = { ...options.command, entries, revision: String(this.entries.length) };
    this.receipts.set(receipt.commandId, receipt);
    return receipt;
  }
}

describe("atomic SDK command boundary", () => {
  it("revalidates a pinned snapshot after a second writer commits and never stamps a partial cache", async () => {
    const store = new AtomicStore();
    const sdk = new FoldSdk(store);
    store.beforeCommit = () => store.entries.push({ event: event({ id: "other", t: 0 }), status: "canon" });
    await sdk.append(access(), event({ id: "own", t: 1 }));
    expect((await sdk.listEntries(access())).map(({ event }) => event.id)).toEqual(["other", "own"]);
    expect(store.revisionCalls).toBe(0);
  });

  it("replays an exact persisted result across instances and role refreshes; rejects changed input", async () => {
    const store = new AtomicStore();
    const first = new FoldSdk(store);
    const original = event({ id: "same", t: 1 });
    const result = await first.append(access(), original);
    const second = new FoldSdk(store);
    expect(await second.append(access({ workspaceRole: "admin" }), original)).toEqual(result);
    expect(store.entries).toHaveLength(1);
    await expect(second.append(access(), { ...original, title: "changed" })).rejects.toBeInstanceOf(FoldSdkConflictError);
  });

  it("keeps failed domain construction out of the log and clears staged state", async () => {
    const store = new AtomicStore();
    const sdk = new FoldSdk(store);
    await expect(sdk.append(access(), event({ id: "denied", t: 1, creatorId: "somebody-else" }))).rejects.toThrow();
    expect(store.entries).toHaveLength(0);
    await sdk.append(access(), event({ id: "accepted", t: 2 }));
    expect(store.entries).toHaveLength(1);
  });
});
