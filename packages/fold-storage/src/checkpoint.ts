import { createHash } from "node:crypto";

import {
  fold,
  type ComponentRegistry,
  type FoldLogEntry,
  type FoldState,
  type JsonValue,
} from "@_89/fold";

import {
  foldCheckpointSchema,
  type FoldCheckpoint,
  type MaterializedFoldState,
} from "./records.js";

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort(compareText)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export function materializeFoldState(state: FoldState): MaterializedFoldState {
  const values = [...state.values.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([key, value]) => [key, value] as [string, JsonValue]);
  const nodes = [...state.nodes.values()]
    .sort((left, right) => compareText(left.id, right.id))
    .map((node) => ({
      id: node.id,
      ...(node.nodeKind === undefined ? {} : { nodeKind: node.nodeKind }),
      exists: node.exists,
      properties: node.properties,
    }));
  const edges = [...state.edges.values()]
    .sort((left, right) => compareText(left.id, right.id))
    .map((edge) => ({
      id: edge.id,
      subject: edge.subject,
      object: edge.object,
      edgeType: edge.edgeType,
      ...(edge.payload === undefined ? {} : { payload: edge.payload }),
    }));
  const redirects = [...state.redirects.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([from, to]) => [from, to] as [string, string]);
  const diagnostics = state.diagnostics.map((diagnostic) => diagnostic.kind === "before-mismatch" ? {
    kind: diagnostic.kind,
    eventId: diagnostic.eventId,
    changeIndex: diagnostic.changeIndex,
    expected: diagnostic.expected,
    ...(diagnostic.actual === undefined ? {} : { actual: diagnostic.actual }),
  } : {
    kind: diagnostic.kind,
    eventId: diagnostic.eventId,
    changeIndex: diagnostic.changeIndex,
    subject: diagnostic.subject,
  });
  return { values, nodes, edges, redirects, diagnostics };
}

export function digestMaterializedState(state: MaterializedFoldState): string {
  return createHash("sha256").update(canonicalJson(state)).digest("hex");
}

export interface CreateCheckpointOptions {
  readonly include: "canon" | "canon+draft";
  readonly components?: ComponentRegistry;
  readonly componentSet?: string;
}

export function createCheckpoint(
  entries: readonly FoldLogEntry[],
  options: CreateCheckpointOptions,
): FoldCheckpoint {
  const state = fold(entries, {
    include: options.include,
    ...(options.components === undefined ? {} : { components: options.components }),
  });
  const materialized = materializeFoldState(state);
  const last = state.appliedEvents.at(-1);
  return foldCheckpointSchema.parse({
    include: options.include,
    componentSet: options.componentSet ?? "core-v0.7",
    through: last === undefined ? null : { t: last.at.t, eventId: last.id },
    eventCount: state.appliedEvents.length,
    stateDigest: digestMaterializedState(materialized),
    state: materialized,
  });
}

export interface CheckpointVerification {
  readonly valid: boolean;
  readonly expected: FoldCheckpoint;
}

export function verifyCheckpoint(
  checkpoint: FoldCheckpoint,
  precedingEntries: readonly FoldLogEntry[],
  components?: ComponentRegistry,
): CheckpointVerification {
  const expected = createCheckpoint(precedingEntries, {
    include: checkpoint.include,
    componentSet: checkpoint.componentSet,
    ...(components === undefined ? {} : { components }),
  });
  const valid =
    checkpoint.eventCount === expected.eventCount &&
    checkpoint.stateDigest === expected.stateDigest &&
    checkpoint.through?.t === expected.through?.t &&
    checkpoint.through?.eventId === expected.through?.eventId &&
    digestMaterializedState(checkpoint.state) === checkpoint.stateDigest;
  return { valid, expected };
}
