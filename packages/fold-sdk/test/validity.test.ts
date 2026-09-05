import { describe, expect, it } from "vitest";
import { makeMemoryCandidateEvidenceContributedEvent, rebuildMemories, type EpistemicEventContext } from "@_89/fold-epistemic";
import { FoldSdk } from "../src/index.js";
import { access, event, memoryContext, MemoryStore, stamp } from "./helpers.js";

const id = (n: number) => `01890f47-7c00-7000-8000-${n.toString().padStart(12, "0")}`;
const global = { kind: "global" } as const;
function context(principalId = "machine", spaceId?: string, role: "member" | "owner" = "member"): EpistemicEventContext {
  const base = memoryContext({ principalId, audience: "workspace", workspaceRole: role, ...(spaceId === undefined ? {} : { spaceId }) });
  return { ...base, author: { kind: "human", id: principalId }, access: { ...base.access, spaceRoles: spaceId === undefined ? {} : { [spaceId]: "writer" } } };
}
const input = (n: number) => ({ id: id(n), audience: "workspace" as const, source: "decision", applicability: global, summary: `Memory ${n}` });

describe("memory authority, evidence and validity", () => {
  it("lets scoped writers correct shared memory while preserving its creator and replay actor", async () => {
    const store = new MemoryStore(); const sdk = new FoldSdk(store);
    await sdk.recordMemory(context(), stamp("record", 1), input(1));
    const changed = await sdk.reviseMemory(context("human"), stamp("correction", 2), id(1), { summary: "Human correction" });
    expect(changed.memory).toMatchObject({ creatorId: "machine", revision: 1, summary: "Human correction" });
    expect(changed.event.capture.identity?.principal).toBe("human");
    expect(rebuildMemories(store.entries.map(({ event }) => event)).memories.get(id(1))?.creatorId).toBe("machine");
    const forgotten = await sdk.forgetMemory(context("human"), stamp("forget", 3), id(1), "obsolete");
    expect(forgotten.forgotten.creatorId).toBe("machine");
    await sdk.recordMemory(memoryContext(), stamp("private", 4), { id: id(2), source: "private", applicability: global });
    await expect(sdk.reviseMemory(memoryContext({ principalId: "other" }), stamp("forged", 5), id(2), { summary: "forged" })).rejects.toThrow();
    const scoped = context("machine", "space-a");
    await sdk.recordMemory(scoped, stamp("scoped", 6), { ...input(3), spaceId: "space-a" });
    const reader = { ...context("human", "space-a"), access: { ...context("human", "space-a").access, spaceRoles: { "space-a": "reader" as const } } };
    await expect(sdk.reviseMemory(reader, stamp("reader-change", 7), id(3), { summary: "denied" })).rejects.toThrow("writer");
    await expect(sdk.reviseMemory(context("human", "space-a"), stamp("writer-change", 8), id(3), { summary: "allowed" })).resolves.toMatchObject({ memory: { creatorId: "machine", revision: 1 } });
    await expect(sdk.reviseMemory(reader, stamp("writer-change", 8), id(3), { summary: "allowed" })).rejects.toThrow("writer");
  });

  it("retains more than 1000 candidate evidence references in an exact bounded acceptance snapshot", async () => {
    const store = new MemoryStore(); const sdk = new FoldSdk(store); const owner = context("reviewer", undefined, "owner");
    const evidence = Array.from({ length: 1002 }, (_, n) => ({ eventId: `source-${n}` }));
    store.entries.push(...evidence.map(({ eventId }, n) => ({ event: event({ id: eventId, t: n + 1 }), status: "canon" as const })));
    const proposed = await sdk.proposeMemoryCandidate(context(), stamp("proposal", 2000), { ...input(10), content: "Decision", summary: "Decision", evidence: evidence.slice(0, 100), confidence: 0.8, salience: 0.8, extractor: { kind: "rule", id: "rule", version: "2" } });
    for (let offset = 100; offset < 1001; offset += 100) await sdk.contributeMemoryCandidateEvidence(context("supporter"), stamp(`support-${offset}`, 2000 + offset), id(10), { evidence: evidence.slice(offset, Math.min(offset + 100, 1001)) });
    await expect(sdk.acceptMemoryCandidate(context("supporter"), stamp("unauthorized-review", 3100), stamp("unauthorized-memory", 3101), id(10), id(11))).rejects.toThrow("owner or admin");
    const accepted = await sdk.acceptMemoryCandidate(owner, stamp("accept", 3200), stamp("accepted-memory", 3201), id(10), id(11));
    expect(accepted.memory.evidence).toHaveLength(1001);
    expect(JSON.stringify(accepted.memoryEvent)).not.toContain('"eventId":"source-');
    expect(accepted.memory.sourceCandidate).toMatchObject({ candidateId: id(10), revision: 10, decisionEventId: "accept" });
    await expect(sdk.contributeMemoryCandidateEvidence(context(), stamp("too-late", 3300), id(10), { evidence: [evidence[1001]!] })).rejects.toThrow("pending");
    const late = makeMemoryCandidateEvidenceContributedEvent(context(), stamp("late-arrival", 2001), proposed.candidate, [evidence[1001]!]);
    await expect(sdk.append(context().access, late)).rejects.toThrow();
    const options = { evidence: [evidence[1001]!], expectedRevision: 0 };
    const contribution = await sdk.contributeMemoryEvidence(context("supporter"), stamp("memory-support", 3400), id(11), options);
    expect(contribution.memory).toMatchObject({ creatorId: "reviewer", revision: 1 });
    expect(contribution.memory.evidence).toHaveLength(1002);
    expect(await sdk.contributeMemoryEvidence(context("supporter"), stamp("memory-support", 3400), id(11), options)).toEqual(contribution);
    const old = await new FoldSdk(store).memoryEvidencePage(owner.access, id(11), { revision: 0, offset: 1000 });
    expect(old).toMatchObject({ revision: 0, total: 1001, evidence: [evidence[1000]] });
    expect((await sdk.memoryEvidencePage(owner.access, id(11), { revision: 1 })).total).toBe(1002);
    await expect(sdk.contributeMemoryEvidence(context(), stamp("oversized", 3500), id(11), { evidence: evidence.slice(0, 101) })).rejects.toThrow("100");
  });

  it("enforces source scope containment and exact live turn/project joins", async () => {
    const sdk = new FoldSdk(new MemoryStore()); const own = context("user-a");
    const source = event({ id: "private-evidence", t: 1, creatorId: "user-a", spaceId: "space-a" });
    await sdk.append(access({ spaces: ["space-a"] }), { ...source, capture: { ...source.capture, identity: { ...source.capture.identity, repo: "project-a", project: "Display project name", turn: "live-turn" } } });
    const proposal = { ...input(1), evidence: [{ eventId: source.id, turnId: "live-turn", projectId: "project-a" }] };
    await expect(sdk.recordMemory({ ...own, access: { ...own.access, spaceRoles: { "space-a": "writer" } } }, stamp("broaden", 2), proposal)).rejects.toThrow("audience and space");
    const personal = memoryContext({ spaceId: "space-a" });
    await expect(sdk.recordMemory(personal, stamp("live-valid", 3), { ...proposal, audience: "personal", spaceId: "space-a" })).resolves.toMatchObject({ memory: { evidence: proposal.evidence } });
    await expect(sdk.recordMemory(personal, stamp("wrong-turn", 4), { ...proposal, id: id(2), audience: "personal", spaceId: "space-a", evidence: [{ eventId: source.id, turnId: "invented" }] })).rejects.toThrow("turn");
    await expect(sdk.recordMemory(context("user-a"), stamp("broad-derived", 5), { ...input(3), sourceMemoryRefs: [{ memoryId: id(1), revision: 0 }] })).rejects.toThrow();
  });

  it("invalidates derivatives transitively and rejects stale or unauthorized exact references", async () => {
    const sdk = new FoldSdk(new MemoryStore()); const own = context();
    await sdk.recordMemory(own, stamp("a", 1), input(1));
    await sdk.recordMemory(own, stamp("b", 2), { ...input(2), sourceMemoryRefs: [{ memoryId: id(1), revision: 0 }] });
    await sdk.recordMemory(own, stamp("c", 3), { ...input(3), sourceMemoryRefs: [{ memoryId: id(2), revision: 0 }] });
    expect((await sdk.recallMemories(own.access)).length).toBe(3);
    await sdk.reviseMemory(own, stamp("a-revised", 4), id(1), { summary: "corrected" });
    expect((await sdk.memoryById(own.access, id(2)))?.currentness?.status).toBe("needs-review");
    expect((await sdk.memoryById(own.access, id(3)))?.currentness?.status).toBe("needs-review");
    expect((await sdk.recallMemories(own.access)).map(({ memory }) => memory.id)).toEqual([id(1)]);
    await expect(sdk.recordMemory(own, stamp("stale", 5), { ...input(4), sourceMemoryRefs: [{ memoryId: id(1), revision: 0 }] })).rejects.toThrow("revision");
    await sdk.forgetMemory(own, stamp("forgotten", 6), id(1), "obsolete");
    expect((await sdk.memoryById(own.access, id(2)))?.currentness?.reasons).toContain("source-unavailable");
    await sdk.recordMemory(own, stamp("unresolved", 7), { id: id(5), audience: "workspace", source: "legacy" });
    await sdk.recordMemory(own, stamp("legacy-derived", 8), { ...input(6), source: "continuous-cognition", content: { citations: [id(2)] } });
    expect(await sdk.recallMemories(own.access)).toEqual([]);
    expect(await sdk.recallMemories(own.access, { includeNeedsReview: true })).toHaveLength(4);
  });

  it("marks dependency cycles and explicit supersession/contradiction for review without fabricating validity", async () => {
    const sdk = new FoldSdk(new MemoryStore()); const own = context();
    await sdk.recordMemory(own, stamp("first", 1), input(1));
    await sdk.recordMemory(own, stamp("second", 2), { ...input(2), sourceMemoryRefs: [{ memoryId: id(1), revision: 0 }] });
    await sdk.reviseMemory(own, stamp("cycle", 3), id(1), { sourceMemoryRefs: [{ memoryId: id(2), revision: 0 }] });
    expect((await sdk.memoryById(own.access, id(1)))?.currentness?.status).toBe("needs-review");
    expect((await sdk.memoryById(own.access, id(2)))?.currentness?.status).toBe("needs-review");
    await sdk.recordMemory(own, stamp("replacement", 4), { ...input(3), supersedes: [{ memoryId: id(1), revision: 1 }] });
    expect((await sdk.memoryById(own.access, id(1)))?.currentness?.status).toBe("superseded");
    await sdk.append(own.access, event({ id: "new-support", t: 4.1 }));
    await sdk.contributeMemoryEvidence(own, stamp("superseded-support", 4.2), id(1), { evidence: [{ eventId: "new-support" }] });
    expect((await sdk.memoryById(own.access, id(1)))?.currentness?.status).toBe("superseded");
    await sdk.reviseMemory(own, stamp("superseded-tag", 4.3), id(1), { tags: ["triaged"] });
    expect((await sdk.memoryById(own.access, id(1)))?.currentness?.status).toBe("superseded");
    await sdk.reviseMemory(own, stamp("explicit-claim-correction", 4.4), id(1), { summary: "Explicitly corrected claim" });
    expect((await sdk.memoryById(own.access, id(1)))?.currentness?.status).not.toBe("superseded");
    await sdk.recordMemory(own, stamp("contradiction", 5), { ...input(4), contradicts: [{ memoryId: id(3), revision: 0 }] });
    expect((await sdk.memoryById(own.access, id(3)))?.currentness?.reasons).toContain("contradictory-memory");
  });
});
