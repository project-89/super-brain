import type { FoldEvent } from "@_89/fold";
import { describe, expect, it } from "vitest";
import {
  effectiveMemoryApplicability,
  makeMemoryCandidateProposedEvent,
  makeMemoryRecordedEvent,
  makeMemoryRevisedEvent,
  matchesMemoryProjects,
  memoryCandidateLogRecordsFromEvent,
  memoryLogRecordsFromEvent,
  rebuildMemories,
  recallMemories,
  recallMemoryCorpus,
  type MemoryApplicability,
} from "../src/index.js";
import { MEMORY_A, MEMORY_B, MEMORY_C, MEMORY_D, context, memory, projection, recordedMemory, stamp } from "./helpers.js";

function replacePayload(event: FoldEvent, key: string, patch: object): FoldEvent {
  const changed = structuredClone(event) as any;
  Object.assign(changed.changes[0].after[key], patch);
  return changed;
}

describe("memory applicability", () => {
  it("derives canonical applicability from legacy project IDs and safe relevance", () => {
    for (const projectIds of [[], ["project-a"]]) {
      const event = makeMemoryRecordedEvent(context(), stamp("record", 100), { id: MEMORY_A, source: "test", projectIds });
      const parsed = recordedMemory(event);
      const expected = projectIds.length ? { kind: "projects", projectIds } : { kind: "unresolved" };
      expect(parsed.applicability).toEqual(expected);
      expect(effectiveMemoryApplicability(parsed)).toEqual(expected);
      // Legacy payloads without an applicability field replay identically.
      const legacy = structuredClone(event) as any;
      delete legacy.changes[0].after.memory.applicability;
      expect(memoryLogRecordsFromEvent(legacy)[0]).toMatchObject({ memory: { applicability: expected } });
      expect(matchesMemoryProjects(parsed, ["project-a"])).toBe(projectIds.length > 0);
      expect(matchesMemoryProjects(parsed)).toBe(true);
    }
  });

  it("accepts the legacy string encoding on construction and replay", () => {
    const general = recordedMemory(makeMemoryRecordedEvent(context(), stamp("record", 100), { id: MEMORY_A, source: "test", applicability: "general" as any, projectIds: [] }));
    expect(general).toMatchObject({ applicability: { kind: "global" }, projectIds: [] });
    const legacy = makeMemoryRecordedEvent(context(), stamp("record", 100), { id: MEMORY_A, source: "test", projectIds: ["a"] });
    expect(recordedMemory(replacePayload(legacy, "memory", { applicability: "project" }))).toMatchObject({ applicability: { kind: "projects", projectIds: ["a"] } });
  });

  it.each([
    { applicability: "project", projectIds: [] },
    { applicability: "general", projectIds: ["project-a"] },
    { applicability: "unresolved", projectIds: ["project-a"] },
    { applicability: { kind: "global" }, projectIds: ["project-a"] },
    { applicability: { kind: "projects", projectIds: ["project-b"] }, projectIds: ["project-a"] },
    { applicability: { kind: "projects", projectIds: [] }, projectIds: [] },
    { applicability: "bogus", projectIds: [] },
    { applicability: null, projectIds: [] },
  ])("rejects malformed pair $applicability in construction and replay", (pair) => {
    const input = { id: MEMORY_A, source: "test", ...pair } as any;
    expect(() => makeMemoryRecordedEvent(context(), stamp("record", 100), input)).toThrow(/applicability/);
    const legacy = makeMemoryRecordedEvent(context(), stamp("record", 100), { id: MEMORY_A, source: "test" });
    expect(() => memoryLogRecordsFromEvent(replacePayload(legacy, "memory", pair))).toThrow(/applicability/);

    const candidateInput = { id: MEMORY_A, source: "test", summary: "Test", content: null, evidence: [{ eventId: "source" }], confidence: 0.8, salience: 0.8, extractor: { kind: "rule" as const, id: "rule", version: "1" } };
    expect(() => makeMemoryCandidateProposedEvent(context(), stamp("proposal", 100), { ...candidateInput, ...pair } as any)).toThrow(/applicability/);
    const proposed = makeMemoryCandidateProposedEvent(context(), stamp("proposal", 100), candidateInput);
    expect(memoryCandidateLogRecordsFromEvent(proposed)[0]).toMatchObject({ candidate: { projectIds: [] } });
    expect((memoryCandidateLogRecordsFromEvent(proposed)[0] as any).candidate.applicability).toEqual({ kind: "unresolved" });
    expect(() => memoryCandidateLogRecordsFromEvent(replacePayload(proposed, "candidate", pair))).toThrow(/applicability/);
  });

  it("normalizes project IDs and validates merged revisions during construction and replay", () => {
    const recorded = makeMemoryRecordedEvent(context(), stamp("record", 100), {
      id: MEMORY_A, source: "test", applicability: "project" as any, projectIds: [" b ", "a", "a"],
    });
    const current = recordedMemory(recorded);
    expect(current.projectIds).toEqual(["a", "b"]);
    expect(current.applicability).toEqual({ kind: "projects", projectIds: ["a", "b"] });
    expect(() => makeMemoryRevisedEvent(context(), stamp("revision", 110), current, { applicability: "general" as any, projectIds: ["a"] })).toThrow(/empty projectIds/);
    expect(() => makeMemoryRevisedEvent(context(), stamp("revision", 110), current, { projectIds: [] })).toThrow(/at least one/);
    const revision = makeMemoryRevisedEvent(context(), stamp("revision", 110), current, { applicability: { kind: "global" } });
    const general = rebuildMemories([recorded, revision]).memories.get(MEMORY_A)!;
    expect(general).toMatchObject({ applicability: { kind: "global" }, projectIds: [], revision: 1 });
    const tampered = replacePayload(revision, "patch", { projectIds: ["a"] });
    expect(() => rebuildMemories([recorded, tampered])).toThrow(/project applicability requires|empty projectIds/);
    const legacyPatch = replacePayload(revision, "patch", { applicability: "general", projectIds: [] });
    expect(rebuildMemories([recorded, legacyPatch]).memories.get(MEMORY_A)).toMatchObject({ applicability: { kind: "global" }, projectIds: [] });
    const narrowed = makeMemoryRevisedEvent(context(), stamp("narrowed", 115), general, { projectIds: ["c"] });
    expect(rebuildMemories([recorded, revision, narrowed]).memories.get(MEMORY_A)).toMatchObject({ applicability: { kind: "projects", projectIds: ["c"] }, projectIds: ["c"] });
    expect(() => makeMemoryRevisedEvent(context({ principalId: "user-b" }), stamp("other", 120), general, { applicability: { kind: "unresolved" } })).toThrow();
    const unresolved = makeMemoryRevisedEvent(context(), stamp("unresolved", 120), general, { applicability: { kind: "unresolved" } });
    const final = rebuildMemories([recorded, revision, unresolved]).memories.get(MEMORY_A)!;
    expect(effectiveMemoryApplicability(final)).toEqual({ kind: "unresolved" });
  });

  it("filters semantic and unranked recall without broadening personal or space access", () => {
    const records = [
      memory({ id: MEMORY_A, projectIds: ["a"] }),
      { ...memory({ id: MEMORY_B }), applicability: { kind: "global" } as MemoryApplicability },
      { ...memory({ id: MEMORY_C }), applicability: { kind: "unresolved" } as MemoryApplicability },
      memory({ id: MEMORY_D, projectIds: ["b"] }),
    ];
    const corpus = projection(records);
    const access = context().access;
    expect(recallMemoryCorpus(corpus, access, { projectIds: ["a"] }).map((item) => item.id)).toEqual([MEMORY_A, MEMORY_B]);
    expect(recallMemories(corpus, access, { projectIds: ["a"], candidates: records.map((item) => ({ memoryId: item.id, score: 1 })) }).map(({ memory }) => memory.id)).toEqual([MEMORY_A, MEMORY_B]);
    // Unresolved records are review-only: excluded by default, retained by unfiltered review recall.
    expect(recallMemoryCorpus(corpus, access)).toHaveLength(3);
    expect(recallMemoryCorpus(corpus, access, { includeNeedsReview: true })).toHaveLength(4);
    expect(recallMemoryCorpus(corpus, access, { includeNeedsReview: true, projectIds: ["a"] }).map((item) => item.id)).toEqual([MEMORY_A, MEMORY_B, MEMORY_C]);
    expect(recallMemoryCorpus(corpus, context({ principalId: "user-b", workspaceRole: "owner" }).access, { projectIds: ["a"] })).toEqual([]);
    const privateSpace = projection([{ ...records[1]!, audience: "workspace", spaceId: "private" }]);
    expect(recallMemoryCorpus(privateSpace, access, { projectIds: ["a"] })).toEqual([]);
  });
});
