import { describe, expect, it } from "vitest";

import { effectiveMemoryApplicability, memoryApplicabilityLabel } from "./memory-applicability";

describe("memory applicability", () => {
  it("does not present missing project identity as generally reusable", () => {
    expect(effectiveMemoryApplicability({ projectIds: [] })).toBe("unresolved");
    expect(memoryApplicabilityLabel({ projectIds: [] }, new Map())).toBe("Needs project review");
    expect(memoryApplicabilityLabel({ applicability: { kind: "global" }, projectIds: [] }, new Map())).toBe("All projects (explicit)");
  });

  it("preserves legacy project applicability and displays project names", () => {
    expect(effectiveMemoryApplicability({ projectIds: ["a"] })).toBe("project");
    expect(memoryApplicabilityLabel({ projectIds: ["a", "b"] }, new Map([["a", "Project A"]]))).toBe("Project A, b");
    expect(memoryApplicabilityLabel({ applicability: { kind: "projects", projectIds: ["a"] }, projectIds: [] }, new Map([["a", "Project A"]]))).toBe("Project A");
  });

  it("counts only unresolved records as missing applicability", () => {
    const records = [
      { projectIds: [] },
      { projectIds: ["a"] },
      { applicability: { kind: "global" as const }, projectIds: [] },
      { applicability: { kind: "unresolved" as const }, projectIds: [] },
    ];
    expect(records.filter((record) => effectiveMemoryApplicability(record) === "unresolved")).toHaveLength(2);
  });
});
