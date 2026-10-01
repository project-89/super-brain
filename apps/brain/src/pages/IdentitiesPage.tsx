import { ArrowRight, Check, Eye, History, Link2, Pencil, Plus, RefreshCw, Unlink, Users } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import type { FoldApiClient } from "../api";
import { EmptyState, PageHeader } from "../components/Common";
import { LoadMore } from "../components/LoadMore";
import { Modal } from "../components/Modal";
import { formatDateTime } from "../format";
import { uuidV7 } from "../ids";
import { evidenceIds, identityHistoryLabel, identityInputProblem, IdentityPageChangedError, matchesIdentityReview, mergeIdentityPages, withIdentitySource, type IdentityReviewInput } from "../identity-review";
import type { IdentityAttributionInput, IdentityEntity, IdentityEntityInput, IdentityKind, IdentityPage, IdentityProject, ProjectAliasInput, ProjectAliasPreview } from "../identity-types";

type Tab = "entities" | "attributions" | "aliases" | "history";
type Dialog = { readonly kind: "entity"; readonly input: IdentityEntityInput; readonly existing: boolean; readonly revision: string | null }
  | { readonly kind: "attribution"; readonly input: IdentityAttributionInput; readonly existing: boolean; readonly revision: string | null }
  | { readonly kind: "alias"; readonly input: ProjectAliasInput; readonly existing: boolean; readonly revision: string | null; readonly projectNames?: Readonly<Record<string, string>> };

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : "Identity request failed"; }

function useIdentityRecords<T>(load: (cursor?: string) => Promise<IdentityPage<T>>, keyOf: (item: T) => string, refreshVersion: number) {
  const [page, setPage] = useState<IdentityPage<T>>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const generation = useRef(0);
  const cursorHistory = useRef(new Set<string>());
  const key = useRef(keyOf);
  key.current = keyOf;
  useEffect(() => {
    const request = ++generation.current;
    setPage(undefined); setError(undefined); setLoading(true); cursorHistory.current.clear();
    void load().then((next) => {
      if (request !== generation.current) return;
      setPage(next);
      if (next.nextCursor !== undefined) cursorHistory.current.add(next.nextCursor);
    }, (caught: unknown) => { if (request === generation.current) setError(errorMessage(caught)); })
      .finally(() => { if (request === generation.current) setLoading(false); });
    return () => { generation.current++; };
  }, [load, refreshVersion]);
  const more = async () => {
    if (page?.nextCursor === undefined || loading) return;
    const request = generation.current;
    setLoading(true); setError(undefined);
    try {
      const next = await load(page.nextCursor);
      if (request !== generation.current) return;
      if (next.nextCursor !== undefined && cursorHistory.current.has(next.nextCursor)) throw new Error("Repeated page cursor. Refresh this view before continuing.");
      if (next.nextCursor !== undefined) cursorHistory.current.add(next.nextCursor);
      setPage(mergeIdentityPages(page, next, key.current));
    } catch (caught) {
      if (request === generation.current) {
        if (caught instanceof IdentityPageChangedError) setPage(undefined);
        setError(errorMessage(caught));
      }
    }
    finally { if (request === generation.current) setLoading(false); }
  };
  return { page, loading, error, more };
}

function RecordPages<T>({ state, empty, children }: {
  readonly state: ReturnType<typeof useIdentityRecords<T>>;
  readonly empty: string;
  readonly children: (items: readonly T[]) => ReactNode;
}) {
  if (state.page === undefined) return <div className="identity-status" role={state.error ? "alert" : "status"}>{state.error ?? "Loading identities"}</div>;
  return <>
    {state.page.items.length === 0 ? <EmptyState title={empty} /> : children(state.page.items)}
    <LoadMore loaded={state.page.items.length} total={state.page.total} hasMore={state.page.nextCursor !== undefined && state.error === undefined} loading={state.loading} error={state.error} onLoadMore={() => void state.more()} />
    {state.error !== undefined && state.page.nextCursor !== undefined && <button type="button" className="button button--secondary" disabled={state.loading} onClick={() => void state.more()}><RefreshCw />Retry page</button>}
  </>;
}

function RecordStatus({ active }: { readonly active: boolean }) {
  return <span className={`identity-state${active ? " identity-state--active" : ""}`}>{active ? "Active" : "Inactive"}</span>;
}

