import { Activity, AlertTriangle, Bot, CircleOff, Clock3, FileJson, RadioTower, RotateCcw, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { FoldApiClient } from "../api";
import { EmptyState, PageHeader, SearchField } from "../components/Common";
import { LoadMore } from "../components/LoadMore";
import { formatRelative } from "../format";
import type { CaptureHealth, CursorPage, FleetResponse, FleetSession, FoldLogEntry, HookArtifact, HookSource } from "../types";
import { useCursorList } from "../use-cursor-list";

type SessionFilter = "all" | "active" | "stale" | "offline";

function hookArtifactRef(entry: FoldLogEntry): { readonly id: string; readonly source: HookSource } | undefined {
  const runtime = entry.event.capture.identity?.runtime;
  const source: HookSource = runtime === "claude" || runtime === "claude-code"
    ? "claude-code"
    : runtime === "codex" || runtime === "hermes" ? runtime : "unknown";
  for (const change of [...entry.event.changes].reverse()) {
    const after = "after" in change && typeof change.after === "object" && change.after !== null && !Array.isArray(change.after)
      ? change.after as Readonly<Record<string, unknown>>
      : undefined;
    const data = typeof after?.data === "object" && after.data !== null && !Array.isArray(after.data)
      ? after.data as Readonly<Record<string, unknown>>
      : undefined;
    if (typeof data?.artifactId === "string" && /^[a-f0-9]{64}$/i.test(data.artifactId)) {
      return { id: data.artifactId, source };
    }
  }
  return undefined;
}

function relativeIso(value: string | undefined): string {
  return value === undefined ? "-" : formatRelative(Date.parse(value));
}

function sessionStatus(session: FleetSession): string {
  return session.status === "unknown" && session.lastKnownStatus !== "unknown"
    ? `unknown · was ${session.lastKnownStatus}`
    : session.status;
}

function SessionActivity({ sessionId, api }: { readonly sessionId: string; readonly api: FoldApiClient }) {
  const [firstPage, setFirstPage] = useState<CursorPage<FoldLogEntry>>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    setFirstPage(undefined);
    setError(undefined);
    void api.listEventsPage({ includeDrafts: true, sessionId, limit: 100 }).then(
      (page) => { if (active) setFirstPage(page); },
      (caught: unknown) => { if (active) setError(caught instanceof Error ? caught.message : "Activity unavailable"); },
    );
    return () => { active = false; };
  }, [api, sessionId]);

  if (error !== undefined) return <div className="fleet-activity-error"><AlertTriangle aria-hidden="true" />{error}</div>;
  if (firstPage === undefined) return <div className="trajectory-loading"><span /><span /><span /></div>;
  return <SessionActivityList key={sessionId} sessionId={sessionId} api={api} firstPage={firstPage} />;
}

