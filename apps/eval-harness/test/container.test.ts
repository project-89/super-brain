import { describe, expect, it } from "vitest";
import { containerArguments, containerDriverSource, executeInContainer } from "../src/container.js";
import { NODE_IMAGE } from "../src/harness.js";

describe("generated-code container boundary", () => {
  it("requires pinned images, denies network/mounts/privileges, and sends no host oracle into the driver", () => {
    const args = containerArguments(NODE_IMAGE, "super-brain-eval-test");
    expect(args).toEqual(expect.arrayContaining(["--network", "none", "--read-only", "65534:65534", "ALL", "no-new-privileges", "128m", "32"]));
    expect(args).not.toContain("--volume"); expect(args).not.toContain("--mount"); expect(args).not.toContain("--env");
    expect(() => containerArguments("node:latest", "super-brain-eval-test")).toThrow(/pinned/);
    expect(() => containerArguments(NODE_IMAGE, "unrelated-service")).toThrow(/owned/);
    const source = containerDriverSource();
    expect(source).not.toContain("hidden-cases.json"); expect(source).not.toContain("test.expected"); expect(source).toContain("imports disabled");
  });
  it("reports a missing Docker executable as unavailable without observations", async () => {
    const result = await executeInContainer("export function reduceDelivery() {}", [{ id: "one", group: "test", description: "synthetic", inputJson: '{"state":{"checkpoint":"0","events":[]},"arrivals":[]}', expected: { kind: "return", value: { checkpoint: "0", events: [] } } }], { image: NODE_IMAGE, docker: "/nonexistent/synthetic-docker" });
    expect(result.observations).toEqual([]); expect(result.protocolIssues).toContain("container-spawn");
  });
});
