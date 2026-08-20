import { ArrowRight, BookOpen, Braces, CircleDot, Network } from "lucide-react";
import { useMemo } from "react";

import { formatRelative } from "../format";
import type { BrainSnapshot, FoldLogEntry } from "../types";
import { EmptyState, PageHeader, StatusBadge } from "../components/Common";

function activitySeries(events: readonly FoldLogEntry[]) {
  const counts = new Map<string, number>();
  events.forEach(({ event }) => {
    const date = event.at.worldDate.slice(0, 10);
    counts.set(date, (counts.get(date) ?? 0) + 1);
  });
  const observedDates = [...counts.keys()].sort();
  const latest = observedDates.at(-1) ?? new Date().toISOString().slice(0, 10);
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(latest) ? Date.parse(`${latest}T00:00:00Z`) : Number.NaN;
  const dates = Number.isNaN(parsed)
    ? observedDates.slice(-10)
    : Array.from({ length: 10 }, (_, index) =>
        new Date(parsed - (9 - index) * 86_400_000).toISOString().slice(0, 10),
      );
  return dates.map((date) => ({ date, count: counts.get(date) ?? 0 }));
}

export function OverviewPage({
  snapshot,
  navigate,
}: {
  readonly snapshot: BrainSnapshot;
  readonly navigate: (page: "memory" | "events" | "state") => void;
}) {
  const state = snapshot.projection.state;
  const canonical = snapshot.events.filter((entry) => entry.status === "canon").length;
  const drafts = snapshot.events.length - canonical;
  const activity = useMemo(() => activitySeries(snapshot.events), [snapshot.events]);
  const maximum = Math.max(1, ...activity.map(({ count }) => count));
  const recentEvents = [...snapshot.events].sort((a, b) => b.event.at.t - a.event.at.t).slice(0, 6);
  const recentMemories = [...snapshot.memories]
    .sort((a, b) => b.memory.updatedAt - a.memory.updatedAt)
    .slice(0, 4);

  return (
    <div className="page page--overview">
      <PageHeader eyebrow="Workspace pulse" title="Overview" />

      <section className="metrics-band" aria-label="Workspace totals">
        <div className="metric">
          <span className="metric__icon metric__icon--green"><CircleDot aria-hidden="true" /></span>
          <div><strong>{canonical}</strong><span>Canonical events</span></div>
        </div>
        <div className="metric">
          <span className="metric__icon metric__icon--coral"><BookOpen aria-hidden="true" /></span>
          <div><strong>{snapshot.memories.length}</strong><span>Personal memories</span></div>
        </div>
        <div className="metric">
          <span className="metric__icon metric__icon--blue"><Network aria-hidden="true" /></span>
          <div><strong>{state.nodes.length}</strong><span>Projected nodes</span></div>
        </div>
        <div className="metric">
          <span className="metric__icon metric__icon--yellow"><Braces aria-hidden="true" /></span>
          <div><strong>{drafts}</strong><span>Draft events</span></div>
        </div>
      </section>

      <section className="overview-grid">
        <div className="panel panel--activity">
          <header className="panel__header">
            <div><span className="eyebrow">Fold log</span><h2>Event activity</h2></div>
            <button className="text-button" type="button" onClick={() => navigate("events")}>
              All events <ArrowRight aria-hidden="true" />
            </button>
          </header>
          <div className="activity-chart" aria-label="Events by world date">
            {activity.map(({ date, count }) => (
              <div className="activity-chart__column" key={date} title={`${date}: ${count} events`}>
                <span className="activity-chart__value">{count}</span>
                <span className="activity-chart__track">
                  <span style={{ height: `${Math.max(count === 0 ? 3 : 12, (count / maximum) * 100)}%` }} />
                </span>
                <time dateTime={date}>{date.slice(5)}</time>
              </div>
            ))}
          </div>
        </div>

        <div className="panel panel--memory-preview">
          <header className="panel__header">
            <div><span className="eyebrow">Private recall</span><h2>Recent memory</h2></div>
            <button className="text-button" type="button" onClick={() => navigate("memory")}>
              Open memory <ArrowRight aria-hidden="true" />
            </button>
          </header>
          {recentMemories.length === 0 ? (
            <EmptyState title="No memories yet" />
          ) : (
            <ol className="memory-preview-list">
              {recentMemories.map(({ memory }) => (
                <li key={memory.id}>
                  <button type="button" onClick={() => navigate("memory")}>
                    <span className="memory-preview-list__summary">{memory.summary || "Untitled memory"}</span>
                    <span className="memory-preview-list__meta">
                      {memory.source} · {formatRelative(memory.updatedAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          )}
        </div>
      </section>

      <section className="panel panel--events">
        <header className="panel__header">
          <div><span className="eyebrow">Latest changes</span><h2>Recent events</h2></div>
          <span className="panel__meta">{state.diagnostics.length} diagnostics</span>
        </header>
        {recentEvents.length === 0 ? (
          <EmptyState title="No events yet" />
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>Event</th><th>Kind</th><th>World date</th><th>Changes</th><th>Status</th></tr></thead>
              <tbody>
                {recentEvents.map(({ event, status }) => (
                  <tr key={event.id}>
                    <td><button className="table-link" type="button" onClick={() => navigate("events")}>{event.title}</button></td>
                    <td><code>{event.kind}</code></td>
                    <td><time>{event.at.worldDate}</time></td>
                    <td>{event.changes.length}</td>
                    <td><StatusBadge status={status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
