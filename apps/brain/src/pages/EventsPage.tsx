import { GitCommitHorizontal } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { EmptyState, PageHeader, SearchField, StatusBadge } from "../components/Common";
import { LoadMore } from "../components/LoadMore";
import { compactJson, eventCategory, eventKindLabel, formatDateTime, formatRelative, shortIdentifier, uniqueSorted } from "../format";
import type { FoldApiClient } from "../api";
import type { FoldLogEntry } from "../types";
import { useCursorList } from "../use-cursor-list";

export function EventsPage({ entries: initialEntries, total, cursor, api }: {
  readonly entries: readonly FoldLogEntry[];
  readonly total: number;
  readonly cursor?: string;
  readonly api: FoldApiClient;
}) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [kind, setKind] = useState("all");
  const [selectedId, setSelectedId] = useState<string>();
  const eventPage = useCursorList({
    initialItems: initialEntries,
    initialTotal: total,
    initialCursor: cursor,
    keyOf: (entry) => entry.event.id,
    loadPage: (nextCursor) => api.listEventsPage({ includeDrafts: true, limit: 100, cursor: nextCursor }),
  });
  const entries = eventPage.items;
  const kinds = useMemo(() => uniqueSorted(entries.map(({ event }) => event.kind)), [entries]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return [...entries]
      .filter((entry) => status === "all" || entry.status === status)
      .filter(({ event }) => kind === "all" || event.kind === kind)
      .filter(({ event }) =>
        !needle || [event.title, event.description, event.kind, event.id, event.author.id, ...Object.values(event.capture.identity ?? {})]
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
      <PageHeader eyebrow="Append-only audit trail" title="Event log" />
      <div className="filter-bar">
        <SearchField value={query} onChange={setQuery} placeholder="Search events" />
        <label className="compact-field"><span>Status</span><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">All statuses</option><option value="canon">Canon</option><option value="draft">Draft</option></select></label>
        <label className="compact-field compact-field--kind"><span>Kind</span><select value={kind} onChange={(event) => setKind(event.target.value)}><option value="all">All kinds</option>{kinds.map((value) => <option key={value} value={value}>{eventKindLabel(value)}</option>)}</select></label>
        <span className="result-count">{filtered.length} shown · {eventPage.total} total</span>
      </div>

      <section className="event-layout">
        <div className="event-table-pane">
          {filtered.length === 0 ? (
            <EmptyState title="No matching events" />
          ) : (
            <div className="table-wrap table-wrap--events">
              <table className="data-table data-table--interactive">
                <thead><tr><th>What happened</th><th>Category</th><th>Context</th><th>When</th><th>Status</th></tr></thead>
                <tbody>
                  {filtered.map(({ event, status: eventStatus }) => (
                    <tr key={event.id} className={event.id === selectedId ? "is-selected" : undefined}>
                      <td><button className="event-cell" type="button" onClick={() => setSelectedId(event.id)}><strong>{eventKindLabel(event.kind)}</strong><span>{event.title}</span></button></td>
                      <td><span className={`event-category event-category--${eventCategory(event.kind).toLowerCase()}`}>{eventCategory(event.kind)}</span></td>
                      <td><span className="event-context"><strong>{event.capture.identity?.project ?? "Workspace"}</strong><small>{event.capture.identity?.agent ?? event.author.kind}</small></span></td>
                      <td><time title={formatDateTime(event.at.t)}>{formatRelative(event.at.t)}</time></td>
                      <td><StatusBadge status={eventStatus} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <LoadMore
                loaded={entries.length}
                total={eventPage.total}
                hasMore={eventPage.cursor !== undefined}
                loading={eventPage.loadingMore}
                error={eventPage.loadError}
                onLoadMore={() => void eventPage.loadMore()}
              />
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
                <div><span className="eyebrow">{eventCategory(selected.event.kind)} · {eventKindLabel(selected.event.kind)}</span><h2>{selected.event.title}</h2></div>
                <StatusBadge status={selected.status} />
              </header>
              {selected.event.description && <p className="inspector-description">{selected.event.description}</p>}
              <dl className="inspector-metadata">
                <div><dt>Event ID</dt><dd><code title={selected.event.id}>{shortIdentifier(selected.event.id, 16, 10)}</code></dd></div>
                <div><dt>Recorded</dt><dd>{formatDateTime(selected.event.at.t)}</dd></div>
                <div><dt>Source</dt><dd>{selected.event.capture.identity?.agent ?? selected.event.author.kind} · {selected.event.capture.identity?.runtime ?? selected.event.author.id}</dd></div>
                <div><dt>Project</dt><dd>{selected.event.capture.identity?.project ?? "Workspace"}</dd></div>
                <div><dt>Session</dt><dd><code>{selected.event.capture.identity?.session === undefined ? "-" : shortIdentifier(selected.event.capture.identity.session)}</code></dd></div>
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
