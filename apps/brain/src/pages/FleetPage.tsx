import {
  Activity,
  AlertTriangle,
  Bot,
  CircleOff,
  Clock3,
  Play,
  RadioTower,
  RotateCcw,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { EmptyState, PageHeader } from "../components/Common";
import { formatRelative } from "../format";
import type { FleetResponse, FleetSession, FoldLogEntry } from "../types";

function relativeIso(value: string | undefined): string {
  return value === undefined ? "-" : formatRelative(Date.parse(value));
}

function sessionStatus(session: FleetSession): string {
  return session.status === "unknown" && session.lastKnownStatus !== "unknown"
    ? `unknown · was ${session.lastKnownStatus}`
    : session.status;
}

export function FleetPage({
  response,
  events,
  onSimulate,
}: {
  readonly response: FleetResponse;
  readonly events: readonly FoldLogEntry[];
  readonly onSimulate: () => void;
}) {
  const { sessions, recoveryActions } = response.fleet;
  const [selectedId, setSelectedId] = useState<string>();

  useEffect(() => {
    if (sessions.length === 0) {
      setSelectedId(undefined);
      return;
    }
    if (selectedId === undefined || !sessions.some(({ sessionId }) => sessionId === selectedId)) {
      setSelectedId(sessions[0]!.sessionId);
    }
  }, [selectedId, sessions]);

  const selected = sessions.find(({ sessionId }) => sessionId === selectedId);
  const activityEvents = useMemo(() => {
    if (selected === undefined) return [];
    return events
      .filter(({ event }) => event.capture.identity?.session === selected.sessionId)
      .sort((left, right) => right.event.at.t - left.event.at.t)
      .slice(0, 12);
  }, [events, selected]);
  const available = sessions.filter(({ availability }) => availability === "available").length;
  const active = sessions.filter(({ status }) => status === "busy" || status === "blocked" || status === "ready").length;
  const stale = sessions.filter(({ freshness }) => freshness === "stale").length;

  return (
    <div className="page page--fleet">
      <PageHeader
        eyebrow="Replay-built operations"
        title="Agent fleet"
        actions={response.simulationEnabled ? <button className="button button--primary" type="button" onClick={onSimulate}><Play aria-hidden="true" />Simulate</button> : undefined}
      />

      <section className="fleet-metrics" aria-label="Fleet totals">
        <div><RadioTower aria-hidden="true" /><span><strong>{available}</strong><small>Available</small></span></div>
        <div><Activity aria-hidden="true" /><span><strong>{active}</strong><small>Active</small></span></div>
        <div><Clock3 aria-hidden="true" /><span><strong>{stale}</strong><small>Stale</small></span></div>
        <div><RotateCcw aria-hidden="true" /><span><strong>{recoveryActions.length}</strong><small>Recovery plans</small></span></div>
      </section>

      <section className="fleet-workspace">
        <div className="fleet-session-list">
          <header><span className="eyebrow">Sessions</span><strong>{sessions.length} total</strong></header>
          {sessions.length === 0 ? (
            <div className="fleet-empty"><EmptyState title="No captured sessions" />{response.simulationEnabled && <button className="button button--primary" type="button" onClick={onSimulate}><Play aria-hidden="true" />Simulate</button>}</div>
          ) : sessions.map((session) => (
            <button key={session.sessionId} type="button" className={session.sessionId === selectedId ? "is-selected" : undefined} onClick={() => setSelectedId(session.sessionId)}>
              <span className={`fleet-agent-icon fleet-agent-icon--${session.availability}`}><Bot aria-hidden="true" /></span>
              <span><strong>{session.agentId}</strong><small>{session.taskId}</small><code>{session.sessionId}</code></span>
              <span className={`fleet-status fleet-status--${session.status}`}>{sessionStatus(session)}</span>
            </button>
          ))}
        </div>

        <article className="fleet-inspector">
          {selected === undefined ? (
            <EmptyState title="No session selected" />
          ) : (
            <>
              <header className="fleet-inspector__header">
                <span className={`fleet-agent-icon fleet-agent-icon--${selected.availability}`}><Bot aria-hidden="true" /></span>
                <div><span className="eyebrow">{selected.runtime ?? "runtime"}</span><h2>{selected.agentId}</h2><code>{selected.sessionId}</code></div>
                <span className={`fleet-status fleet-status--${selected.status}`}>{sessionStatus(selected)}</span>
              </header>

              <dl className="fleet-metadata">
                <div><dt>Task</dt><dd>{selected.taskId}</dd></div>
                <div><dt>Repository</dt><dd>{selected.repo}</dd></div>
                <div><dt>Branch</dt><dd>{selected.branch}</dd></div>
                <div><dt>Sensor</dt><dd><code>{selected.sensor}</code></dd></div>
                <div><dt>Availability</dt><dd>{selected.availability}</dd></div>
                <div><dt>Freshness</dt><dd>{selected.freshness}</dd></div>
                <div><dt>Last heartbeat</dt><dd>{relativeIso(selected.lastSeenAt)}</dd></div>
                <div><dt>Last activity</dt><dd>{relativeIso(selected.lastObservedAt)}</dd></div>
              </dl>

              {selected.orphaned && (
                <div className="fleet-warning">
                  <AlertTriangle aria-hidden="true" />
                  <span><strong>Reconciliation planned</strong><small>{recoveryActions.find(({ sessionId }) => sessionId === selected.sessionId)?.reason}</small></span>
                </div>
              )}
              {selected.lastDeclaredLifecyclePhase === "offline" && (
                <div className="fleet-offline"><CircleOff aria-hidden="true" /><span>Explicitly stopped</span></div>
              )}

              <section className="fleet-activity">
                <header><span className="eyebrow">Canonical activity</span><strong>{activityEvents.length} recent</strong></header>
                {activityEvents.length === 0 ? <EmptyState title="No activity records" /> : (
                  <ol>
                    {activityEvents.map(({ event }) => (
                      <li key={event.id}>
                        <span className="fleet-activity__mark" />
                        <span><strong>{event.title}</strong><small><code>{event.kind}</code> · {formatRelative(event.at.t)}</small></span>
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            </>
          )}
        </article>
      </section>
    </div>
  );
}
