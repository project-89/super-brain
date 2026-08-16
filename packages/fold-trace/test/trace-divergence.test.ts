import { describe, expect, it } from "vitest";

import {
  analyzeTraceDivergence,
  branchKey,
  entropyOfCounts,
  normalizeArgs,
  priorStepOutputs,
  type ToolCall,
  type ToolTrace,
} from "../src/index.js";

function call(
  name: string,
  args: Record<string, unknown> = {},
  output?: unknown,
): ToolCall {
  return {
    name,
    args,
    ...(output === undefined ? {} : { result: { output } }),
  };
}

function trace(...calls: ToolCall[]): ToolTrace {
  return calls;
}

describe("tool argument normalization", () => {
  it("normalizes strings, objects, arrays, and nullish values", () => {
    expect(normalizeArgs("  Hello ")).toBe("hello");
    expect(normalizeArgs({ z: " B ", a: [3, 1, 2], empty: null })).toEqual({
      a: [1, 2, 3],
      empty: "",
      z: "b",
    });
    expect(normalizeArgs(undefined)).toBe("");
  });

  it("produces equal keys for cosmetic differences and distinct keys for real ones", () => {
    expect(branchKey(call("search", { query: "  FOO ", tags: ["b", "a"] }))).toBe(
      branchKey(call("search", { tags: ["A", "B"], query: "foo" })),
    );
    expect(branchKey(call("search", { query: "foo" }))).not.toBe(
      branchKey(call("read", { query: "foo" })),
    );
  });
});

describe("trace divergence", () => {
  it("computes Shannon entropy while ignoring empty buckets", () => {
    expect(entropyOfCounts([1, 1])).toBe(1);
    expect(entropyOfCounts([2, 2, 0])).toBe(1);
    expect(entropyOfCounts([])).toBe(0);
  });

  it("requires enough evidence and ignores unanimous or parametric-only splits", () => {
    expect(analyzeTraceDivergence([trace(call("a")), trace(call("b"))])).toEqual([]);
    expect(
      analyzeTraceDivergence([
        trace(call("search", { query: "a" })),
        trace(call("search", { query: "b" })),
        trace(call("search", { query: "c" })),
      ]),
    ).toEqual([]);
    expect(
      analyzeTraceDivergence([
        trace(call("search")),
        trace(call("search")),
        trace(call("search")),
      ]),
    ).toEqual([]);
  });

  it("finds structural splits and retains branch continuations", () => {
    const traces = [
      trace(call("files"), call("read", { id: 1 })),
      trace(call("files"), call("read", { id: 2 })),
      trace(call("calendar"), call("events")),
      trace(call("calendar"), call("events")),
      trace(call("notes"), call("read_note")),
    ];

    const result = analyzeTraceDivergence(traces);
    expect(result).toHaveLength(2);
    const firstPosition = result.find((item) => item.position === 0)!;
    expect(firstPosition).toMatchObject({ position: 0, activeTraces: 5 });
    expect(firstPosition.clusters.map((cluster) => cluster.traceIndices)).toEqual([
      [2, 3],
      [0, 1],
      [4],
    ]);
    expect(firstPosition.clusters[0]!.continuationTraces[0]!.map((entry) => entry.name)).toEqual([
      "calendar",
      "events",
    ]);
  });

  it("skips low-entropy outliers and positions with too few active traces", () => {
    const lowEntropy = Array.from({ length: 10 }, (_, index) =>
      trace(call(index === 9 ? "outlier" : "common")),
    );
    expect(analyzeTraceDivergence(lowEntropy)).toEqual([]);

    expect(
      analyzeTraceDivergence([
        trace(call("same"), call("files")),
        trace(call("same"), call("calendar")),
        trace(call("same")),
      ]),
    ).toEqual([]);
  });

  it("orders by entropy, breaks ties by position, and caps the result", () => {
    const traces = Array.from({ length: 4 }, (_, index) =>
      trace(
        call(index < 2 ? "a" : "b"),
        call(index < 2 ? "c" : "d"),
        call(index < 2 ? "e" : "f"),
        call(index < 2 ? "g" : "h"),
      ),
    );
    expect(analyzeTraceDivergence(traces).map((item) => item.position)).toEqual([0, 1, 2]);
    expect(
      analyzeTraceDivergence(traces, { maxOpportunities: 2 }).map((item) => item.position),
    ).toEqual([0, 1]);
  });
});

describe("prior step outputs", () => {
  it("extracts, serializes, and truncates the immediately preceding result", () => {
    const traces = [
      trace(call("inbox", {}, "x".repeat(20)), call("read")),
      trace(call("inbox", {}, { count: 2 }), call("read")),
      trace(call("inbox"), call("read")),
    ];
    expect(priorStepOutputs(traces, 1, 10)).toEqual({
      0: "xxxxxxxxxx",
      1: '{"count":2',
      2: '""',
    });
    expect(priorStepOutputs(traces, 0)).toEqual({});
  });
});
