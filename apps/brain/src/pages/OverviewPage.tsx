import { Activity, ArrowRight, BookOpen, Bot, BrainCircuit, FolderGit2, RadioTower, Route, Wrench } from "lucide-react";
import { useMemo } from "react";

import type { FoldApiClient } from "../api";
import type { BrowserTelemetryOutbox } from "../telemetry-outbox";
import { ProcessingStatus } from "../components/ProcessingStatus";
import { EmptyState, PageHeader } from "../components/Common";
import { formatRelative } from "../format";
import type { BrainPage, BrainSnapshot } from "../types";

function activitySeries(runs: BrainSnapshot["transcriptRuns"]) {
  const counts = new Map<string, number>();
  runs.forEach((run) => {
    const date = (run.endedAt ?? run.startedAt)?.slice(0, 10);
    if (date !== undefined) counts.set(date, (counts.get(date) ?? 0) + 1);
  });
  const observedDates = [...counts.keys()].sort();
  const latest = observedDates.at(-1) ?? new Date().toISOString().slice(0, 10);
  const parsed = Date.parse(`${latest}T00:00:00Z`);
  const dates = Number.isNaN(parsed)
    ? observedDates.slice(-10)
    : Array.from({ length: 10 }, (_, index) =>
        new Date(parsed - (9 - index) * 86_400_000).toISOString().slice(0, 10),
      );
  return dates.map((date) => ({ date, count: counts.get(date) ?? 0 }));
}

export function OverviewPage({
  snapshot,
  navigate, api, outbox,
}: {
  readonly snapshot: BrainSnapshot;
  readonly api: FoldApiClient;
  readonly outbox?: BrowserTelemetryOutbox;
  readonly navigate: (page: BrainPage) => void;
}) {
  const turns = snapshot.transcriptRuns.reduce((sum, run) => sum + run.counts.turns, 0);
  const actions = snapshot.transcriptRuns.reduce((sum, run) => sum + run.counts.actions, 0);
  const activity = useMemo(() => activitySeries(snapshot.transcriptRuns), [snapshot.transcriptRuns]);
  const maximum = Math.max(1, ...activity.map(({ count }) => count));
  const recentRuns = [...snapshot.transcriptRuns]
    .sort((left, right) =>
      (right.endedAt ?? right.startedAt ?? "").localeCompare(left.endedAt ?? left.startedAt ?? ""),
    )
    .slice(0, 6);

  return (
    <div className="page page--overview">
      <PageHeader eyebrow="Workspace pulse" title="Overview" />

      <section className="metrics-band" aria-label="Workspace totals">
        <div className="metric"><span className="metric__icon metric__icon--green"><FolderGit2 aria-hidden="true" /></span><div><strong>{snapshot.transcriptProjects.length}</strong><span>Projects</span></div></div>
        <div className="metric"><span className="metric__icon metric__icon--coral"><Bot aria-hidden="true" /></span><div><strong>{snapshot.transcriptRunTotal}</strong><span>Agent runs</span></div></div>
        <div className="metric"><span className="metric__icon metric__icon--blue"><BookOpen aria-hidden="true" /></span><div><strong>{turns}</strong><span>Recent turns</span></div></div>
        <div className="metric"><span className="metric__icon metric__icon--yellow"><Wrench aria-hidden="true" /></span><div><strong>{actions}</strong><span>Recent actions</span></div></div>
      </section>

      <section className="operations-band" aria-label="System operations">
        <button type="button" onClick={() => navigate("fleet")}><RadioTower aria-hidden="true" /><span><strong>{snapshot.captureHealth === undefined ? "Unavailable" : "Reachable"}</strong><small>Capture daemon</small></span></button>
        <button type="button" onClick={() => navigate("fleet")}><Activity aria-hidden="true" /><span><strong>{snapshot.captureHealth?.activeSessions ?? snapshot.fleet.fleet.sessions.filter(({ availability }) => availability === "available").length}</strong><small>Live sessions</small></span></button>
        <button type="button" onClick={() => navigate("memory")}><BrainCircuit aria-hidden="true" /><span><strong>{snapshot.memoryCandidateTotal}</strong><small>Memory proposals</small></span></button>
        <button type="button" onClick={() => navigate("trajectories")}><Route aria-hidden="true" /><span><strong>{snapshot.trajectoryTaskTotal}</strong><small>Decision trees</small></span></button>
        <button type="button" onClick={() => navigate("fleet")}><RadioTower aria-hidden="true" /><span><strong>{snapshot.fleet.fleet.recoveryActions.length}</strong><small>Recovery actions</small></span></button>
      </section>

      <ProcessingStatus processing={snapshot.processing} api={api} outbox={outbox} />
      <p className="evidence-note">Activity below covers {snapshot.transcriptRuns.length} loaded runs of {snapshot.transcriptRunTotal}; turns, actions and daily counts are a partial view.</p>
      <section className="overview-grid">
        <div className="panel panel--activity">
          <header className="panel__header">
            <div><span className="eyebrow">Historical work</span><h2>Runs by day</h2></div>
            <button className="text-button" type="button" onClick={() => navigate("history")}>Run history <ArrowRight aria-hidden="true" /></button>
          </header>
          <div className="activity-chart" aria-label="Runs by day">
            {activity.map(({ date, count }) => (
              <div className="activity-chart__column" key={date} title={`${date}: ${count} runs`}>
                <span className="activity-chart__value">{count}</span>
                <span className="activity-chart__track"><span style={{ height: `${Math.max(count === 0 ? 3 : 12, (count / maximum) * 100)}%` }} /></span>
                <time dateTime={date}>{date.slice(5)}</time>
              </div>
            ))}
          </div>
        </div>

        <div className="panel panel--memory-preview">
          <header className="panel__header">
            <div><span className="eyebrow">Private recall</span><h2>Recent memory</h2></div>
            <button className="text-button" type="button" onClick={() => navigate("memory")}>Open memory <ArrowRight aria-hidden="true" /></button>
          </header>
          {snapshot.memories.length === 0 ? <EmptyState title="No memories yet" /> : (
            <ol className="memory-preview-list">
              {snapshot.memories.map(({ memory }) => (
                <li key={memory.id}><button type="button" onClick={() => navigate("memory")}><span className="memory-preview-list__summary">{memory.summary || "Untitled memory"}</span><span className="memory-preview-list__meta">{memory.source} · {formatRelative(memory.updatedAt)}</span></button></li>
              ))}
            </ol>
          )}
        </div>
      </section>

      <section className="panel panel--events">
        <header className="panel__header">
          <div><span className="eyebrow">Latest sessions</span><h2>Recent runs</h2></div>
          <button className="text-button" type="button" onClick={() => navigate("history")}>All runs <ArrowRight aria-hidden="true" /></button>
        </header>
        {recentRuns.length === 0 ? <EmptyState title="No runs yet" /> : (
          <div className="table-wrap"><table className="data-table">
            <thead><tr><th>Run</th><th>Source</th><th>Model</th><th>Turns</th><th>Actions</th></tr></thead>
            <tbody>{recentRuns.map((run) => (
              <tr key={run.id}><td><button className="table-link" type="button" onClick={() => navigate("history")}>{run.nativeId}</button></td><td>{run.source}</td><td><code>{run.model ?? "unknown"}</code></td><td>{run.counts.turns}</td><td>{run.counts.actions}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
    </div>
  );
}