function SessionActivityList({ sessionId, api, firstPage }: {
  readonly sessionId: string;
  readonly api: FoldApiClient;
  readonly firstPage: CursorPage<FoldLogEntry>;
}) {
  const [artifact, setArtifact] = useState<HookArtifact>();
  const [artifactLoading, setArtifactLoading] = useState(false);
  const [artifactError, setArtifactError] = useState<string>();
  const page = useCursorList({
    initialItems: firstPage.items,
    initialTotal: firstPage.total,
    initialCursor: firstPage.nextCursor,
    keyOf: (entry) => entry.event.id,
    loadPage: (cursor) => api.listEventsPage({ includeDrafts: true, sessionId, limit: 100, cursor }),
  });

  const inspectArtifact = async (entry: FoldLogEntry) => {
    const reference = hookArtifactRef(entry);
    if (reference === undefined) return;
    setArtifact(undefined);
    setArtifactError(undefined);
    setArtifactLoading(true);
    try {
      setArtifact(await api.hookArtifact(reference.source, reference.id));
    } catch (caught) {
      setArtifactError(caught instanceof Error ? caught.message : "Hook artifact unavailable");
    } finally {
      setArtifactLoading(false);
    }
  };

  return (
    <section className="fleet-activity">
      <header><span className="eyebrow">Canonical activity</span><strong>{page.items.length} / {page.total}</strong></header>
      {page.items.length === 0 ? <EmptyState title="No activity records" /> : <ol>
        {page.items.map((entry) => {
          const { event, status } = entry;
          const reference = hookArtifactRef(entry);
          const content = <><span className={`fleet-activity__mark fleet-activity__mark--${status}`} /><span><strong>{event.title}</strong><small><code>{event.kind}</code> · {formatRelative(event.at.t)} · {status}</small></span>{reference !== undefined && <FileJson aria-hidden="true" />}</>;
          return <li key={event.id}>{reference === undefined ? <div className="fleet-activity__row">{content}</div> : <button className="fleet-activity__row" type="button" title="Inspect retained hook record" onClick={() => void inspectArtifact(entry)}>{content}</button>}</li>;
        })}
      </ol>}
      {(artifactLoading || artifactError !== undefined || artifact !== undefined) && <article className="hook-artifact-inspector">
        <header><span><FileJson aria-hidden="true" /><strong>Retained hook record</strong></span><button className="icon-button" type="button" aria-label="Close hook record" title="Close" onClick={() => { setArtifact(undefined); setArtifactError(undefined); }}><X aria-hidden="true" /></button></header>
        {artifactLoading ? <div className="trajectory-loading"><span /><span /><span /></div> : artifactError !== undefined ? <div className="fleet-activity-error"><AlertTriangle aria-hidden="true" />{artifactError}</div> : artifact === undefined ? null : <><dl><div><dt>Source</dt><dd>{artifact.source}</dd></div><div><dt>Received</dt><dd>{new Date(artifact.receivedAt).toLocaleString()}</dd></div><div><dt>Artifact</dt><dd><code>{artifact.id}</code></dd></div></dl><pre>{JSON.stringify(artifact.payload, null, 2)}</pre></>}
      </article>}
      <LoadMore loaded={page.items.length} total={page.total} hasMore={page.cursor !== undefined} loading={page.loadingMore} error={page.loadError} onLoadMore={() => void page.loadMore()} />
    </section>
  );
}

