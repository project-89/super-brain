import type { ToolCall, ToolTrace } from "./types.js";

export const ENTROPY_THRESHOLD = 0.5;
export const MIN_ACTIVE_TRACES = 3;
export const MAX_BRANCHES_PER_TRACE_SET = 3;

export interface BranchingCluster {
  readonly branchKey: string;
  readonly traceIndices: readonly number[];
  readonly sampleCall: {
    readonly tool: string;
    readonly args: Readonly<Record<string, unknown>>;
  };
  readonly continuationTraces: readonly ToolTrace[];
}

export interface BranchingOpportunity {
  readonly position: number;
  readonly activeTraces: number;
  readonly clusters: readonly BranchingCluster[];
  readonly entropy: number;
}

export interface TraceDivergenceOptions {
  readonly entropyThreshold?: number;
  readonly minActiveTraces?: number;
  readonly maxOpportunities?: number;
}

/** Canonicalize arguments aggressively so cosmetic changes do not create branches. */
export function normalizeArgs(value: unknown): unknown {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim().toLowerCase();
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value
      .map(normalizeArgs)
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) normalized[key] = normalizeArgs(source[key]);
    return normalized;
  }
  return String(value);
}

export function branchKey(
  call: Pick<ToolCall, "name" | "args">,
): string {
  return `${call.name}|${JSON.stringify(normalizeArgs(call.args))}`;
}

export function entropyOfCounts(counts: readonly number[]): number {
  const total = counts.reduce((sum, count) => sum + count, 0);
  if (total <= 0) return 0;

  let entropy = 0;
  for (const count of counts) {
    if (count <= 0) continue;
    const probability = count / total;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

export function analyzeTraceDivergence(
  traces: readonly ToolTrace[],
  options: TraceDivergenceOptions = {},
): BranchingOpportunity[] {
  const minActiveTraces = options.minActiveTraces ?? MIN_ACTIVE_TRACES;
  const entropyThreshold = options.entropyThreshold ?? ENTROPY_THRESHOLD;
  const maxOpportunities = options.maxOpportunities ?? MAX_BRANCHES_PER_TRACE_SET;
  if (traces.length < minActiveTraces) return [];

  const maxLength = Math.max(...traces.map((trace) => trace.length));
  const opportunities: BranchingOpportunity[] = [];

  for (let position = 0; position < maxLength; position += 1) {
    const activeIndices = traces
      .map((trace, index) => ({ trace, index }))
      .filter(({ trace }) => trace.length > position)
      .map(({ index }) => index);
    if (activeIndices.length < minActiveTraces) continue;

    const buckets = new Map<string, number[]>();
    for (const traceIndex of activeIndices) {
      const call = traces[traceIndex]![position]!;
      const key = branchKey(call);
      buckets.set(key, [...(buckets.get(key) ?? []), traceIndex]);
    }
    if (buckets.size < 2) continue;

    const tools = new Set(
      [...buckets.values()].map((indices) => traces[indices[0]!]![position]!.name),
    );
    if (tools.size < 2) continue;

    const entropy = entropyOfCounts([...buckets.values()].map((indices) => indices.length));
    if (entropy < entropyThreshold) continue;

    const clusters = [...buckets.entries()]
      .map(([key, indices]): BranchingCluster => {
        const sample = traces[indices[0]!]![position]!;
        return {
          branchKey: key,
          traceIndices: [...indices].sort((left, right) => left - right),
          sampleCall: { tool: sample.name, args: sample.args },
          continuationTraces: indices.map((index) => traces[index]!.slice(position)),
        };
      })
      .sort((left, right) => {
        if (left.traceIndices.length !== right.traceIndices.length) {
          return right.traceIndices.length - left.traceIndices.length;
        }
        return left.branchKey < right.branchKey ? -1 : left.branchKey > right.branchKey ? 1 : 0;
      });

    opportunities.push({
      position,
      activeTraces: activeIndices.length,
      clusters,
      entropy,
    });
  }

  return opportunities
    .sort((left, right) => {
      if (left.entropy !== right.entropy) return right.entropy - left.entropy;
      return left.position - right.position;
    })
    .slice(0, maxOpportunities);
}

export function priorStepOutputs(
  traces: readonly ToolTrace[],
  position: number,
  truncateChars = 800,
): Record<number, string> {
  const outputs: Record<number, string> = {};
  if (position <= 0) return outputs;

  for (let traceIndex = 0; traceIndex < traces.length; traceIndex += 1) {
    const trace = traces[traceIndex]!;
    if (trace.length <= position - 1) continue;
    const output = trace[position - 1]!.result?.output;
    const text = typeof output === "string" ? output : JSON.stringify(output ?? "");
    outputs[traceIndex] = (text || "").slice(0, truncateChars);
  }
  return outputs;
}
