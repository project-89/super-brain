import { GitCommitHorizontal } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { EmptyState, PageHeader, SearchField, StatusBadge } from "../components/Common";
import { compactJson, uniqueSorted } from "../format";
import type { FoldLogEntry } from "../types";

export function EventsPage({ entries }: { readonly entries: readonly FoldLogEntry[] }) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [kind, setKind] = useState("all");
  const [selectedId, setSelectedId] = useState<string>();
  const kinds = useMemo(() => uniqueSorted(entries.map(({ event }) => event.kind)), [entries]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return [...entries]
      .filter((entry) => status === "all" || entry.status === status)
      .filter(({ event }) => kind === "all" || event.kind === kind)
      .filter(({ event }) =>
        !needle || [event.title, event.description, event.kind, event.id, event.author.id]
          .filter(Boolean)
          .join("\n")
          .toLocaleLowerCase()
          .includes(needle),
      )
      .sort((left, right) => right.event.at.t - left.event.at.t || right.event.id.localeCompare(left.event.id));
  }, [entries, kind, query, status]);

  useEffect(() => {
    if (filtered.length === 0) setSelectedId(undefined);
    else if (!filtered.some(({ event }) => event.id === selectedId)) setSelectedId(filtered[0]!.event.id);
  }, [filtered, selectedId]);

  const selected = filtered.find(({ event }) => event.id === selectedId);

  return (
    <div className="page page--events">
      <PageHeader eyebrow="Canonical record" title="Fold events" />
      <div className="filter-bar">
        <SearchField value={query} onChange={setQuery} placeholder="Search events" />
        <label className="compact-field"><span>Status</span><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">All statuses</option><option value="canon">Canon</option><option value="draft">Draft</option></select></label>
        <label className="compact-field compact-field--kind"><span>Kind</span><select value={kind} onChange={(event) => setKind(event.target.value)}><option value="all">All kinds</option>{kinds.map((value) => <option key={value}>{value}</option>)}</select></label>
        <span className="result-count">{filtered.length} {filtered.length === 1 ? "event" : "events"}</span>
      </div>

      <section className="event-layout">
        <div className="event-table-pane">
          {filtered.length === 0 ? (
            <EmptyState title="No matching events" />
          ) : (
            <div className="table-wrap table-wrap--events">
              <table className="data-table data-table--interactive">
                <thead><tr><th>Event</th><th>Kind</th><th>World date</th><th>Status</th></tr></thead>
                <tbody>
                  {filtered.map(({ event, status: eventStatus }) => (
                    <tr key={event.id} className={event.id === selectedId ? "is-selected" : undefined}>
                      <td><button className="event-cell" type="button" onClick={() => setSelectedId(event.id)}><strong>{event.title}</strong><span>{event.id}</span></button></td>
                      <td><code>{event.kind}</code></td>
                      <td><time>{event.at.worldDate}</time></td>
                      <td><StatusBadge status={eventStatus} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <aside className="event-inspector" aria-label="Event inspector">
          {selected === undefined ? (
            <EmptyState title="Select an event" />
          ) : (
            <>
              <header className="inspector-header">
                <span className="inspector-icon"><GitCommitHorizontal aria-hidden="true" /></span>
                <div><span className="eyebrow">{selected.event.kind}</span><h2>{selected.event.title}</h2></div>
                <StatusBadge status={selected.status} />
              </header>
              {selected.event.description && <p className="inspector-description">{selected.event.description}</p>}
              <dl className="inspector-metadata">
                <div><dt>Event ID</dt><dd><code>{selected.event.id}</code></dd></div>
                <div><dt>World date</dt><dd>{selected.event.at.worldDate}</dd></div>
                <div><dt>Author</dt><dd>{selected.event.author.kind} · {selected.event.author.id}</dd></div>
                <div><dt>Scope</dt><dd>{selected.event.capture.scope.space ?? "workspace"}</dd></div>
              </dl>
              <section className="detail-section">
                <h3>Changes <span>{selected.event.changes.length}</span></h3>
                <ol className="change-list">
                  {selected.event.changes.map((change, index) => (
                    <li key={`${change.verb}:${change.subject}:${index}`}>
                      <header><span className={`verb verb--${change.verb}`}>{change.verb}</span><strong>{change.subject}</strong></header>
                      <dl>
                        {change.component && <div><dt>Component</dt><dd><code>{change.component}{change.field ? `.${change.field}` : ""}</code></dd></div>}
                        {change.object && <div><dt>Object</dt><dd><code>{change.object}</code></dd></div>}
                        {change.before !== undefined && <div><dt>Before</dt><dd>{compactJson(change.before)}</dd></div>}
                        {change.after !== undefined && <div><dt>After</dt><dd>{compactJson(change.after)}</dd></div>}
                      </dl>
                    </li>
                  ))}
                </ol>
              </section>
            </>
          )}
        </aside>
      </section>
    </div>
  );
}
