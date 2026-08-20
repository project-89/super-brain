import { AlertTriangle, Box, Braces, GitBranch } from "lucide-react";
import { useMemo, useState } from "react";

import { EmptyState, PageHeader, SearchField } from "../components/Common";
import type { JsonValue, SerializedFoldState } from "../types";

type StateView = "nodes" | "edges" | "values" | "diagnostics";

interface StateRow {
  readonly id: string;
  readonly kind: string;
  readonly value: unknown;
}

function stateRows(state: SerializedFoldState, view: StateView): StateRow[] {
  if (view === "nodes") return state.nodes.map(([id, value]) => ({ id, kind: value.kind, value }));
  if (view === "edges") return state.edges.map(([id, value]) => ({ id, kind: String(value.edgeType ?? "edge"), value }));
  if (view === "values") return state.values.map(([id, value]) => ({ id, kind: "component", value }));
  return state.diagnostics.map((value, index) => ({ id: String(value.eventId ?? `diagnostic-${index + 1}`), kind: String(value.kind ?? "diagnostic"), value }));
}

function displayValue(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? String(value);
}

export function StatePage({ state }: { readonly state: SerializedFoldState }) {
  const [view, setView] = useState<StateView>("nodes");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string>();
  const rows = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return stateRows(state, view).filter((row) =>
      !needle || `${row.id}\n${row.kind}\n${displayValue(row.value)}`.toLocaleLowerCase().includes(needle),
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
        <div className="segmented-control" role="tablist" aria-label="State view">
          <button type="button" role="tab" aria-selected={view === "nodes"} onClick={() => switchView("nodes")}><Box aria-hidden="true" />Nodes <span>{counts.nodes}</span></button>
          <button type="button" role="tab" aria-selected={view === "edges"} onClick={() => switchView("edges")}><GitBranch aria-hidden="true" />Edges <span>{counts.edges}</span></button>
          <button type="button" role="tab" aria-selected={view === "values"} onClick={() => switchView("values")}><Braces aria-hidden="true" />Values <span>{counts.values}</span></button>
          <button type="button" role="tab" aria-selected={view === "diagnostics"} onClick={() => switchView("diagnostics")}><AlertTriangle aria-hidden="true" />Diagnostics <span>{counts.diagnostics}</span></button>
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
              <span><strong>{row.id}</strong><small>{row.kind}</small></span>
            </button>
          ))}
        </div>
        <article className="json-inspector">
          {selected === undefined ? <EmptyState title="No state selected" /> : <><header><span className="eyebrow">{selected.kind}</span><h2>{selected.id}</h2></header><pre>{displayValue(selected.value as JsonValue)}</pre></>}
        </article>
      </section>
    </div>
  );
}
