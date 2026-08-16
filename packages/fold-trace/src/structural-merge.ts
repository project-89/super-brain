import type { ToolCall, ToolTrace } from "./types.js";

export interface StructuralMergeOptions {
  readonly minSupport?: number;
  readonly maxExtensions?: number;
}

export interface StructuralMergeResult {
  readonly unified: ToolTrace;
  readonly extensionsAdded: readonly string[];
  readonly reason: string;
}

function distinctTools(trace: ToolTrace): string[] {
  return [...new Set(trace.map((call) => call.name))];
}

function toolSupport(traces: readonly ToolTrace[]): Map<string, number> {
  const support = new Map<string, number>();
  for (const trace of traces) {
    for (const tool of new Set(trace.map((call) => call.name))) {
      support.set(tool, (support.get(tool) ?? 0) + 1);
    }
  }
  return support;
}

function longestSubsequence(tool: string, traces: readonly ToolTrace[]): ToolCall[] {
  let longest: ToolCall[] = [];
  for (const trace of traces) {
    const calls = trace.filter((call) => call.name === tool);
    if (calls.length > longest.length) longest = calls;
  }
  return longest;
}

export function mergeStructuralTraces(
  centroid: ToolTrace,
  others: readonly ToolTrace[],
  options: StructuralMergeOptions = {},
): StructuralMergeResult {
  const allTraces = [centroid, ...others];
  const totalTraces = allTraces.length;
  const minSupport = options.minSupport ?? Math.max(2, Math.ceil(totalTraces * 0.5));
  const maxExtensions = options.maxExtensions ?? 5;

  if (others.length === 0 || centroid.length === 0) {
    return {
      unified: centroid,
      extensionsAdded: [],
      reason: "no extensions: centroid-only or empty",
    };
  }

  const support = toolSupport(allTraces);
  const centroidTools = new Set(distinctTools(centroid));
  const sorted = [...support.entries()].sort((left, right) => {
    if (left[1] !== right[1]) return right[1] - left[1];
    return left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0;
  });
  const candidates = sorted
    .filter(([tool, count]) => !centroidTools.has(tool) && count >= minSupport)
    .slice(0, maxExtensions);

  if (candidates.length === 0) {
    return {
      unified: centroid,
      extensionsAdded: [],
      reason: `no extensions meet minSupport=${minSupport} threshold (traces=${totalTraces})`,
    };
  }

  const extensions: ToolCall[] = [];
  const extensionsAdded: string[] = [];
  for (const [tool] of candidates) {
    const calls = longestSubsequence(tool, allTraces);
    if (calls.length === 0) continue;
    extensions.push(...calls);
    extensionsAdded.push(tool);
  }

  const reason = [`traces=${totalTraces}, minSupport=${minSupport}`];
  for (const [tool, count] of sorted) {
    const decision = centroidTools.has(tool)
      ? "centroid (skip)"
      : count < minSupport
        ? "noise (support<min)"
        : extensionsAdded.includes(tool)
          ? "EXTENDED"
          : "capped (maxExtensions)";
    reason.push(`  ${tool}: support=${count} -> ${decision}`);
  }

  return {
    unified: [...centroid, ...extensions],
    extensionsAdded,
    reason: reason.join("\n"),
  };
}
