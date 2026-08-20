import { AlertTriangle, Box, Braces, GitBranch } from "lucide-react";
import { useMemo, useState } from "react";

import { EmptyState, PageHeader, SearchField } from "../components/Common";
import type { JsonValue, SerializedFoldNode, SerializedFoldState } from "../types";

type StateView = "nodes" | "edges" | "values" | "diagnostics";
type ProjectionMode = "canonical" | "working";

interface StateRow {
  readonly id: string;
  readonly label: string;
  readonly kind: string;
  readonly value: unknown;
}

function objectValue(value: JsonValue | undefined): Readonly<Record<string, JsonValue>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

export function nodeDisplayLabel(id: string, node: SerializedFoldNode): string {
  const memory = objectValue(node.properties.memory);
  const candidates = [
    memory?.summary,
    node.properties.title,
    node.properties.name,
    node.properties.label,
    node.properties.summary,
  ];
  return candidates.find((value): value is string => typeof value === "string" && value.trim().length > 0) ?? id;
}

function componentDisplayLabel(id: string): string {
  try {
    const [subject, component, field, object] = JSON.parse(id) as [string, string, string | null, string | null];
    const target = [component, field].filter(Boolean).join(".");
    return `${subject} · ${target}${object === null ? "" : ` → ${object}`}`;
  } catch {
    return id;
  }
}

function stateRows(state: SerializedFoldState, view: StateView): StateRow[] {
  if (view === "nodes") {
    return state.nodes.map(([id, value]) => ({
      id,
      label: nodeDisplayLabel(id, value),
      kind: value.nodeKind ?? "node",
      value,
    }));
  }
  if (view === "edges") {
    return state.edges.map(([id, value]) => ({
      id,
      label: `${value.subject} → ${value.object}`,
      kind: value.edgeType,
      value,
    }));
  }
  if (view === "values") {
    return state.values.map(([id, value]) => ({ id, label: componentDisplayLabel(id), kind: "component", value }));
  }
  return state.diagnostics.map((value, index) => {
    const id = String(value.eventId ?? `diagnostic-${index + 1}`);
    return { id, label: id, kind: String(value.kind ?? "diagnostic"), value };
  });
}

function displayValue(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? String(value);
}

export function StatePage({
  canonicalState,
  workingState,
}: {
  readonly canonicalState: SerializedFoldState;
  readonly workingState: SerializedFoldState;
}) {
  const [view, setView] = useState<StateView>("nodes");
  const [mode, setMode] = useState<ProjectionMode>("canonical");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string>();
  const state = mode === "canonical" ? canonicalState : workingState;
  const rows = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return stateRows(state, view).filter((row) =>
      !needle || `${row.label}\n${row.id}\n${row.kind}\n${displayValue(row.value)}`.toLocaleLowerCase().includes(needle),
    );
  }, [query, state, view]);
  const selected = rows.find((row) => row.id === selectedId) ?? rows[0];

  const switchView = (next: StateView) => {
    setView(next);
    setSelectedId(undefined);
  };

  const counts: Record<StateView, number> = {
    nodes: state.nodes.length,
    edges: state.edges.length,
    values: state.values.length,
    diagnostics: state.diagnostics.length,
  };

  return (
    <div className="page page--state">
      <PageHeader eyebrow="Materialized projection" title="Fold state" />
      <div className="state-toolbar">
        <div className="state-toolbar__controls">
          <div className="segmented-control segmented-control--mode" role="group" aria-label="Projection mode">
            <button type="button" aria-pressed={mode === "canonical"} onClick={() => setMode("canonical")}>Canon</button>
            <button type="button" aria-pressed={mode === "working"} onClick={() => setMode("working")}>Working <span>+{Math.max(0, workingState.appliedEvents.length - canonicalState.appliedEvents.length)}</span></button>
          </div>
          <div className="segmented-control" role="tablist" aria-label="State view">
            <button type="button" role="tab" aria-selected={view === "nodes"} onClick={() => switchView("nodes")}><Box aria-hidden="true" />Nodes <span>{counts.nodes}</span></button>
            <button type="button" role="tab" aria-selected={view === "edges"} onClick={() => switchView("edges")}><GitBranch aria-hidden="true" />Edges <span>{counts.edges}</span></button>
            <button type="button" role="tab" aria-selected={view === "values"} onClick={() => switchView("values")}><Braces aria-hidden="true" />Values <span>{counts.values}</span></button>
            <button type="button" role="tab" aria-selected={view === "diagnostics"} onClick={() => switchView("diagnostics")}><AlertTriangle aria-hidden="true" />Diagnostics <span>{counts.diagnostics}</span></button>
          </div>
        </div>
        <SearchField value={query} onChange={setQuery} placeholder={`Search ${view}`} />
      </div>

      <section className="state-layout">
        <div className="state-list" role="tabpanel">
          {rows.length === 0 ? (
            <EmptyState title={`No ${view}`} />
          ) : rows.map((row) => (
            <button className={row.id === selected?.id ? "is-selected" : undefined} type="button" key={row.id} onClick={() => setSelectedId(row.id)}>
              <span className="state-list__icon">{view === "nodes" ? <Box aria-hidden="true" /> : view === "edges" ? <GitBranch aria-hidden="true" /> : view === "values" ? <Braces aria-hidden="true" /> : <AlertTriangle aria-hidden="true" />}</span>
              <span><strong>{row.label}</strong><small>{row.kind}</small>{row.label !== row.id && <code className="state-list__id">{row.id}</code>}</span>
            </button>
          ))}
        </div>
        <article className="json-inspector">
          {selected === undefined ? <EmptyState title="No state selected" /> : <><header><span className="eyebrow">{selected.kind}</span><h2>{selected.label}</h2>{selected.label !== selected.id && <code className="json-inspector__id">{selected.id}</code>}</header><pre>{displayValue(selected.value as JsonValue)}</pre></>}
        </article>
      </section>
    </div>
  );
}
