import { describe, expect, it } from "vitest";
import type { AuthorizedIdentity } from "@_89/super-brain-client";
import type { MemoryCandidate } from "@_89/fold-epistemic";
import { applicabilityLabel, mayEditMemory, mayReviewCandidate } from "./permissions";
const access: AuthorizedIdentity = { organizationId: "org", workspaceId: "workspace", principalId: "human", workspaceRole: "member", capabilities: ["memories:read", "memories:write", "feedback:write"], spaceRoles: { private: "reader" } };
const memory = { workspaceId: "workspace", creatorId: "machine", audience: "workspace" as const };
describe("memory review controls", () => {
  it("distinguishes shared edits, personal ownership, space writers, and administrator proposal review", () => {
    expect(mayEditMemory(access, memory)).toBe(true);
    expect(mayEditMemory(access, { ...memory, audience: "personal" })).toBe(false);
    expect(mayEditMemory(access, { ...memory, spaceId: "private" })).toBe(false);
    expect(mayEditMemory({ ...access, spaceRoles: { private: "writer" } }, { ...memory, spaceId: "private" })).toBe(true);
    const candidate = { ...memory, proposerId: "machine" } as unknown as MemoryCandidate;
    expect(mayReviewCandidate(access, candidate)).toBe(false); expect(mayReviewCandidate({ ...access, workspaceRole: "admin" }, candidate)).toBe(true);
    expect(mayEditMemory({ ...access, capabilities: ["memories:read"] }, memory)).toBe(false); expect(mayEditMemory(undefined, memory)).toBe(false);
  });
  it("never broadens missing applicability into all projects", () => {
    expect(applicabilityLabel({ projectIds: [] })).toBe("Needs project review"); expect(applicabilityLabel({ projectIds: [], applicability: { kind: "global" } })).toBe("All projects (explicit)");
  });
});
