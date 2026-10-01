import { useCallback, useEffect, useState } from "react";
import type { FoldApiClient } from "../api";
import type { CursorPage, DerivedTranscriptRecord, TranscriptDerivation } from "../types";
import { useCursorList } from "../use-cursor-list";
import { LoadMore } from "./LoadMore";

const labels: Record<string, string> = { usage: "Token usage", "agent-message": "Agent message", "agent-link": "Agent communication", "tool-result": "Tool result", "web-search": "Web search" };
const countLabels: Record<string, string> = { usage: "Usage snapshots", "agent-message": "Agent messages", "agent-link": "Agent communications", "tool-result": "Tool results", "web-search": "Web searches" };

function Paged<T>({ fetchPage, keyOf, children }: {
  readonly fetchPage: (cursor?: string) => Promise<CursorPage<T>>;
  readonly keyOf: (item: T) => string;
  readonly children: (items: readonly T[]) => React.ReactNode;
}) {
  const [first, setFirst] = useState<CursorPage<T>>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    void fetchPage().then((value) => { if (active) setFirst(value); }, (caught: unknown) => { if (active) setError(caught instanceof Error ? caught.message : "Evidence unavailable"); });
    return () => { active = false; };
  }, [fetchPage]);
  if (error) return <p role="alert">{error}</p>;
  if (!first) return <p role="status">Loading derived evidence...</p>;
  return <Pages first={first} fetchPage={fetchPage} keyOf={keyOf}>{children}</Pages>;
}

function Pages<T>({ first, fetchPage, keyOf, children }: {
  readonly first: CursorPage<T>;
  readonly fetchPage: (cursor?: string) => Promise<CursorPage<T>>;
  readonly keyOf: (item: T) => string;
  readonly children: (items: readonly T[]) => React.ReactNode;
}) {
  const page = useCursorList({ initialItems: first.items, initialTotal: first.total, initialCursor: first.nextCursor, keyOf, loadPage: fetchPage });
  return <>{children(page.items)}<LoadMore loaded={page.items.length} total={page.total} hasMore={page.cursor !== undefined} loading={page.loadingMore} error={page.loadError} onLoadMore={() => void page.loadMore()} /></>;
}

function Evidence({ api, runId, derivationId }: { readonly api: FoldApiClient; readonly runId: string; readonly derivationId: string }) {
  const fetchPage = useCallback((cursor?: string) => api.transcriptDerivedRecords(runId, derivationId, cursor), [api, runId, derivationId]);
  return <Paged<DerivedTranscriptRecord> fetchPage={fetchPage} keyOf={(item) => String(item.ordinal)}>{(records) => <ol className="derived-records">{records.map((record) => <li key={record.ordinal}>
    <details><summary><strong>{labels[record.kind] ?? record.kind}</strong>{" "}<span>Retained line {record.line.toLocaleString()}{typeof record.data.status === "string" ? ` / ${record.data.status}` : ""}</span></summary>
      <code>{record.sourceType}</code><pre>{JSON.stringify(record.data, null, 2)}</pre>
    </details>
  </li>)}</ol>}</Paged>;
}

function Derivation({ api, runId, item }: { readonly api: FoldApiClient; readonly runId: string; readonly item: TranscriptDerivation }) {
  const [open, setOpen] = useState(false);
  return <details className="transcript-derivation" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary><strong>{item.manifest.records.toLocaleString()} evidence records</strong>{" "}<span>v{item.manifest.parser.version} / {item.complete ? "Complete" : `${item.storedChunks} of ${item.manifest.chunkHashes.length} chunks`}</span></summary>
    <dl className="history-metadata">
      <div><dt>Retained source records</dt><dd>{item.manifest.sourceRecords.toLocaleString()}</dd></div>
      {Object.entries(item.manifest.byKind).map(([kind, count]) => <div key={kind}><dt>{countLabels[kind] ?? kind}</dt><dd>{count.toLocaleString()}</dd></div>)}
      <div><dt>Processed</dt><dd>{new Date(item.recordedAt).toLocaleString()}</dd></div>
    </dl>
    {Object.keys(item.manifest.unclassifiedTypes).length > 0 && <details><summary>Unclassified source records</summary><dl className="history-metadata">{Object.entries(item.manifest.unclassifiedTypes).map(([kind, count]) => <div key={kind}><dt>{kind}</dt><dd>{count.toLocaleString()}</dd></div>)}</dl></details>}
    <details><summary>Source and derivation identity</summary><dl className="history-metadata"><div><dt>Original import SHA-256</dt><dd><code>{item.manifest.sourceSha256}</code></dd></div><div><dt>Retained input SHA-256</dt><dd><code>{item.manifest.inputSha256}</code></dd></div><div><dt>Derivation</dt><dd><code>{item.derivationId}</code></dd></div></dl></details>
    {open && <Evidence api={api} runId={runId} derivationId={item.derivationId} />}
  </details>;
}

export function TranscriptDerivations({ api, runId }: { readonly api: FoldApiClient; readonly runId: string }) {
  const fetchPage = useCallback((cursor?: string) => api.transcriptDerivations(runId, cursor), [api, runId]);
  return <section className="history-evidence transcript-derivations" aria-label="Derived evidence">
    <header><h3>Derived evidence</h3></header>
    <Paged<TranscriptDerivation> fetchPage={fetchPage} keyOf={(item) => item.derivationId}>{(items) => items.length === 0 ? <p>No historical derivations recorded.</p> : items.map((item) => <Derivation key={item.derivationId} api={api} runId={runId} item={item} />)}</Paged>
  </section>;
}
