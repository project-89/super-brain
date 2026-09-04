import { forkAt, sortLog, type FoldLogEntry, type ForkCursor } from "./order.js";
import {
  eventSchema,
  type Change,
  type FoldEvent,
  type JsonValue,
} from "./schema.js";

export type ComponentRule =
  | { readonly kind: "numeric" }
  | { readonly kind: "clampedNumeric"; readonly min: number; readonly max: number }
  | { readonly kind: "scalarLastWrite" }
  | { readonly kind: "flag" }
  | { readonly kind: "ref" }
  | { readonly kind: "set" };

export type ComponentRegistry = Readonly<Record<string, ComponentRule>>;

export const coreComponentRegistry: ComponentRegistry = {
  "core.alive": { kind: "flag" },
  "core.appearance": { kind: "scalarLastWrite" },
  "core.containment": { kind: "ref" },
  "core.exists": { kind: "flag" },
  "core.knowledge": { kind: "set" },
  "core.membership": { kind: "set" },
  "core.motivation": { kind: "scalarLastWrite" },
  "core.position": { kind: "ref" },
  "core.possession": { kind: "ref" },
  "core.regard": { kind: "clampedNumeric", min: -1, max: 1 },
  "drama.stakes": { kind: "clampedNumeric", min: 0, max: 1 },
  "drama.state": { kind: "scalarLastWrite" },
  "drama.tension": { kind: "clampedNumeric", min: 0, max: 1 },
};

export interface FoldNode {
  readonly id: string;
  readonly nodeKind?: string;
  readonly exists: boolean;
  readonly properties: Readonly<Record<string, JsonValue>>;
}

export interface FoldEdge {
  readonly id: string;
  readonly subject: string;
  readonly object: string;
  readonly edgeType: string;
  readonly payload?: JsonValue;
}

export interface BeforeMismatchDiagnostic {
  readonly kind: "before-mismatch";
  readonly eventId: string;
  readonly changeIndex: number;
  readonly expected: JsonValue;
  readonly actual?: JsonValue;
}

export interface ExistingCreateReplacedDiagnostic {
  readonly kind: "existing-create-replaced";
  readonly eventId: string;
  readonly changeIndex: number;
  readonly subject: string;
}

export type FoldDiagnostic = BeforeMismatchDiagnostic | ExistingCreateReplacedDiagnostic;

export interface AppliedChange {
  readonly eventId: string;
  readonly changeIndex: number;
  readonly change: Change;
}

export interface FoldState {
  readonly values: Map<string, JsonValue>;
  readonly nodes: Map<string, FoldNode>;
  readonly edges: Map<string, FoldEdge>;
  readonly redirects: Map<string, string>;
  readonly diagnostics: FoldDiagnostic[];
  readonly appliedEvents: FoldEvent[];
  readonly appliedChanges: AppliedChange[];
}

export interface FoldOptions {
  readonly include: "canon" | "canon+draft";
  readonly cursor?: ForkCursor;
  readonly components?: ComponentRegistry;
  readonly existingCreate?: "error" | "replace";
}

export class FoldValidationError extends Error {
  override readonly name = "FoldValidationError";
}

export function componentCellKey(
  subject: string,
  component: string,
  field?: string,
  object?: string,
): string {
  return JSON.stringify([subject, component, field ?? null, object ?? null]);
}

export function readComponent(
  state: FoldState,
  subject: string,
  component: string,
  field?: string,
  object?: string,
): JsonValue | undefined {
  return state.values.get(componentCellKey(subject, component, field, object));
}

function emptyState(): FoldState {
  return {
    values: new Map(),
    nodes: new Map(),
    edges: new Map(),
    redirects: new Map(),
    diagnostics: [],
    appliedEvents: [],
    appliedChanges: [],
  };
}