function Evidence({ ids }: { readonly ids: readonly string[] }) {
  return ids.length === 0 ? <span className="identity-muted">No source events attached</span> : <ul className="identity-evidence">{ids.map((id) => <li key={id}><code>{id}</code></li>)}</ul>;
}

function Audit({ record }: { readonly record: { readonly recordedAt: number; readonly actorId: string; readonly reason: string; readonly evidenceEventIds: readonly string[]; readonly eventId: string } }) {
  return <details className="identity-audit"><summary>Review details</summary><dl><dt>Reason</dt><dd>{record.reason}</dd><dt>Recorded by</dt><dd>{record.actorId}</dd><dt>Recorded</dt><dd>{formatDateTime(record.recordedAt)}</dd><dt>Event</dt><dd><code>{record.eventId}</code></dd><dt>Evidence</dt><dd><Evidence ids={record.evidenceEventIds} /></dd></dl></details>;
}

function EntityList({ api, version, kind, edit, permissions }: { readonly api: FoldApiClient; readonly version: number; readonly kind: IdentityKind | "all"; readonly edit: (dialog: Dialog) => void; readonly permissions: (canManage: boolean, revision: string | null) => void }) {
  const load = useCallback((cursor?: string) => api.identityEntities({ cursor, ...(kind === "all" ? {} : { kind }) }), [api, kind]);
  const state = useIdentityRecords(load, (item) => item.id, version);
  useEffect(() => { permissions(state.page?.canManage ?? false, state.page?.revision ?? null); }, [state.page, permissions]);
  return <RecordPages state={state} empty={kind === "person" ? "No people recorded" : "No identities recorded"}>{(items) => <div className="identity-records">{items.map((item) => <article key={item.id} className="identity-record">
    <header><div><strong>{item.label}</strong><span className="identity-muted">{item.kind === "account" ? "Source account" : item.kind}</span><code>{item.id}</code></div><RecordStatus active={item.active} />{state.page?.canManage && <button className="icon-button" title={`Edit ${item.label}`} aria-label={`Edit ${item.label}`} onClick={() => edit({ kind: "entity", input: item, existing: true, revision: state.page!.revision })}><Pencil /></button>}</header>
    {item.source && <dl className="identity-source"><dt>Provider</dt><dd>{item.source.provider}</dd><dt>External ID</dt><dd>{item.source.externalId}</dd></dl>}
    <Audit record={item} />
  </article>)}</div>}</RecordPages>;
}

function AttributionList({ api, version, edit, permissions }: { readonly api: FoldApiClient; readonly version: number; readonly edit: (dialog: Dialog) => void; readonly permissions: (canManage: boolean, revision: string | null) => void }) {
  const load = useCallback((cursor?: string) => api.identityAttributions({ cursor }), [api]);
  const state = useIdentityRecords(load, (item) => item.entityId, version);
  useEffect(() => { permissions(state.page?.canManage ?? false, state.page?.revision ?? null); }, [state.page, permissions]);
  return <RecordPages state={state} empty="No person attributions recorded">{(items) => <div className="identity-records">{items.map((item) => <article className="identity-record" key={item.entityId}>
    <header><div className="identity-relation"><span><small>Source identity</small><strong>{item.entityLabel ?? "Unresolved source identity"}</strong><code>{item.entityId}</code></span><ArrowRight /><span><small>Person</small><strong>{item.personLabel ?? "Unresolved person"}</strong><code>{item.personId}</code></span></div><RecordStatus active={item.active} />
      {state.page?.canManage && <button className="icon-button" title={item.active ? "Revoke attribution" : "Restore attribution"} aria-label={item.active ? "Revoke attribution" : "Restore attribution"} onClick={() => edit({ kind: "attribution", existing: true, revision: state.page!.revision, input: { ...item, active: !item.active, reason: "" } })}>{item.active ? <Unlink /> : <Link2 />}</button>}
    </header><Audit record={item} />
  </article>)}</div>}</RecordPages>;
}

