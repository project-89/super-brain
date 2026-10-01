import { ArrowLeft, FileText, History, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { FoldApiClient } from "../api";
import { EmptyState, PageHeader } from "../components/Common";
import { LoadMore } from "../components/LoadMore";
import { formatDateTime } from "../format";
import { focusCitation, mergeEpisodePages, type SourceFocus } from "../episode-view";
import type { Episode, EpisodeClaim, EpisodePage, EpisodeWindow } from "../episode-types";
import { EpisodeEvidence } from "../components/EpisodeEvidence";

function message(error: unknown) { return error instanceof Error ? error.message : "Episode request failed"; }
function usePages<T>(load: (cursor?: string) => Promise<EpisodePage<T>>, key: (item: T) => string, version: number) {
  const [page, setPage] = useState<EpisodePage<T>>(); const [error, setError] = useState<string>(); const [loading, setLoading] = useState(true);
  const generation = useRef(0); const cursors = useRef(new Set<string>()); const keyRef = useRef(key); keyRef.current = key;
  useEffect(() => {
    const request = ++generation.current; setPage(undefined); setError(undefined); setLoading(true); cursors.current.clear();
    void load().then(next => { if (generation.current === request) { setPage(next); if (next.nextCursor !== undefined) cursors.current.add(next.nextCursor); } }, caught => { if (generation.current === request) setError(message(caught)); }).finally(() => { if (generation.current === request) setLoading(false); });
    return () => { generation.current++; };
  }, [load, version]);
  const more = async () => {
    if (loading || page?.nextCursor === undefined) return;
    const request = generation.current; setLoading(true); setError(undefined);
    try {
      const next = await load(page.nextCursor); if (generation.current !== request) return;
      if (next.nextCursor !== undefined && cursors.current.has(next.nextCursor)) throw new Error("Repeated source cursor. Refresh this view.");
      if (next.nextCursor !== undefined) cursors.current.add(next.nextCursor);
      setPage(mergeEpisodePages(page, next, keyRef.current));
    } catch (caught) { if (generation.current === request) { setPage(undefined); setError(message(caught)); } }
    finally { if (generation.current === request) setLoading(false); }
  };
  return { page, error, loading, more };
}
function Pages<T>({ state, empty, children }: { state: ReturnType<typeof usePages<T>>; empty: string; children: (items: T[]) => ReactNode }) {
  if (state.page === undefined) return <div className="identity-status" role={state.error ? "alert" : "status"}>{state.error ?? "Loading records"}</div>;
  return <>{state.page.items.length === 0 ? <EmptyState title={empty} /> : children(state.page.items)}<LoadMore loaded={state.page.items.length} total={state.page.total} hasMore={state.page.nextCursor !== undefined} loading={state.loading} {...(state.error === undefined ? {} : { error: state.error })} onLoadMore={() => void state.more()} /></>;
}
function Claim({ claim, onSource }: { claim: EpisodeClaim; onSource: (id: SourceFocus) => void }) {
  return <div className="episode-claim"><p>{claim.text}</p><div className="episode-citations">{claim.citations.map((citation, index) => <button className="episode-citation" key={`${citation.eventId}:${index}`} onClick={() => onSource(citation)} title={`Source ${citation.eventId}`}><FileText size={14} />Source {index + 1}{citation.recordOrdinal === undefined ? "" : `, record ${citation.recordOrdinal}`}{citation.line === undefined ? "" : `, line ${citation.line}`}</button>)}</div></div>;
}
function Claims({ title, claims, onSource }: { title: string; claims: EpisodeClaim[]; onSource: (id: SourceFocus) => void }) {
  return <section className="episode-section"><h3>{title}</h3>{claims.length === 0 ? <p className="muted">None proposed from this evidence.</p> : claims.map((claim, index) => <Claim key={index} claim={claim} onSource={onSource} />)}</section>;
}
function EpisodeBody({ episode, onSource }: { episode: Episode; onSource: (id: SourceFocus) => void }) {
  return <><div className="episode-facts"><span>Proposed, not independently verified</span><span>Grouping confidence: {episode.grouping.confidence}</span><span>{episode.audience} audience</span></div>
    <Claims title="Objective" claims={[episode.objective]} onSource={onSource} /><Claims title="Summary" claims={[episode.summary]} onSource={onSource} />
    <Claims title="Decisions" claims={episode.decisions} onSource={onSource} /><Claims title="Checks and reported outcomes" claims={episode.checks} onSource={onSource} />
    <Claims title="Blockers" claims={episode.blockers} onSource={onSource} /><Claims title="Open questions" claims={episode.openQuestions} onSource={onSource} />
    <Claims title="Why these records belong together" claims={[episode.grouping.reason]} onSource={onSource} />
    <section className="episode-section"><h3>Uncertainty</h3>{episode.grouping.uncertainties.length === 0 ? <p>No explicit uncertainty supplied by the producer. This does not establish certainty.</p> : <ul>{episode.grouping.uncertainties.map((item, index) => <li key={index}>{item}</li>)}</ul>}</section>
    {episode.continuations.length > 0 && <section className="episode-section"><h3>Related episode revisions</h3>{episode.continuations.map(link => <div key={`${link.episodeId}:${link.revision}`}><code>{link.episodeId}</code><Claim claim={link.reason} onSource={onSource} /></div>)}</section>}
  </>;
}
function Sources({ api, id, window, version, focus, revision }: { api: FoldApiClient; id: string; window: boolean; version: number; focus: SourceFocus | undefined; revision: string }) {
  const citation = focusCitation(focus);
  const load = useCallback((cursor?: string) => api.episodeSources(id, window, cursor, citation?.eventId, revision), [api, id, window, citation?.eventId, revision]);
  const state = usePages(load, item => item.eventId, version);
  return <section className="episode-section"><h3>{citation ? "Cited source evidence" : "Authorized source evidence"}</h3><Pages state={state} empty="No source records available">{items => items.map(source => <EpisodeEvidence key={source.eventId} source={source} citation={source.eventId === citation?.eventId ? citation : undefined} />)}</Pages></section>;
}
function RevisionHistory({ api, id, version, onSource }: { api: FoldApiClient; id: string; version: number; onSource: (id: SourceFocus) => void }) {
  const load = useCallback((cursor?: string) => api.episodeHistory(id, cursor), [api, id]); const state = usePages(load, item => item.revision, version);
  return <Pages state={state} empty="No revisions available">{items => items.map(episode => <details className="episode-section" key={episode.revision}><summary>{formatDateTime(episode.recordedAt)}: {episode.title}</summary><code>{episode.revision}</code><EpisodeBody episode={episode} onSource={onSource} /></details>)}</Pages>;
}
function Detail({ api, selection, version, onBack }: { api: FoldApiClient; selection: { id: string; window: boolean }; version: number; onBack: () => void }) {
  const [record, setRecord] = useState<Episode | EpisodeWindow>(); const [error, setError] = useState<string>(); const [view, setView] = useState<"summary" | "sources" | "history">("summary"); const [focus, setFocus] = useState<SourceFocus>();
  useEffect(() => { let active = true; setRecord(undefined); setError(undefined); setView("summary"); setFocus(undefined);
    void (selection.window ? api.episodeWindow(selection.id) : api.workEpisode(selection.id)).then(value => { if (active) setRecord(value); }, caught => { if (active) setError(message(caught)); });
    return () => { active = false; };
  }, [api, selection.id, selection.window, version]);
  const onSource = (id: SourceFocus) => { setFocus(id); setView("sources"); };
  const window = record !== undefined && "input" in record ? record : undefined; const episode = record !== undefined && "episodeId" in record ? record : undefined;
  return <><button className="button button--secondary" onClick={onBack}><ArrowLeft />Back to {selection.window ? "source windows" : "episodes"}</button>{record === undefined ? <div className="identity-status" role={error ? "alert" : "status"}>{error ?? "Loading current authorized evidence"}</div> : <>
    <header className="episode-detail-header"><h2>{episode?.title ?? `${window!.input.episodes.length} proposed episodes from ${window!.input.sources.length} source events`}</h2><p>{record.projectName ?? "Unresolved project"} · Generated {formatDateTime(record.recordedAt)} · Unattributed</p><p>Evidence current at this read. Coverage is limited to authorized retained source events. Event coverage does not mean every transcript record was used. Generation and archive timestamps do not establish when a person worked.</p><code>{selection.id}</code></header>
    <div className="segmented-control episode-tabs" role="tablist" aria-label="Episode detail">{(["summary", "sources", ...(episode === undefined ? [] : ["history"])] as const).map(tab => <button role="tab" aria-selected={view === tab} className={view === tab ? "is-active" : ""} key={tab} onClick={() => { setFocus(undefined); setView(tab as typeof view); }}>{tab === "summary" ? "Summary" : tab === "sources" ? "Source evidence" : "Revision history"}</button>)}</div>
    {view === "summary" && episode && <><EpisodeBody episode={episode} onSource={onSource} /><WindowProvenance api={api} id={episode.windowId} version={version} /></>}
    {view === "summary" && window && <><WindowBody record={window} onSource={onSource} />{window.input.episodes.map(item => <section className="episode-section" key={item.episodeId}><h2>{item.title}</h2><EpisodeBody episode={item} onSource={onSource} /></section>)}</>}
    {view === "sources" && <Sources api={api} id={selection.id} window={selection.window} version={version} focus={focus} revision={record.revision} />}
    {view === "history" && episode && <RevisionHistory api={api} id={selection.id} version={version} onSource={onSource} />}
  </>}</>;
}
function WindowBody({ record, onSource }: { record: EpisodeWindow; onSource?: (id: SourceFocus) => void }) {
  const input = record.input;
  return <section className="episode-section"><h3>Window coverage and provenance</h3><dl className="episode-metadata"><dt>Sources</dt><dd>{input.sources.length} source events; {input.ungrouped.length} ungrouped</dd><dt>Trigger</dt><dd>{input.trigger}</dd><dt>Producer</dt><dd>{input.producer.id}{input.producer.model ? ` (${input.producer.model})` : ""}</dd><dt>Revision</dt><dd><code>{record.revision}</code></dd>{input.parentWindowId && <><dt>Split from</dt><dd><code>{input.parentWindowId}</code></dd></>}<dt>Selected related context</dt><dd>{input.contextEpisodes?.length ?? 0} episode revisions; not an exhaustive project search</dd></dl>
    {input.ungrouped.length > 0 && <><h3>Ungrouped sources</h3><ul className="episode-ungrouped">{input.ungrouped.map(item => <li key={item.eventId}><p>{item.reason}</p>{onSource ? <button className="episode-citation" onClick={() => onSource(item.eventId)}><FileText size={14} /><code>{item.eventId}</code></button> : <code>{item.eventId}</code>}</li>)}</ul></>}
  </section>;
}
function WindowProvenance({ api, id, version }: { api: FoldApiClient; id: string; version: number }) {
  const [record, setRecord] = useState<EpisodeWindow>(); const [error, setError] = useState<string>();
  useEffect(() => { let active = true; setRecord(undefined); setError(undefined); void api.episodeWindow(id).then(value => { if (active) setRecord(value); }, caught => { if (active) setError(message(caught)); }); return () => { active = false; }; }, [api, id, version]);
  return record ? <WindowBody record={record} /> : <p role={error ? "alert" : "status"}>{error ?? "Loading source window"}</p>;
}
function ProjectFilter({ api, value, onChange }: { api: FoldApiClient; value: string; onChange: (id: string) => void }) {
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]); const [cursor, setCursor] = useState<string>(); const [error, setError] = useState<string>(); const [busy, setBusy] = useState(false);
  const generation = useRef(0); const seen = useRef(new Set<string>());
  useEffect(() => { const request = ++generation.current; setProjects([]); setCursor(undefined); seen.current.clear(); setError(undefined); setBusy(true); void api.identityProjects().then(page => { if (request === generation.current) { setProjects([...page.items]); setCursor(page.nextCursor); if (page.nextCursor) seen.current.add(page.nextCursor); } }, caught => { if (request === generation.current) setError(message(caught)); }).finally(() => { if (request === generation.current) setBusy(false); }); return () => { generation.current++; }; }, [api]);
  const more = async () => { if (!cursor || busy) return; const request = generation.current; setBusy(true); try { const page = await api.identityProjects(cursor); if (request !== generation.current) return; if (page.nextCursor && seen.current.has(page.nextCursor)) throw new Error("Project cursor repeated. Refresh the page."); if (page.nextCursor) seen.current.add(page.nextCursor); setProjects(previous => [...new Map([...previous, ...page.items].map(item => [item.id, item])).values()]); setCursor(page.nextCursor); } catch (caught) { if (request === generation.current) setError(message(caught)); } finally { if (request === generation.current) setBusy(false); } };
  return <div className="episode-project-filter"><label className="compact-field"><span>Project</span><select value={value} onChange={event => onChange(event.target.value)}><option value="">All authorized projects</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>{cursor && <button className="button button--secondary" disabled={busy} onClick={() => void more()}>More projects</button>}{error && <span role="alert">{error}</span>}</div>;
}
function EpisodeList({ api, projectId, version, onSelect }: { api: FoldApiClient; projectId: string; version: number; onSelect: (id: string) => void }) {
  const load = useCallback((cursor?: string) => api.workEpisodes({ ...(cursor === undefined ? {} : { cursor }), ...(projectId ? { projectId } : {}) }), [api, projectId]); const state = usePages(load, item => item.episodeId, version);
  return <Pages state={state} empty="No current authorized episodes">{items => <div className="episode-list">{items.map(item => <button className="episode-row" key={item.episodeId} onClick={() => onSelect(item.episodeId)}><span><strong>{item.title}</strong><span>{item.projectName ?? "Unresolved project"}</span><span>{item.summary.text}</span></span><span><span>Proposed · {item.grouping.confidence} grouping confidence</span><time>Generated {formatDateTime(item.recordedAt)}</time><span>{item.memberEventIds.length} source events</span></span></button>)}</div>}</Pages>;
}
function WindowList({ api, projectId, version, onSelect }: { api: FoldApiClient; projectId: string; version: number; onSelect: (id: string) => void }) {
  const load = useCallback((cursor?: string) => api.episodeWindows({ ...(cursor === undefined ? {} : { cursor }), ...(projectId ? { projectId } : {}) }), [api, projectId]); const state = usePages(load, item => item.windowId, version);
  return <Pages state={state} empty="No current authorized source windows">{items => <div className="episode-list">{items.map(item => <button className="episode-row" key={item.windowId} onClick={() => onSelect(item.windowId)}><span><strong>{item.projectName ?? "Unresolved project"}</strong><span>{item.episodeCount === 0 ? "No semantic episodes proposed" : `${item.episodeCount} proposed episodes`}</span><span>{item.producer.id}</span></span><span><time>Generated {formatDateTime(item.recordedAt)}</time><span>{item.sourceCount} source events · {item.ungroupedCount} ungrouped</span></span></button>)}</div>}</Pages>;
}
export function EpisodesPage({ api, refreshVersion }: { api: FoldApiClient; refreshVersion: number }) {
  const [tab, setTab] = useState<"episodes" | "windows">("episodes"); const [version, setVersion] = useState(0); const [projectId, setProjectId] = useState(""); const [selection, setSelection] = useState<{ id: string; window: boolean }>();
  return <section className="page episodes-page"><PageHeader eyebrow="Work evidence" title="Episodes" actions={<button className="icon-button" title="Refresh episodes" aria-label="Refresh episodes" onClick={() => setVersion(value => value + 1)}><RefreshCw /></button>} />
    {selection ? <Detail api={api} selection={selection} version={version + refreshVersion} onBack={() => setSelection(undefined)} /> : <><div className="episode-toolbar"><div className="segmented-control episode-tabs" role="tablist" aria-label="Episode views"><button role="tab" aria-selected={tab === "episodes"} className={tab === "episodes" ? "is-active" : ""} onClick={() => setTab("episodes")}><History />Episodes</button><button role="tab" aria-selected={tab === "windows"} className={tab === "windows" ? "is-active" : ""} onClick={() => setTab("windows")}><FileText />Source windows</button></div><ProjectFilter api={api} value={projectId} onChange={setProjectId} /></div>
      <p className="episode-coverage">Current authorized evidence only. Missing, stale, or inaccessible sources are not included; these counts do not establish complete workflow coverage.</p>
      {tab === "episodes" ? <EpisodeList api={api} projectId={projectId} version={version + refreshVersion} onSelect={id => setSelection({ id, window: false })} /> : <WindowList api={api} projectId={projectId} version={version + refreshVersion} onSelect={id => setSelection({ id, window: true })} />}
    </>}
  </section>;
}
