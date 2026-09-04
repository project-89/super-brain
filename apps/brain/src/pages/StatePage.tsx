import { AlertTriangle, Box, Braces, GitBranch, GitMerge, LoaderCircle } from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useState } from "react";

import type { FoldApiClient } from "../api";
import { EmptyState, PageHeader, SearchField } from "../components/Common";
import { LoadMore } from "../components/LoadMore";
import type {
  JsonValue,
  ProjectionResponse,
  ProjectionSection,
  SerializedFoldNode,
} from "../types";

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
  const candidate = objectValue(node.properties.candidate);
  const tree = objectValue(node.properties.tree);
  const candidates = [
    memory?.summary,
    candidate?.summary,
    tree?.taskId,
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

function responseRows(response: ProjectionResponse, section: ProjectionSection): StateRow[] {
  if (section === "nodes") {
    return response.state.nodes.map(([id, value]) => ({ id, label: nodeDisplayLabel(id, value), kind: value.nodeKind ?? "node", value }));
  }
  if (section === "edges") {
    return response.state.edges.map(([id, value]) => ({ id, label: `${value.subject} → ${value.object}`, kind: value.edgeType, value }));
  }
  if (section === "values") {
    return response.state.values.map(([id, value]) => ({ id, label: componentDisplayLabel(id), kind: "component", value }));
  }
  if (section === "redirects") {
    return response.state.redirects.map(([id, value]) => ({ id, label: `${id} → ${value}`, kind: "redirect", value: { from: id, to: value } }));
  }
  return response.state.diagnostics.map((value, index) => {
    const id = `${String(value.eventId ?? "diagnostic")}:${String(value.changeIndex ?? index)}`;
    return { id, label: String(value.eventId ?? id), kind: String(value.kind ?? "diagnostic"), value };
  });
}

function displayValue(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? String(value);
}

function cacheKey(mode: ProjectionMode, section: ProjectionSection, query: string): string {
  return `${mode}:${section}:${query}`;
}

function sectionIcon(section: ProjectionSection) {
  if (section === "nodes") return <Box aria-hidden="true" />;
  if (section === "edges") return <GitBranch aria-hidden="true" />;
  if (section === "values") return <Braces aria-hidden="true" />;
  if (section === "redirects") return <GitMerge aria-hidden="true" />;
  return <AlertTriangle aria-hidden="true" />;
}

export function StatePage({ canonical, api }: {
  readonly canonical: ProjectionResponse;
  readonly api: FoldApiClient;
}) {
  const [section, setSection] = useState<ProjectionSection>("nodes");
  const [mode, setMode] = useState<ProjectionMode>("canonical");
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query.trim());
  const [selectedId, setSelectedId] = useState<string>();
  const initialKey = cacheKey("canonical", "nodes", "");
  const [pages, setPages] = useState<Readonly<Record<string, ProjectionResponse>>>({ [initialKey]: canonical });
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const key = cacheKey(mode, section, deferredQuery);
  const response = pages[key];
  const rows = useMemo(() => response === undefined ? [] : responseRows(response, section), [response, section]);
  const selected = rows.find((row) => row.id === selectedId) ?? rows[0];

  useEffect(() => {
    setPages({ [initialKey]: canonical });
  }, [canonical, initialKey]);

  useEffect(() => {
    setSelectedId(undefined);
    if (pages[key] !== undefined) return;
    let active = true;
    setLoading(true);
    setLoadError(undefined);
    void api.projection(mode === "working", section, { query: deferredQuery }).then(
      (page) => {
        if (!active) return;
        setPages((current) => ({ ...current, [key]: page }));
        setLoading(false);
      },
      (caught: unknown) => {
        if (!active) return;
        setLoadError(caught instanceof Error ? caught.message : "Projection unavailable");
        setLoading(false);
      },
    );
    return () => { active = false; };
  }, [api, deferredQuery, key, mode, pages, section]);

  const loadMore = async () => {
    if (response?.nextCursor === undefined || loading) return;
    setLoading(true);
    setLoadError(undefined);
    try {
      const next = await api.projection(mode === "working", section, {
        cursor: response.nextCursor,
        query: deferredQuery,
      });
      setPages((current) => ({
        ...current,
        [key]: {
          ...next,
          state: {
            ...next.state,
            nodes: [...(current[key]?.state.nodes ?? []), ...next.state.nodes],
            edges: [...(current[key]?.state.edges ?? []), ...next.state.edges],
            values: [...(current[key]?.state.values ?? []), ...next.state.values],
            redirects: [...(current[key]?.state.redirects ?? []), ...next.state.redirects],
            diagnostics: [...(current[key]?.state.diagnostics ?? []), ...next.state.diagnostics],
          },
        },
      }));
    } catch (caught) {
      setLoadError(caught instanceof Error ? caught.message : "Unable to load more state");
    } finally {
      setLoading(false);
    }
  };

  const counts = response?.counts ?? canonical.counts ?? { nodes: 0, edges: 0, values: 0, redirects: 0, diagnostics: 0 };
  const canonicalApplied = canonical.state.appliedEventCount ?? canonical.projected ?? 0;
  const workingApplied = mode === "working" ? response?.state.appliedEventCount : undefined;
  const sectionTotal = response?.sectionTotal ?? 0;

  return (
    <div className="page page--state">
      <PageHeader eyebrow="Materialized projection" title="Fold state" />
      <div className="state-toolbar">
        <div className="state-toolbar__controls">
          <div className="segmented-control segmented-control--mode" role="group" aria-label="Projection mode">
            <button type="button" aria-pressed={mode === "canonical"} onClick={() => setMode("canonical")}>Canon</button>
            <button type="button" aria-pressed={mode === "working"} onClick={() => setMode("working")}>Working{workingApplied === undefined ? "" : <span>+{Math.max(0, workingApplied - canonicalApplied)}</span>}</button>
          </div>
          <div className="segmented-control" role="tablist" aria-label="State view">
            {(["nodes", "edges", "values", "redirects", "diagnostics"] as const).map((value) => <button key={value} type="button" role="tab" aria-selected={section === value} onClick={() => setSection(value)}>{sectionIcon(value)}{value[0]!.toUpperCase() + value.slice(1)} <span>{counts[value].toLocaleString()}</span></button>)}
          </div>
        </div>
        {response?.total !== undefined && response.projected !== undefined && (
          <span className="result-count">Full projection · {response.projected.toLocaleString()} of {response.total.toLocaleString()} events</span>
        )}
        <SearchField value={query} onChange={setQuery} placeholder={`Search ${section}`} />
      </div>

      <section className="state-layout">
        <div className="state-list" role="tabpanel">
          {loading && response === undefined ? <div className="state-page-loading"><LoaderCircle aria-hidden="true" />Loading {section}</div> : loadError !== undefined && response === undefined ? (
            <div className="fleet-activity-error"><AlertTriangle aria-hidden="true" />{loadError}</div>
          ) : rows.length === 0 ? (
            <EmptyState title={`No ${section}`} />
          ) : rows.map((row) => (
            <button className={row.id === selected?.id ? "is-selected" : undefined} type="button" key={row.id} onClick={() => setSelectedId(row.id)}>
              <span className="state-list__icon">{sectionIcon(section)}</span>
              <span><strong>{row.label}</strong><small>{row.kind}</small>{row.label !== row.id && <code className="state-list__id">{row.id}</code>}</span>
            </button>
          ))}
          {response !== undefined && <LoadMore
            loaded={rows.length}
            total={sectionTotal}
            hasMore={response.nextCursor !== undefined}
            loading={loading}
            error={loadError}
            onLoadMore={() => void loadMore()}
          />}
        </div>
        <article className="json-inspector">
          {selected === undefined ? <EmptyState title="No state selected" /> : <><header><span className="eyebrow">{selected.kind}</span><h2>{selected.label}</h2>{selected.label !== selected.id && <code className="json-inspector__id">{selected.id}</code>}</header><pre>{displayValue(selected.value as JsonValue)}</pre></>}
        </article>
      </section>
    </div>
  );
}