function AliasList({ api, version, edit, permissions }: { readonly api: FoldApiClient; readonly version: number; readonly edit: (dialog: Dialog) => void; readonly permissions: (canManage: boolean, revision: string | null) => void }) {
  const load = useCallback((cursor?: string) => api.projectAliases({ cursor }), [api]);
  const state = useIdentityRecords(load, (item) => item.aliasProjectId, version);
  useEffect(() => { permissions(state.page?.canManage ?? false, state.page?.revision ?? null); }, [state.page, permissions]);
  return <RecordPages state={state} empty="No project aliases recorded">{(items) => <div className="identity-records">{items.map((item) => <article className="identity-record" key={item.aliasProjectId}>
    <header><div className="identity-relation"><span><small>Original project</small><strong>{item.aliasProjectName ?? "Unresolved project"}</strong><code>{item.aliasProjectId}</code></span><ArrowRight /><span><small>Canonical project</small><strong>{item.canonicalProjectName ?? "Unresolved project"}</strong><code>{item.canonicalProjectId}</code></span></div><RecordStatus active={item.active} />
      {state.page?.canManage && <button className="icon-button" title={item.active ? "Preview revocation" : "Preview restoration"} aria-label={item.active ? "Preview revocation" : "Preview restoration"} onClick={() => edit({ kind: "alias", existing: true, revision: state.page!.revision, projectNames: { ...(item.aliasProjectName === undefined ? {} : { [item.aliasProjectId]: item.aliasProjectName }), ...(item.canonicalProjectName === undefined ? {} : { [item.canonicalProjectId]: item.canonicalProjectName }) }, input: { ...item, active: !item.active, reason: "" } })}>{item.active ? <Unlink /> : <Link2 />}</button>}
    </header><Audit record={item} />
  </article>)}</div>}</RecordPages>;
}

function HistoryList({ api, version, permissions }: { readonly api: FoldApiClient; readonly version: number; readonly permissions: (canManage: boolean, revision: string | null) => void }) {
  const load = useCallback((cursor?: string) => api.identityHistory(cursor), [api]);
  const state = useIdentityRecords(load, (item) => item.eventId, version);
  useEffect(() => { permissions(state.page?.canManage ?? false, state.page?.revision ?? null); }, [state.page, permissions]);
  return <RecordPages state={state} empty="No identity changes recorded">{(items) => <ol className="identity-records identity-history">{items.map((item) => <li className="identity-record" key={item.eventId}><header><strong>{identityHistoryLabel(item)}</strong><time>{formatDateTime(item.recordedAt)}</time></header><InputSummary input={item.input} /><Audit record={{ ...item, ...item.input }} /></li>)}</ol>}</RecordPages>;
}

function IdentityPicker({ api, kind, value, label, disabled, onChange, onProjectNames }: { readonly api: FoldApiClient; readonly kind: "person" | "source" | "project"; readonly value: string; readonly label: string; readonly disabled: boolean; readonly onChange: (value: string) => void; readonly onProjectNames?: (names: Readonly<Record<string, string>>) => void }) {
  const load = useCallback((cursor?: string): Promise<IdentityPage<IdentityEntity | IdentityProject>> => kind === "project" ? api.identityProjects(cursor) : api.identityEntities({ cursor, active: true, ...(kind === "person" ? { kind: "person" } : {}) }), [api, kind]);
  const state = useIdentityRecords(load, (item) => item.id, 0);
  useEffect(() => {
    if (kind === "project" && state.page !== undefined) onProjectNames?.(Object.fromEntries(state.page.items.flatMap((item) => "name" in item ? [[item.id, item.name]] : [])));
  }, [kind, state.page, onProjectNames]);
  const items = state.page?.items.filter((item) => kind !== "source" || ("kind" in item && item.kind !== "person")) ?? [];
  return <div className="identity-picker"><label className="field"><span>{label}</span><select disabled={disabled || state.page === undefined} value={value} onChange={(event) => onChange(event.target.value)}><option value="">Select {label.toLowerCase()}</option>{value && !items.some((item) => item.id === value) && <option value={value}>{value}</option>}{items.map((item) => <option key={item.id} value={item.id}>{"label" in item ? item.label : item.name} ({item.id})</option>)}</select></label>{state.error && <span className="field-error" role="alert">{state.error}</span>}{state.page?.nextCursor !== undefined && <button className="button button--secondary" type="button" onClick={() => void state.more()} disabled={state.loading || disabled}><Plus />{state.loading ? "Loading" : "Load more choices"}</button>}{state.page && <small>{state.page.items.length} of {state.page.total} records loaded</small>}</div>;
}

function ProjectName({ id, names }: { readonly id: string; readonly names: Readonly<Record<string, string>> }) {
  return <span className="identity-project-name">{names[id] && <strong>{names[id]}</strong>}<code>{id}</code></span>;
}