function jsonEqual(left: JsonValue | undefined, right: JsonValue): boolean {
  if (left === undefined && right === null) return true;
  if (typeof left === "number" && typeof right === "number") {
    return Math.abs(left - right) <= 1e-9;
  }
  if (left === right) return true;
  if (left === undefined || left === null || right === null) return false;

  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonEqual(value, right[index]!))
    );
  }

  if (typeof left !== "object" || typeof right !== "object") return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        jsonEqual(left[key], right[key]!),
    )
  );
}

function diagnoseBefore(
  state: FoldState,
  event: FoldEvent,
  changeIndex: number,
  actual: JsonValue | undefined,
  expected: JsonValue,
): void {
  if (jsonEqual(actual, expected)) return;
  state.diagnostics.push({
    kind: "before-mismatch",
    eventId: event.id,
    changeIndex,
    expected,
    ...(actual === undefined ? {} : { actual }),
  });
}

function targetKey(change: Change): string {
  switch (change.verb) {
    case "create":
    case "destroy":
      return componentCellKey(change.subject, "core.exists");
    case "set":
    case "adjust":
    case "mark":
    case "unmark":
      return componentCellKey(change.subject, change.component, change.field, change.object);
    case "link":
    case "unlink":
      return componentCellKey(change.subject, `edge:${change.edgeType}`, change.edgeId, change.object);
    case "transfer":
      return componentCellKey(change.object, "core.possession");
    case "reveal":
      return componentCellKey(change.audience, "core.knowledge", "known", change.subject);
    case "conceal":
      return componentCellKey(change.audience, "core.knowledge", "shielded", change.subject);
    case "merge":
      return componentCellKey(change.object, "core.redirect");
  }
}

function assertUniqueEventTargets(event: FoldEvent): void {
  const seen = new Set<string>();
  for (const change of event.changes) {
    const key = targetKey(change);
    if (seen.has(key)) {
      throw new FoldValidationError(
        `event ${event.id} contains multiple changes for target ${key}`,
      );
    }
    seen.add(key);
  }
}

function resolveNodeId(state: FoldState, nodeId: string): string {
  const visited = new Set<string>();
  let current = nodeId;
  while (state.redirects.has(current)) {
    if (visited.has(current)) {
      throw new FoldValidationError(`redirect cycle contains ${current}`);
    }
    visited.add(current);
    current = state.redirects.get(current)!;
  }
  return current;
}

function writeTarget(
  state: FoldState,
  event: FoldEvent,
  changeIndex: number,
  change: Extract<Change, { verb: "set" | "mark" | "unmark" }>,
): void {
  const key = targetKey(change);
  const current = change.verb === "mark" || change.verb === "unmark"
    ? state.values.get(key) ?? false
    : state.values.get(key);
  diagnoseBefore(state, event, changeIndex, current, change.before);
  state.values.set(key, change.after);
}

