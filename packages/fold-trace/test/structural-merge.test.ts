import { describe, expect, it } from "vitest";

import { mergeStructuralTraces, type ToolCall, type ToolTrace } from "../src/index.js";

function call(name: string, id = name): ToolCall {
  return { name, args: { id }, result: { success: true, output: `${name}:${id}` } };
}

function trace(...calls: ToolCall[]): ToolTrace {
  return calls;
}

describe("structural trace merge", () => {
  it("passes through a centroid-only or empty trace", () => {
    const centroid = trace(call("tasks"));
    expect(mergeStructuralTraces(centroid, []).unified).toBe(centroid);
    expect(mergeStructuralTraces([], [trace(call("email"))]).unified).toEqual([]);
  });

  it("counts trace support rather than repeated calls", () => {
    const centroid = trace(call("tasks"));
    const result = mergeStructuralTraces(centroid, [
      trace(call("email"), call("email"), call("email")),
      trace(call("tasks")),
      trace(call("tasks")),
    ]);
    expect(result.extensionsAdded).toEqual([]);
  });

  it("extends supported tools while preserving the centroid verbatim", () => {
    const centroid = trace(call("tasks", "one"), call("task_read", "two"));
    const result = mergeStructuralTraces(centroid, [
      trace(call("email"), call("tasks")),
      trace(call("email"), call("tasks")),
      trace(call("tasks")),
    ]);
    expect(result.unified.slice(0, centroid.length)).toEqual(centroid);
    expect(result.extensionsAdded).toEqual(["email"]);
    expect(result.unified.at(-1)?.name).toBe("email");
  });

  it("uses the longest per-trace subsequence to preserve iteration", () => {
    const result = mergeStructuralTraces(trace(call("tasks")), [
      trace(call("email", "1"), call("email", "2"), call("email", "3")),
      trace(call("email", "4")),
      trace(call("tasks")),
    ]);
    expect(result.unified.filter((entry) => entry.name === "email")).toHaveLength(3);
  });

  it("sorts equal-support extensions deterministically and honors the cap", () => {
    const result = mergeStructuralTraces(
      trace(call("tasks")),
      [trace(call("notes"), call("calendar")), trace(call("notes"), call("calendar"))],
      { maxExtensions: 1 },
    );
    expect(result.extensionsAdded).toEqual(["calendar"]);
    expect(result.reason).toContain("notes: support=2 -> capped");
  });

  it("honors support overrides and reports decisions", () => {
    const result = mergeStructuralTraces(
      trace(call("tasks")),
      [trace(call("rare")), trace(call("tasks"))],
      { minSupport: 1 },
    );
    expect(result.extensionsAdded).toEqual(["rare"]);
    expect(result.reason).toContain("traces=3, minSupport=1");
    expect(result.reason).toContain("tasks: support=2 -> centroid");
    expect(result.reason).toContain("rare: support=1 -> EXTENDED");
  });

  it("covers the canonical narrow-centroid, broad-cluster case", () => {
    const result = mergeStructuralTraces(
      trace(call("tasks_list"), call("tasks_read"), call("tasks_read")),
      [
        trace(call("email_inbox"), call("email_read"), call("tasks_list")),
        trace(call("email_inbox"), call("notes_read"), call("tasks_list")),
        trace(call("email_inbox"), call("email_read"), call("notes_read")),
      ],
    );
    expect(new Set(result.extensionsAdded)).toEqual(
      new Set(["email_inbox", "email_read", "notes_read"]),
    );
  });
});