function InputSummary({ input, projectNames = {} }: { readonly input: IdentityReviewInput; readonly projectNames?: Readonly<Record<string, string>> }) {
  return <dl className="identity-review-summary">{"id" in input ? <><dt>Name</dt><dd>{input.label}</dd><dt>Kind</dt><dd>{input.kind}</dd><dt>Identity</dt><dd><code>{input.id}</code></dd>{input.source && <><dt>Provider</dt><dd>{input.source.provider}</dd><dt>External ID</dt><dd>{input.source.externalId}</dd></>}</> : "entityId" in input ? <><dt>Source identity</dt><dd><code>{input.entityId}</code></dd><dt>Person</dt><dd><code>{input.personId}</code></dd></> : <><dt>Original project</dt><dd><ProjectName id={input.aliasProjectId} names={projectNames} /></dd><dt>Canonical project</dt><dd><ProjectName id={input.canonicalProjectId} names={projectNames} /></dd></>}<dt>Status</dt><dd>{input.active ? "Active" : "Inactive"}</dd><dt>Reason</dt><dd>{input.reason}</dd><dt>Evidence</dt><dd><Evidence ids={input.evidenceEventIds} /></dd></dl>;
}

function IdentityDialog({ api, dialog, onClose, onSaved }: { readonly api: FoldApiClient; readonly dialog: Dialog; readonly onClose: () => void; readonly onSaved: () => void }) {
  const [input, setInput] = useState<IdentityReviewInput>(() => {
    const { reason, active, evidenceEventIds } = dialog.input;
    if (dialog.kind === "entity") { const { id, kind, label, source } = dialog.input; return { id, kind, label, ...(source === undefined ? {} : { source }), reason, active, evidenceEventIds }; }
    if (dialog.kind === "attribution") { const { entityId, personId } = dialog.input; return { entityId, personId, reason, active, evidenceEventIds }; }
    const { aliasProjectId, canonicalProjectId } = dialog.input; return { aliasProjectId, canonicalProjectId, reason, active, evidenceEventIds };
  });
  const [preview, setPreview] = useState<ProjectAliasPreview>();
  const [projectNames, setProjectNames] = useState<Readonly<Record<string, string>>>(dialog.kind === "alias" ? dialog.projectNames ?? {} : {});
  const rememberProjectNames = useCallback((names: Readonly<Record<string, string>>) => setProjectNames((current) => ({ ...current, ...names })), []);
  const [evidenceText, setEvidenceText] = useState(dialog.input.evidenceEventIds.join("\n"));
  const [reviewing, setReviewing] = useState(false);
  const [reviewedInput, setReviewedInput] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const update = (next: IdentityReviewInput) => { setInput(next); setPreview(undefined); setReviewing(false); setReviewedInput(undefined); setError(undefined); };
  const problem = identityInputProblem(input);
  const review = async () => {
    if (problem) return;
    setBusy(true); setError(undefined);
    try {
      if ("aliasProjectId" in input) setPreview(await api.previewProjectAlias(input));
      setReviewedInput(JSON.stringify(input));
      setReviewing(true);
    } catch (caught) { setError(errorMessage(caught)); }
    finally { setBusy(false); }
  };
  const apply = async () => {
    if (!reviewing || problem || busy || !matchesIdentityReview(input, reviewedInput)) return;
    setBusy(true); setError(undefined);
    try {
      if ("id" in input) await api.saveIdentityEntity(input, dialog.revision);
      else if ("entityId" in input) await api.saveIdentityAttribution(input, dialog.revision);
      else {
        if (preview === undefined || preview.conflicts.length > 0) throw new Error("A conflict-free preview is required.");
        await api.saveProjectAlias(input, preview);
      }
      onSaved();
    } catch (caught) { setError(errorMessage(caught)); setPreview(undefined); setReviewing(false); }
    finally { setBusy(false); }
  };
  const title = dialog.kind === "entity" ? dialog.existing ? "Review identity change" : "Add identity" : dialog.kind === "attribution" ? input.active ? "Attribute source to person" : "Revoke person attribution" : input.active ? "Review project alias" : "Revoke project alias";
  return <Modal open title={title} width="wide" onClose={() => { if (!busy) onClose(); }}><div className="form-stack identity-form">
    {!reviewing && <>
      {"id" in input && <>
        <div className="form-grid">
          <label className="field"><span>Kind</span><select value={input.kind} disabled={busy || dialog.existing} onChange={(event) => {
            const kind = event.target.value as IdentityKind;
            const { source: _source, ...rest } = input;
            update({ ...rest, kind, ...(kind === "person" || input.source === undefined ? {} : { source: input.source }) });
          }}>{(["person", "account", "agent", "machine"] as const).map((kind) => <option value={kind} key={kind}>{kind === "account" ? "Source account" : kind[0]!.toUpperCase() + kind.slice(1)}</option>)}</select></label>
          <label className="field"><span>Name</span><input value={input.label} maxLength={300} disabled={busy} onChange={(event) => update({ ...input, label: event.target.value })} /></label>
        </div>
        <label className="field"><span>Identity ID</span><input value={input.id} disabled /></label>
        {input.kind !== "person" && <div className="form-grid">
          <label className="field"><span>Provider</span><input value={input.source?.provider ?? ""} maxLength={500} disabled={busy} onChange={(event) => update(withIdentitySource(input, "provider", event.target.value))} /></label>
          <label className="field"><span>External ID</span><input value={input.source?.externalId ?? ""} maxLength={500} disabled={busy} onChange={(event) => update(withIdentitySource(input, "externalId", event.target.value))} /></label>
        </div>}
        <label className="identity-checkbox"><input type="checkbox" checked={input.active} disabled={busy} onChange={(event) => update({ ...input, active: event.target.checked })} />Active identity</label>
      </>}
      {"entityId" in input && <div className="form-grid"><IdentityPicker api={api} kind="source" label="Source identity" value={input.entityId} disabled={busy || dialog.existing} onChange={(entityId) => update({ ...input, entityId })} /><IdentityPicker api={api} kind="person" label="Person" value={input.personId} disabled={busy || dialog.existing} onChange={(personId) => update({ ...input, personId })} /></div>}
      {"aliasProjectId" in input && <div className="form-grid"><IdentityPicker api={api} kind="project" label="Original project" value={input.aliasProjectId} disabled={busy || dialog.existing} onProjectNames={rememberProjectNames} onChange={(aliasProjectId) => update({ ...input, aliasProjectId })} /><IdentityPicker api={api} kind="project" label="Canonical project" value={input.canonicalProjectId} disabled={busy || dialog.existing} onProjectNames={rememberProjectNames} onChange={(canonicalProjectId) => update({ ...input, canonicalProjectId })} /></div>}
      <label className="field"><span>Reason</span><textarea value={input.reason} maxLength={2000} disabled={busy} onChange={(event) => update({ ...input, reason: event.target.value })} /></label>
      <label className="field"><span>Evidence event IDs (one per line)</span><textarea value={evidenceText} disabled={busy} onChange={(event) => { setEvidenceText(event.target.value); update({ ...input, evidenceEventIds: evidenceIds(event.target.value) }); }} /></label>
    </>}
    {reviewing && <><InputSummary input={input} projectNames={projectNames} />{preview && <section className="identity-preview"><h3>Scope and visible affected records</h3><dl><dt>Workspace</dt><dd>{preview.scope.workspaceId}</dd><dt>Visibility</dt><dd>{preview.scope.visibility}</dd><dt>Previous canonical project</dt><dd><ProjectName id={preview.beforeCanonicalProjectId} names={projectNames} /></dd><dt>Resulting canonical project</dt><dd><ProjectName id={preview.afterCanonicalProjectId} names={projectNames} /></dd><dt>Runs</dt><dd>{preview.affected.runs.toLocaleString()}</dd><dt>Memories</dt><dd>{preview.affected.memories.toLocaleString()}</dd><dt>Proposals</dt><dd>{preview.affected.candidates.toLocaleString()}</dd><dt>Affected projects</dt><dd><ul className="identity-evidence">{preview.affected.projectIds.map((id) => <li key={id}><ProjectName id={id} names={projectNames} /></li>)}</ul></dd></dl>{preview.conflicts.length > 0 && <div className="field-error" role="alert"><strong>Conflicts</strong><ul>{preview.conflicts.map((conflict) => <li key={conflict}>{conflict}</li>)}</ul></div>}</section>}<div className="identity-impact">{dialog.kind === "alias" ? "Original project IDs and source records are retained. This changes project identity resolution within this workspace. Counts include only records visible to you." : "This records an identity relationship, not login access, project ownership, or proof of work performed."}</div></>}
    {error && <div className="field-error" role="alert">{error}</div>}
    <footer className="modal__actions"><button className="button button--secondary" type="button" disabled={busy} onClick={reviewing ? () => { setReviewing(false); setPreview(undefined); } : onClose}>{reviewing ? "Back to edit" : "Cancel"}</button>{reviewing ? <button className="button button--primary" type="button" disabled={busy || (preview?.conflicts.length ?? 0) > 0} onClick={() => void apply()}><Check />{busy ? "Applying" : input.active ? "Apply reviewed change" : "Confirm revocation"}</button> : <button className="button button--primary" type="button" disabled={busy || problem !== undefined} title={problem} onClick={() => void review()}><Eye />{busy ? "Preparing preview" : dialog.kind === "alias" ? "Preview affected records" : "Review change"}</button>}</footer>
  </div></Modal>;
}