function applyChange(
  state: FoldState,
  event: FoldEvent,
  change: Change,
  changeIndex: number,
  components: ComponentRegistry,
  existingCreate: "error" | "replace",
): void {
  switch (change.verb) {
    case "create": {
      const current = state.nodes.get(change.subject);
      if (current?.exists === true && existingCreate === "error") {
        throw new FoldValidationError(`cannot create existing node ${change.subject}`);
      }
      if (current?.exists === true) {
        state.diagnostics.push({
          kind: "existing-create-replaced",
          eventId: event.id,
          changeIndex,
          subject: change.subject,
        });
        for (const component of Object.keys(current.properties)) {
          state.values.delete(componentCellKey(change.subject, component));
        }
      }
      state.nodes.set(change.subject, {
        id: change.subject,
        nodeKind: change.nodeKind,
        exists: true,
        properties: change.after,
      });
      state.values.set(componentCellKey(change.subject, "core.exists"), true);
      for (const [component, value] of Object.entries(change.after)) {
        state.values.set(componentCellKey(change.subject, component), value);
      }
      break;
    }

    case "destroy": {
      const node = state.nodes.get(change.subject);
      diagnoseBefore(state, event, changeIndex, node?.properties, change.before);
      state.nodes.set(change.subject, {
        id: change.subject,
        ...(node?.nodeKind === undefined ? {} : { nodeKind: node.nodeKind }),
        exists: false,
        properties: node?.properties ?? change.before,
      });
      state.values.set(componentCellKey(change.subject, "core.exists"), false);
      break;
    }

    case "set":
    case "mark":
    case "unmark":
      writeTarget(state, event, changeIndex, change);
      break;

    case "adjust": {
      const key = targetKey(change);
      const current = state.values.get(key) ?? 0;
      if (typeof current !== "number") {
        throw new FoldValidationError(`${change.component} is not numeric at ${change.subject}`);
      }
      diagnoseBefore(state, event, changeIndex, current, change.before);

      const rule = components[change.component];
      if (rule?.kind !== "numeric" && rule?.kind !== "clampedNumeric") {
        throw new FoldValidationError(
          `adjust requires a declared numeric component: ${change.component}`,
        );
      }

      let next = current + change.amount;
      if (rule.kind === "clampedNumeric") {
        next = Math.min(rule.max, Math.max(rule.min, next));
      }
      state.values.set(key, next);
      break;
    }

    case "link":
      state.edges.set(change.edgeId, {
        id: change.edgeId,
        subject: change.subject,
        object: change.object,
        edgeType: change.edgeType,
        ...(change.payload === undefined ? {} : { payload: change.payload }),
      });
      break;

    case "unlink":
      state.edges.delete(change.edgeId);
      break;

    case "transfer": {
      const key = targetKey(change);
      const current = state.values.get(key);
      diagnoseBefore(state, event, changeIndex, current, change.before);
      state.values.set(key, change.after);
      break;
    }

    case "reveal":
    case "conceal": {
      const key = targetKey(change);
      const current = state.values.get(key) ?? false;
      diagnoseBefore(state, event, changeIndex, current, change.before);
      state.values.set(key, change.after);
      break;
    }

    case "merge": {
      if (resolveNodeId(state, change.subject) === change.object) {
        throw new FoldValidationError(
          `redirect ${change.object} -> ${change.subject} would create a cycle`,
        );
      }
      state.redirects.set(change.object, change.subject);
      resolveNodeId(state, change.object);
      break;
    }
  }

  state.appliedChanges.push({ eventId: event.id, changeIndex, change });
}

export function fold(
  inputEntries: readonly FoldLogEntry[],
  options: FoldOptions,
): FoldState {
  const parsedEntries = inputEntries.map(({ event, status }) => ({
    event: eventSchema.parse(event),
    status,
  }));
  const included = parsedEntries.filter(
    ({ status }) => options.include === "canon+draft" || status === "canon",
  );
  const entries = options.cursor === undefined
    ? sortLog(included)
    : forkAt(included, options.cursor);

  const seenEventIds = new Set<string>();
  const state = emptyState();
  const components = { ...coreComponentRegistry, ...options.components };
  const existingCreate = options.existingCreate ?? "error";

  for (const { event } of entries) {
    if (seenEventIds.has(event.id)) {
      throw new FoldValidationError(`duplicate event id: ${event.id}`);
    }
    seenEventIds.add(event.id);
    assertUniqueEventTargets(event);

    event.changes.forEach((change, changeIndex) => {
      applyChange(state, event, change, changeIndex, components, existingCreate);
    });
    state.appliedEvents.push(event);
  }

  return state;
}

function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value instanceof Map) {
    return [...value.entries()]
      .sort(([left], [right]) => {
        const leftKey = String(left);
        const rightKey = String(right);
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      })
      .map(([key, entryValue]) => [key, stableJson(entryValue)]);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entryValue]) => entryValue !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entryValue]) => [key, stableJson(entryValue)]),
    );
  }
  return value;
}

/** Stable keys, absent undefined fields, and native unrounded float strings. */
export function serializeFoldState(state: FoldState): string {
  return JSON.stringify(stableJson(state));
}
