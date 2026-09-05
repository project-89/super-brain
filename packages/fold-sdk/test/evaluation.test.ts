import { describe, expect, it } from "vitest";
import { FoldSdk, type EvaluationSourceSelectionRequest } from "../src/index.js";
import { MEMORY_A, MEMORY_B, MemoryStore, access, memoryContext, stamp } from "./helpers.js";

const ref = { kind: "memory" as const, memoryId: MEMORY_A, revision: 0 };
const subject = { organizationId: "org", workspaceId: "workspace-1", principalId: "user-a" };
const request = (overrides: Partial<EvaluationSourceSelectionRequest> = {}): EvaluationSourceSelectionRequest => ({ selectionId: "selected-v1", audience: "local-reviewed", redactionVersion: "review-v1", expectedSubject: subject, references: [ref], reviewedReferences: [ref], ...overrides });
const context = () => { const value = memoryContext(); return { ...value, access: { ...value.access, organizationId: "org" } }; };

describe("selected evaluation source eligibility", () => {
  it("requires exact reviewed current revisions and excludes private unavailable/forgotten sources uniformly", async () => {
    const sdk = new FoldSdk(new MemoryStore()); const ctx = context();
    await sdk.recordMemory(ctx, stamp("record", 100), { id: MEMORY_A, source: "synthetic", summary: "Public lesson", applicability: { kind: "global" } });
    expect((await sdk.selectEvaluationSources(ctx.access, request({ reviewedReferences: [] }))).excluded).toEqual([{ reference: ref, reason: "unreviewed" }]);
    const selected = await sdk.selectEvaluationSources(ctx.access, request());
    expect(selected.eligible[0]).toMatchObject({ reference: ref, eligibility: "current-authorized", snapshot: { summary: "Public lesson", revision: 0 } });
    expect(JSON.stringify(selected.eligible)).not.toMatch(/creatorId|workspaceId|principalId/);
    const deniedAccess = { ...access({ principalId: "other" }), organizationId: "org" };
    expect((await sdk.selectEvaluationSources(deniedAccess, request({ expectedSubject: { ...subject, principalId: "other" } }))).excluded[0]?.reason).toBe("unavailable-or-denied");
    await sdk.reviseMemory(ctx, stamp("revise", 200), MEMORY_A, { summary: "Changed" });
    expect((await sdk.selectEvaluationSources(ctx.access, request())).excluded[0]?.reason).toBe("stale-revision");
    await sdk.forgetMemory(ctx, stamp("forget", 300), MEMORY_A, "removed");
    expect((await sdk.selectEvaluationSources(ctx.access, request())).excluded[0]?.reason).toBe("unavailable-or-denied");
  });

  it("excludes unresolved and transitively stale sources, and enforces the actual account", async () => {
    const sdk = new FoldSdk(new MemoryStore()); const ctx = context();
    await sdk.recordMemory(ctx, stamp("unresolved", 100), { id: MEMORY_A, source: "synthetic" });
    expect((await sdk.selectEvaluationSources(ctx.access, request())).excluded[0]?.reason).toBe("needs-review");
    await expect(sdk.selectEvaluationSources(ctx.access, request({ expectedSubject: { ...subject, principalId: "other" } }))).rejects.toThrow(/subject changed/);
    await expect(sdk.selectEvaluationSources({ ...ctx.access, platformDataAccess: true }, request())).rejects.toThrow(/platform/);
    await sdk.reviseMemory(ctx, stamp("resolved", 200), MEMORY_A, { applicability: { kind: "global" } });
    await sdk.recordMemory(ctx, stamp("derived", 300), { id: MEMORY_B, source: "synthetic", applicability: { kind: "global" }, sourceMemoryRefs: [{ memoryId: MEMORY_A, revision: 1 }] });
    await sdk.reviseMemory(ctx, stamp("changed-source", 400), MEMORY_A, { summary: "Corrected" });
    const derived = { kind: "memory" as const, memoryId: MEMORY_B, revision: 0 };
    expect((await sdk.selectEvaluationSources(ctx.access, request({ references: [derived], reviewedReferences: [derived] }))).excluded[0]?.reason).toBe("needs-review");
  });

  it("selects immutable task/attempt records through current scope and exact dependent memory revisions", async () => {
    const sdk = new FoldSdk(new MemoryStore()); const ctx = context();
    const taskContext = { ...ctx, capture: { ...ctx.capture, scope: { workspace: ctx.access.workspaceId } } };
    await sdk.recordMemory(taskContext, stamp("memory", 100), { id: MEMORY_A, audience: "workspace", source: "synthetic", applicability: { kind: "global" } });
    await sdk.recordTaskManifest(taskContext, stamp("task", 110), { version: 1, taskId: "task-a", taskVersion: "v1", inputs: [] });
    await sdk.recordAttemptManifest(taskContext, stamp("attempt", 120), { version: 1, taskId: "task-a", taskVersion: "v1", attemptId: "attempt-a", startRevision: { fingerprintStatus: "available", revisionId: "r0" }, context: { memoryRefs: [{ memoryId: MEMORY_A, revision: 0 }] } });
    const references = [{ kind: "event" as const, eventId: "task" }, { kind: "event" as const, eventId: "attempt" }];
    const selected = await sdk.selectEvaluationSources(ctx.access, request({ references, reviewedReferences: references }));
    expect(selected.eligible).toHaveLength(2);
    await sdk.reviseMemory(taskContext, stamp("memory-changed", 200), MEMORY_A, { summary: "Changed" });
    const revised = await sdk.selectEvaluationSources(ctx.access, request({ references, reviewedReferences: references }));
    expect(revised.eligible).toHaveLength(1); expect(revised.excluded).toEqual([{ reference: references[1], reason: "stale-revision" }]);
    await expect(sdk.selectEvaluationSources(ctx.access, request({ references: [ref, ref] }))).rejects.toThrow(/distinct/);
  });

  it("excludes scoped and orphaned canonical evidence without exporting an incomplete dependency join", async () => {
    const store = new MemoryStore(); const sdk = new FoldSdk(store); const ctx = context();
    const taskContext = {...ctx,access:{...ctx.access,spaceRoles:{"private-space":"writer" as const}},capture:{...ctx.capture,scope:{workspace:ctx.access.workspaceId,space:"private-space"}}};
    await sdk.recordTaskManifest(taskContext,stamp("private-task",100),{version:1,taskId:"task",taskVersion:"v1"});
    await sdk.recordAttemptManifest(taskContext,stamp("private-attempt",110),{version:1,taskId:"task",taskVersion:"v1",attemptId:"attempt",startRevision:{fingerprintStatus:"available",revisionId:"r0"}});
    const reference = {kind:"event" as const,eventId:"private-attempt"};
    const selection = request({references:[reference],reviewedReferences:[reference]});
    expect((await sdk.selectEvaluationSources(ctx.access,selection)).excluded).toEqual([{reference,reason:"unavailable-or-denied"}]);
    expect((await sdk.selectEvaluationSources(taskContext.access,selection)).eligible).toHaveLength(1);
    // An incomplete imported journal must fail closed as well, even if the remaining event is readable.
    store.entries.splice(store.entries.findIndex(({event})=>event.id==="private-task"),1);
    expect((await sdk.selectEvaluationSources(taskContext.access,selection)).excluded).toEqual([{reference,reason:"unavailable-or-denied"}]);
  });
});
