import { describe, expect, it } from "vitest";

import { effectiveMemoryApplicability, memoryApplicabilityLabel } from "./memory-applicability";

describe("memory applicability", () => {
  it("does not present missing project identity as generally reusable", () => {
    expect(effectiveMemoryApplicability({ projectIds: [] })).toBe("unresolved");
    expect(memoryApplicabilityLabel({ projectIds: [] }, new Map())).toBe("Unresolved");
    expect(memoryApplicabilityLabel({ applicability: "general", projectIds: [] }, new Map())).toBe("General");
  });

  it("preserves legacy project applicability and displays project names", () => {
    expect(effectiveMemoryApplicability({ projectIds: ["a"] })).toBe("project");
    expect(memoryApplicabilityLabel({ projectIds: ["a", "b"] }, new Map([["a", "Project A"]]))).toBe("Project A, b");
  });

  it("counts only unresolved records as missing applicability", () => {
    const records = [
      { projectIds: [] },
      { projectIds: ["a"] },
      { applicability: "general" as const, projectIds: [] },
      { applicability: "unresolved" as const, projectIds: [] },
    ];
    expect(records.filter((record) => effectiveMemoryApplicability(record) === "unresolved")).toHaveLength(2);
  });
});