export function FleetPage({ response, api }: { readonly response: FleetResponse; readonly api: FoldApiClient }) {
  const { sessions, recoveryActions } = response.fleet;
  const [selectedId, setSelectedId] = useState<string>();
  const [filter, setFilter] = useState<SessionFilter>("all");
  const [query, setQuery] = useState("");
  const [health, setHealth] = useState<CaptureHealth>();
  const [healthError, setHealthError] = useState<string>();
  const filteredSessions = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return sessions.filter((session) => {
      if (filter === "active" && !["busy", "blocked", "ready"].includes(session.status)) return false;
      if (filter === "stale" && session.freshness !== "stale") return false;
      if (filter === "offline" && session.lastDeclaredLifecyclePhase !== "offline") return false;
      return needle.length === 0 || [session.agentId, session.taskId, session.sessionId, session.repo, session.branch, session.runtime]
        .some((value) => value?.toLowerCase().includes(needle));
    });
  }, [filter, query, sessions]);

  useEffect(() => {
    let active = true;
    void api.captureHealth().then(
      (next) => { if (active) { setHealth(next); setHealthError(undefined); } },
      (caught: unknown) => { if (active) setHealthError(caught instanceof Error ? caught.message : "Capture daemon unavailable"); },
    );
    return () => { active = false; };
  }, [api, response.fleet.rebuiltAt]);

  useEffect(() => {
    if (filteredSessions.length === 0) { setSelectedId(undefined); return; }
    if (selectedId === undefined || !filteredSessions.some(({ sessionId }) => sessionId === selectedId)) setSelectedId(filteredSessions[0]!.sessionId);
  }, [filteredSessions, selectedId]);

  const selected = sessions.find(({ sessionId }) => sessionId === selectedId);
  const available = sessions.filter(({ availability }) => availability === "available").length;
  const active = sessions.filter(({ status }) => status === "busy" || status === "blocked" || status === "ready").length;
  const stale = sessions.filter(({ freshness }) => freshness === "stale").length;

  return <div className="page page--fleet">
    <PageHeader eyebrow="Replay-built operations" title="Agent fleet" />
    <section className="fleet-metrics" aria-label="Fleet totals">
      <div><RadioTower aria-hidden="true" /><span><strong>{available}</strong><small>Available</small></span></div>
      <div><Activity aria-hidden="true" /><span><strong>{active}</strong><small>Active</small></span></div>
      <div><Clock3 aria-hidden="true" /><span><strong>{stale}</strong><small>Stale</small></span></div>
      <div><RotateCcw aria-hidden="true" /><span><strong>{recoveryActions.length}</strong><small>Recovery plans</small></span></div>
    </section>
    <section className={`capture-health${healthError !== undefined || (health?.failedJobs ?? 0) > 0 ? " capture-health--warning" : ""}`}>
      <span className="capture-health__status"><span className="connection-dot" /><strong>{healthError === undefined ? "Capture online" : "Capture unavailable"}</strong></span>
      {health === undefined ? <small>{healthError ?? "Checking daemon"}</small> : <>
        <span><strong>{health.receivedHooks.toLocaleString()}</strong><small>hooks received</small></span>
        <span><strong>{health.activeSessions}</strong><small>live sessions</small></span>
        <span><strong>{health.pendingJobs}</strong><small>relay pending</small></span>
        <span><strong>{health.failedJobs}</strong><small>quarantined jobs</small></span>
        <span><strong>{health.relayFailures.count}</strong><small>hook relay misses</small></span>
        <span><strong>{health.truncatedSteps}</strong><small>truncated steps</small></span>
        <span><strong>{health.policy.reasoning}</strong><small>reasoning capture</small></span>
      </>}
    </section>
    <div className="fleet-toolbar">
      <SearchField value={query} onChange={setQuery} placeholder="Search sessions" />
      <div className="segmented-control" role="group" aria-label="Session status">{(["all", "active", "stale", "offline"] as const).map((value) => <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}>{value}</button>)}</div>
      <span className="result-count">{filteredSessions.length} / {sessions.length}</span>
    </div>
    <section className="fleet-workspace">
      <div className="fleet-session-list">
        <header><span className="eyebrow">Sessions</span><strong>{filteredSessions.length} shown</strong></header>
        {filteredSessions.length === 0 ? <div className="fleet-empty"><EmptyState title="No matching sessions" /></div> : filteredSessions.map((session) => <button key={session.sessionId} type="button" className={session.sessionId === selectedId ? "is-selected" : undefined} onClick={() => setSelectedId(session.sessionId)}>
          <span className={`fleet-agent-icon fleet-agent-icon--${session.availability}`}><Bot aria-hidden="true" /></span>
          <span><strong>{session.agentId}</strong><small>{session.taskId}</small><code>{session.sessionId}</code></span>
          <span className={`fleet-status fleet-status--${session.status}`}>{sessionStatus(session)}</span>
        </button>)}
      </div>
      <article className="fleet-inspector">{selected === undefined ? <EmptyState title="No session selected" /> : <>
        <header className="fleet-inspector__header"><span className={`fleet-agent-icon fleet-agent-icon--${selected.availability}`}><Bot aria-hidden="true" /></span><div><span className="eyebrow">{selected.runtime ?? "runtime"}</span><h2>{selected.agentId}</h2><code>{selected.sessionId}</code></div><span className={`fleet-status fleet-status--${selected.status}`}>{sessionStatus(selected)}</span></header>
        <dl className="fleet-metadata">
          <div><dt>Task</dt><dd>{selected.taskId}</dd></div><div><dt>Repository</dt><dd>{selected.repo}</dd></div><div><dt>Branch</dt><dd>{selected.branch}</dd></div><div><dt>Sensor</dt><dd><code>{selected.sensor}</code></dd></div><div><dt>Availability</dt><dd>{selected.availability}</dd></div><div><dt>Freshness</dt><dd>{selected.freshness}</dd></div><div><dt>Last heartbeat</dt><dd>{relativeIso(selected.lastSeenAt)}</dd></div><div><dt>Last activity</dt><dd>{relativeIso(selected.lastObservedAt)}</dd></div>
        </dl>
        {selected.orphaned && <div className="fleet-warning"><AlertTriangle aria-hidden="true" /><span><strong>Reconciliation planned</strong><small>{recoveryActions.find(({ sessionId }) => sessionId === selected.sessionId)?.reason}</small></span></div>}
        {selected.lastDeclaredLifecyclePhase === "offline" && <div className="fleet-offline"><CircleOff aria-hidden="true" /><span>Explicitly stopped</span></div>}
        <SessionActivity key={selected.sessionId} sessionId={selected.sessionId} api={api} />
      </>}</article>
    </section>
  </div>;
}