export function IdentitiesPage({ api, refreshVersion, organizationId, workspaceId }: { readonly api: FoldApiClient; readonly refreshVersion: number; readonly organizationId: string; readonly workspaceId: string }) {
  const [tab, setTab] = useState<Tab>("entities");
  const [kind, setKind] = useState<IdentityKind | "all">("person");
  const [version, setVersion] = useState(0);
  const [canManage, setCanManage] = useState(false);
  const [revision, setRevision] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>();
  const [notice, setNotice] = useState<string>();
  const permissions = useCallback((manage: boolean, nextRevision: string | null) => { setCanManage(manage); setRevision(nextRevision); }, []);
  const changeTab = (next: Tab) => { setCanManage(false); setTab(next); setNotice(undefined); };
  const create = () => {
    const base = { active: true, reason: "", evidenceEventIds: [] };
    if (tab === "entities") setDialog({ kind: "entity", revision, existing: false, input: { ...base, id: `identity-${uuidV7()}`, kind: kind === "all" ? "person" : kind, label: "" } });
    if (tab === "attributions") setDialog({ kind: "attribution", revision, existing: false, input: { ...base, entityId: "", personId: "" } });
    if (tab === "aliases") setDialog({ kind: "alias", revision, existing: false, input: { ...base, aliasProjectId: "", canonicalProjectId: "" } });
  };
  const recordVersion = refreshVersion + version;
  return <section className="page identities-page">
    <PageHeader eyebrow={`${organizationId} / ${workspaceId}`} title="Identities" actions={<><button className="icon-button" title="Refresh identities" aria-label="Refresh identities" onClick={() => setVersion((current) => current + 1)}><RefreshCw /></button>{canManage && tab !== "history" && <button className="button button--primary" onClick={create}><Plus />{tab === "entities" ? "Add identity" : tab === "attributions" ? "Add attribution" : "Review project alias"}</button>}</>} />
    <div className="identity-toolbar"><div className="segmented-control identity-tabs" role="tablist" aria-label="Identity views">{([{ id: "entities", label: "People & sources", icon: Users }, { id: "attributions", label: "Attributions", icon: Link2 }, { id: "aliases", label: "Project aliases", icon: Link2 }, { id: "history", label: "Change history", icon: History }] as const).map(({ id, label, icon: Icon }) => <button type="button" role="tab" aria-selected={tab === id} className={tab === id ? "is-active" : ""} key={id} onClick={() => changeTab(id)}><Icon />{label}</button>)}</div>{tab === "entities" && <label className="compact-field"><span>Kind</span><select value={kind} onChange={(event) => { setCanManage(false); setKind(event.target.value as IdentityKind | "all"); }}><option value="all">All identities</option><option value="person">People</option><option value="account">Source accounts</option><option value="agent">Agents</option><option value="machine">Machines</option></select></label>}</div>
    {notice && <div className="identity-status" role="status">{notice}</div>}
    {tab === "entities" && <EntityList api={api} version={recordVersion} kind={kind} edit={setDialog} permissions={permissions} />}
    {tab === "attributions" && <AttributionList api={api} version={recordVersion} edit={setDialog} permissions={permissions} />}
    {tab === "aliases" && <AliasList api={api} version={recordVersion} edit={setDialog} permissions={permissions} />}
    {tab === "history" && <HistoryList api={api} version={recordVersion} permissions={permissions} />}
    {dialog && <IdentityDialog api={api} dialog={dialog} onClose={() => setDialog(undefined)} onSaved={() => { setDialog(undefined); setNotice("Identity change recorded"); setVersion((current) => current + 1); }} />}
  </section>;
}
