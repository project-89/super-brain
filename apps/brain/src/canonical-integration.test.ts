import { afterEach, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import type { AddressInfo } from "node:net";
import { FoldSdk } from "../../../packages/fold-sdk/dist/index.js";
import { StaticIdentityDirectory, createApiServer } from "../../api/dist/index.js";
import type { FoldLogEntry } from "@_89/fold";
import { SuperBrainClient } from "@_89/super-brain-client";
import { FoldApiClient } from "./api";
import { BrowserTelemetryOutbox } from "./telemetry-outbox";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const entries: FoldLogEntry[] = [];
  const sdk = new FoldSdk({ async read() { return { entries: [...entries] }; }, async append(entry) { entries.push(entry); } });
  const directory = new StaticIdentityDirectory({ alice: { principalId: "alice", workspaces: { workspace: { role: "admin" } } }, bob: { principalId: "bob", workspaces: { workspace: { role: "admin" } } }, reader: { principalId: "reader", capabilities: ["memories:read"], workspaces: { workspace: { role: "member" } } } });
  const server = createApiServer({ authenticator: directory, memberships: directory, sdks: { sdkFor: async () => sdk } });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise((resolve) => server.close(() => resolve())));
  const settings = { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, organizationId: "local", workspaceId: "workspace", token: "alice", captureBaseUrl: "", captureOperatorToken: "" };
  const client = new SuperBrainClient(settings);
  const { memory } = await client.recordMemory({ audience: "workspace", source: "integration", summary: "Keep exact revision evidence", content: "original", applicability: { kind: "global" } });
  return { settings, client, memory, entries };
}
it("carries actual inventory provenance across separate snapshot/action adapters and refuses a changed account", async () => {
  const { settings, memory, entries } = await fixture(); let token = "alice";
  const snapshot = await new FoldApiClient(settings).recallMemoryPage({ includeNeedsReview: true });
  const shown = snapshot.items.find((item) => item.memory.id === memory.id)!;
  expect(shown.presentation?.subject.principalId).toBe("alice"); expect(shown.memory.revision).toBe(0);
  const actions = new FoldApiClient({ ...settings, tokenSupplier: async () => token });
  token = "bob"; await expect(actions.recordMemoryFeedback(shown.memory, "helpful", shown.presentation)).rejects.toMatchObject({ code: "feedback_subject_changed" });
  expect(entries.filter(({ event }) => event.kind === "memory.feedback-recorded")).toHaveLength(0);
  token = "alice"; const different = { ...shown.presentation!, recallId: "a-new-recall-must-not-replace-pending-command" };
  await actions.recordMemoryFeedback(shown.memory, "helpful", different);
  const feedback = entries.find(({ event }) => event.kind === "memory.feedback-recorded")!.event.changes[0];
  expect(feedback.verb === "create" && feedback.after).toMatchObject({ actorId: "alice", memoryRevision: 0, recallId: shown.presentation!.recallId });
});
it("allows a judgment of the displayed historical revision after correction, and rejects stale edits", async () => {
  const { settings, client, memory } = await fixture(); const adapter = new FoldApiClient(settings);
  const shown = (await adapter.recallMemoryPage()).items[0]!;
  await client.reviseMemory(memory.id, { content: "corrected" }, undefined, { expectedRevision: 0 });
  await adapter.recordMemoryFeedback(shown.memory, "unhelpful", shown.presentation);
  expect(await client.memoryFeedbackSummary(memory.id, 0)).toMatchObject({ memoryRevision: 0, unhelpful: 1 });
  expect(await client.memoryFeedbackSummary(memory.id, 1)).toMatchObject({ memoryRevision: 1, unhelpful: 0 });
  await expect(adapter.reviseMemory(memory.id, { audience: "workspace", source: memory.source, projectIds: [], summary: memory.summary, content: "stale overwrite", tags: [], expectedRevision: 0 })).rejects.toMatchObject({ status: 409 });
  expect((await client.memoryById(memory.id))?.content).toBe("corrected");
});
it("returns a read-only inventory despite forbidden optional feedback and exposes the denied durable batch", async () => {
  const { settings } = await fixture(); const client = new SuperBrainClient({ ...settings, token: "reader" });
  const outbox = new BrowserTelemetryOutbox({ indexedDB: new IDBFactory(), subject: async () => client.identity(), deliver: (batch, signal) => client.recordMemoryFeedbackBatch(batch.items, { stamp: batch.stamp, expectedSubject: batch.subject, signal }) });
  cleanups.push(() => outbox.close());
  const adapter = new FoldApiClient({ ...settings, token: "reader", telemetryOutbox: outbox });
  const result = await adapter.recallMemoryPage(); expect(result.items).toHaveLength(1);
  await vi.waitFor(async () => expect((await outbox.status()).pending).toBe(1));
  await outbox.flush(); expect(await outbox.status()).toMatchObject({ denied: 1 });
});
