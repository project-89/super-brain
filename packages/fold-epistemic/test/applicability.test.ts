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
  it("keeps legacy payloads unchanged while deriving safe relevance", () => {
    for (const projectIds of [[], ["project-a"]]) {
      const event = makeMemoryRecordedEvent(context(), stamp("record", 100), { id: MEMORY_A, source: "test", projectIds });
      const parsed = recordedMemory(event);
      const change = event.changes[0]!;
      if (change.verb !== "create") throw new Error("expected memory creation");
      expect(change.after.memory).not.toHaveProperty("applicability");
      expect(parsed).not.toHaveProperty("applicability");
      expect(effectiveMemoryApplicability(parsed)).toBe(projectIds.length ? "project" : "unresolved");
      expect(matchesMemoryProjects(parsed, ["project-a"])).toBe(projectIds.length > 0);
      expect(matchesMemoryProjects(parsed)).toBe(true);
    }
  });

  it.each([
    { applicability: "project", projectIds: [] },
    { applicability: "general", projectIds: ["project-a"] },
    { applicability: "unresolved", projectIds: ["project-a"] },
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
    expect((memoryCandidateLogRecordsFromEvent(proposed)[0] as any).candidate).not.toHaveProperty("applicability");
    expect(() => memoryCandidateLogRecordsFromEvent(replacePayload(proposed, "candidate", pair))).toThrow(/applicability/);
  });

  it("normalizes project IDs and validates merged revisions during construction and replay", () => {
    const recorded = makeMemoryRecordedEvent(context(), stamp("record", 100), {
      id: MEMORY_A, source: "test", applicability: "project", projectIds: [" b ", "a", "a"],
    });
    const current = recordedMemory(recorded);
    expect(current.projectIds).toEqual(["a", "b"]);
    expect(() => makeMemoryRevisedEvent(context(), stamp("revision", 110), current, { applicability: "general" })).toThrow(/empty projectIds/);
    expect(() => makeMemoryRevisedEvent(context(), stamp("revision", 110), current, { projectIds: [] })).toThrow(/at least one/);
    const revision = makeMemoryRevisedEvent(context(), stamp("revision", 110), current, { applicability: "general", projectIds: [] });
    const general = rebuildMemories([recorded, revision]).memories.get(MEMORY_A)!;
    expect(general).toMatchObject({ applicability: "general", projectIds: [], revision: 1 });
    const tampered = replacePayload(revision, "patch", { projectIds: ["a"] });
    expect(() => rebuildMemories([recorded, tampered])).toThrow(/empty projectIds/);
    expect(() => makeMemoryRevisedEvent(context({ principalId: "user-b" }), stamp("other", 120), general, { applicability: "unresolved" })).toThrow();
    const unresolved = makeMemoryRevisedEvent(context(), stamp("unresolved", 120), general, { applicability: "unresolved" });
    const final = rebuildMemories([recorded, revision, unresolved]).memories.get(MEMORY_A)!;
    expect(effectiveMemoryApplicability(final)).toBe("unresolved");
  });

  it("filters semantic and unranked recall without broadening personal or space access", () => {
    const records = [
      memory({ id: MEMORY_A, projectIds: ["a"] }),
      { ...memory({ id: MEMORY_B }), applicability: "general" as MemoryApplicability },
      memory({ id: MEMORY_C }),
      memory({ id: MEMORY_D, projectIds: ["b"] }),
    ];
    const corpus = projection(records);
    const access = context().access;
    expect(recallMemoryCorpus(corpus, access, { projectIds: ["a"] }).map((item) => item.id)).toEqual([MEMORY_A, MEMORY_B]);
    expect(recallMemories(corpus, access, { projectIds: ["a"], candidates: records.map((item) => ({ memoryId: item.id, score: 1 })) }).map(({ memory }) => memory.id)).toEqual([MEMORY_A, MEMORY_B]);
    expect(recallMemoryCorpus(corpus, access)).toHaveLength(4);
    expect(recallMemoryCorpus(corpus, context({ principalId: "user-b", workspaceRole: "owner" }).access, { projectIds: ["a"] })).toEqual([]);
    const privateSpace = projection([{ ...records[1]!, audience: "workspace", spaceId: "private" }]);
    expect(recallMemoryCorpus(privateSpace, access, { projectIds: ["a"] })).toEqual([]);
  });
});
