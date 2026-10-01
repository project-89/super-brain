import { Check, CheckCheck, CircleAlert, Edit3, ListFilter, Plus, Replace, Search, Sparkles, ThumbsDown, ThumbsUp, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { EmptyState, PageHeader, SearchField } from "../components/Common";
import { MemoryEvidence } from "../components/MemoryEvidence";
import { MemoryFeedback } from "../components/MemoryFeedback";
import { EvidenceReference } from "../components/EvidenceReference";
import { currentnessReasonLabel, hasCapability, mayEditMemory, mayReviewCandidate } from "../permissions";
import type { AuthorizedIdentity, RecallProvenance } from "@_89/super-brain-client";
import { LoadMore } from "../components/LoadMore";
import type { FoldApiClient } from "../api";
import { formatDateTime, memoryContent, memorySourceLabel, readableMemoryContent, uniqueSorted } from "../format";
import type { FoldLogEntry, JsonValue, MemoryCandidate, MemoryCandidateView, MemoryScope, PersonalMemory, RankedMemoryRecallResult, RecalledMemory, TranscriptProjectSummary } from "../types";
import { effectiveMemoryApplicability, memoryApplicabilityLabel } from "../memory-applicability";
import { useCursorList } from "../use-cursor-list";

type RecallMode = "filter" | "ranked";
export type MemoryJudgment = "helpful" | "unhelpful" | "superseded";

function MemoryContentView({ content }: { readonly content: JsonValue }) {
  const readable = readableMemoryContent(content);
  const raw = typeof content === "string" ? content : JSON.stringify(content, null, 2);
  return <div className="memory-content"><pre>{readable || "No content"}</pre>{raw !== readable && <details className="memory-content__raw"><summary>Complete record</summary><pre>{raw}</pre></details>}</div>;
}

export function MemoryPage({
  memories: initialMemories,
  memoryTotal,
  memoryCursor,
  candidates: initialCandidates,
  candidateTotal,
  candidateCursor,
  feedbackEvents: _feedbackEvents,
  projects,
  api,
  onRank,
  onCreate,
  onEdit,
  onForget,
  onFeedback,
  onAcceptCandidate,
  onRejectCandidate,
  onAcceptCandidates,
  mutationPending,
}: {
  readonly memories: readonly RecalledMemory[];
  readonly memoryTotal: number;
  readonly memoryCursor?: string;
  readonly candidates: readonly MemoryCandidateView[];
  readonly candidateTotal: number;
  readonly candidateCursor?: string;
  readonly feedbackEvents: readonly FoldLogEntry[];
  readonly projects: readonly TranscriptProjectSummary[];
  readonly api: FoldApiClient;
  readonly onRank: (options: {
    readonly query: string;
    readonly scope?: MemoryScope;
    readonly sources?: readonly string[];
    readonly projectIds?: readonly string[];
    readonly limit?: number;
  }) => Promise<RankedMemoryRecallResult>;
  readonly onCreate: () => void;
  readonly onEdit: (memory: PersonalMemory) => void;
  readonly onForget: (memory: PersonalMemory) => void;
  readonly onFeedback: (memory: PersonalMemory, signal: MemoryJudgment, presentation?: RecallProvenance) => Promise<void>;
  readonly onAcceptCandidate: (candidate: MemoryCandidate) => Promise<void>;
  readonly onRejectCandidate: (candidate: MemoryCandidate, reason: string) => Promise<void>;
  readonly onAcceptCandidates: (candidates: readonly MemoryCandidate[]) => Promise<void>;
  readonly mutationPending: boolean;
}) {
  const [access, setAccess] = useState<AuthorizedIdentity>();
  useEffect(() => { let active = true; setAccess(undefined); void api.identity().then((identity) => { if (active) setAccess(identity); }, () => undefined); return () => { active = false; }; }, [api]);
  const memoryPage = useCursorList({
    initialItems: initialMemories,
    initialTotal: memoryTotal,
    initialCursor: memoryCursor,
    keyOf: ({ memory }) => memory.id,
    loadPage: (cursor) => api.recallMemoryPage({ scope: { kind: "all" }, includeNeedsReview: true, limit: 100, cursor }),
  });
  const candidatePage = useCursorList({
    initialItems: initialCandidates,
    initialTotal: candidateTotal,
    initialCursor: candidateCursor,
    keyOf: ({ candidate }) => candidate.id,
    loadPage: (cursor) => api.listMemoryCandidatePage({ status: "proposed", limit: 100, cursor }),
  });
  const memories = memoryPage.items;
  const candidates = candidatePage.items;
  const [view, setView] = useState<"memories" | "candidates">("memories");
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<RecallMode>("filter");
  const [source, setSource] = useState("all");
  const [scope, setScope] = useState("all");
  const [spaceId, setSpaceId] = useState("");
  const [selectedId, setSelectedId] = useState<string>();
  const [ranked, setRanked] = useState<RankedMemoryRecallResult>();
  const [rankingPending, setRankingPending] = useState(false);
  const [rankingError, setRankingError] = useState<string>();
  const [rankedFingerprint, setRankedFingerprint] = useState<string>();
  const sources = useMemo(() => uniqueSorted(memories.map(({ memory }) => memory.source)), [memories]);
  const projectNames = useMemo(() => new Map(projects.map(({ project }) => [project.id, project.name])), [projects]);
  const fingerprint = JSON.stringify([query.trim(), source, scope, spaceId.trim()]);
  const localFiltered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return memories.filter(({ memory }) => {
      if (source !== "all" && memory.source !== source) return false;
      if (scope === "workspace" && memory.spaceId !== undefined) return false;
      if (scope === "space" && memory.spaceId !== spaceId.trim()) return false;
      if (!needle) return true;
      return [memory.summary, memoryContent(memory), memory.source, ...memory.tags]
        .join("\n")
        .toLocaleLowerCase()
        .includes(needle);
    });
  }, [memories, query, source, scope, spaceId]);
  const filtered = mode === "filter"
    ? localFiltered
    : rankedFingerprint === fingerprint
      ? ranked?.memories ?? []
      : [];

  const rankingScope = (): MemoryScope | undefined => {
    if (scope === "workspace") return { kind: "workspace" };
    if (scope === "space" && spaceId.trim()) return { kind: "space", spaceId: spaceId.trim() };
    return { kind: "all" };
  };

  const runRankedSearch = async () => {
    const trimmed = query.trim();
    if (!trimmed || (scope === "space" && !spaceId.trim())) return;
    setRankingPending(true);
    setRankingError(undefined);
    try {
      const result = await onRank({
        query: trimmed,
        scope: rankingScope(),
        ...(source === "all" ? {} : { sources: [source] }),
        limit: 100,
      });
      setRanked(result);
      setRankedFingerprint(fingerprint);
    } catch (caught) {
      setRanked(undefined);
      setRankedFingerprint(fingerprint);
      setRankingError(caught instanceof Error ? caught.message : "Ranked recall failed");
    } finally {
      setRankingPending(false);
    }
  };

  useEffect(() => {
    if (filtered.length === 0) setSelectedId(undefined);
    else if (!filtered.some(({ memory }) => memory.id === selectedId)) setSelectedId(filtered[0]!.memory.id);
  }, [filtered, selectedId]);

  const selectedItem = filtered.find(({ memory }) => memory.id === selectedId);
  const selected = selectedItem?.memory;

  return (
    <div className="page page--memory">
      <PageHeader
        eyebrow="Project-aware recall"
        title="Memory"
        actions={<button className="button button--primary" type="button" onClick={onCreate} disabled={!hasCapability(access, "memories:write")} aria-label="New memory" title="New memory"><Plus aria-hidden="true" />New memory</button>}
      />
      <div className="segmented-control memory-view" role="group" aria-label="Memory view">
        <button type="button" aria-pressed={view === "memories"} onClick={() => setView("memories")}>Memories</button>
        <button type="button" aria-pressed={view === "candidates"} onClick={() => setView("candidates")}>Proposals <span>{candidatePage.total}</span></button>
      </div>
      {view === "memories" ? <>
      <form className="filter-bar memory-filter-bar" onSubmit={(event) => { event.preventDefault(); if (mode === "ranked") void runRankedSearch(); }}>
        <div className="segmented-control memory-mode" role="group" aria-label="Recall mode">
          <button type="button" aria-pressed={mode === "filter"} onClick={() => setMode("filter")}><ListFilter aria-hidden="true" />Filter</button>
          <button type="button" aria-pressed={mode === "ranked"} onClick={() => setMode("ranked")}><Sparkles aria-hidden="true" />Ranked</button>
        </div>
        <SearchField value={query} onChange={setQuery} placeholder="Search memory" />
        <label className="compact-field"><span>Source</span><select value={source} onChange={(event) => setSource(event.target.value)}><option value="all">All sources</option>{sources.map((value) => <option key={value} value={value}>{memorySourceLabel(value)}</option>)}</select></label>
        <label className="compact-field"><span>Scope</span><select value={scope} onChange={(event) => setScope(event.target.value)}><option value="all">All accessible</option><option value="workspace">Workspace only</option><option value="space">Space</option></select></label>
        {scope === "space" && <label className="compact-field compact-field--space"><span>Space</span><input value={spaceId} onChange={(event) => setSpaceId(event.target.value)} /></label>}
        {mode === "ranked" && <button className="icon-button memory-search-button" type="submit" disabled={rankingPending || !query.trim() || (scope === "space" && !spaceId.trim())} aria-label="Run ranked search" title="Run ranked search"><Search aria-hidden="true" /></button>}
        <span className="result-count">{filtered.length} shown · {memoryPage.total} total</span>
        <span className="ranking-status">{mode === "filter" ? "Inspection includes memories needing review" : "Ranked recall uses current, applicable memories"}</span>
        {mode === "ranked" && rankedFingerprint === fingerprint && ranked !== undefined && <span className={`ranking-status ranking-status--${ranked.ranking.kind}`}>{ranked.ranking.kind} / {ranked.ranking.id} / {ranked.ranking.corpusSize} scanned</span>}
        {rankingError !== undefined && <span className="filter-error" role="alert">{rankingError}</span>}
      </form>

      <section className="master-detail">
        <div className="master-list" aria-label="Memories">
          {filtered.length === 0 ? (
            <EmptyState title={mode === "ranked" && rankedFingerprint !== fingerprint ? "Run ranked search" : "No matching memories"} />
          ) : filtered.map(({ memory, score }) => {
            return (
            <button
              type="button"
              className={`memory-row${memory.id === selectedId ? " memory-row--selected" : ""}`}
              key={memory.id}
              onClick={() => setSelectedId(memory.id)}
            >
              <span className="memory-row__top"><strong>{memory.summary || "Untitled memory"}</strong><time>{formatDateTime(memory.updatedAt)}</time></span>
              <span className="memory-row__excerpt">{readableMemoryContent(memory.content) || "No content"}</span>
              <span className="memory-row__meta"><span>{memorySourceLabel(memory.source)}</span><span>{memory.spaceId ?? "workspace"}</span><span>r{memory.revision}</span><span>{memory.currentness?.status ?? "Currentness unknown"}</span><span>{memoryApplicabilityLabel(memory, projectNames)}</span>{mode === "ranked" && score !== undefined && <span>Relevance {score.toFixed(3)}</span>}</span>
            </button>
            );
          })}
          {mode === "filter" && <LoadMore loaded={memories.length} total={memoryPage.total} hasMore={memoryPage.cursor !== undefined} loading={memoryPage.loadingMore} error={memoryPage.loadError} onLoadMore={() => void memoryPage.loadMore()} />}
        </div>

        <article className="detail-pane">
          {selected === undefined ? (
            <EmptyState title="Select a memory" />
          ) : (
            <>
              <header className="detail-pane__header">
                <div><span className="eyebrow">Revision {selected.revision}</span><h2>{selected.summary || "Untitled memory"}</h2></div>
                <div className="detail-pane__actions">
                  <button className="icon-button" type="button" disabled={mutationPending || !hasCapability(access, "feedback:write") || selectedItem?.presentation === undefined} title="Mark helpful" aria-label="Mark memory helpful" onClick={() => void onFeedback(selected, "helpful", selectedItem?.presentation)}><ThumbsUp aria-hidden="true" /></button>
                  <button className="icon-button" type="button" disabled={mutationPending || !hasCapability(access, "feedback:write") || selectedItem?.presentation === undefined} title="Mark unhelpful" aria-label="Mark memory unhelpful" onClick={() => void onFeedback(selected, "unhelpful", selectedItem?.presentation)}><ThumbsDown aria-hidden="true" /></button>
                  <button className="icon-button" type="button" disabled={mutationPending || !hasCapability(access, "feedback:write") || selectedItem?.presentation === undefined} title="Mark superseded" aria-label="Mark memory superseded" onClick={() => void onFeedback(selected, "superseded", selectedItem?.presentation)}><Replace aria-hidden="true" /></button>
                  <button className="icon-button" type="button" disabled={mutationPending || !mayEditMemory(access, selected)} title="Revise memory" aria-label="Revise memory" onClick={() => onEdit(selected)}><Edit3 aria-hidden="true" /></button>
                  <button className="icon-button icon-button--danger" type="button" disabled={mutationPending || !mayEditMemory(access, selected)} title="Forget memory" aria-label="Forget memory" onClick={() => onForget(selected)}><Trash2 aria-hidden="true" /></button>
                </div>
              </header>
              <dl className="metadata-grid">
                <div><dt>Source</dt><dd>{memorySourceLabel(selected.source)}</dd></div>
                <div><dt>Scope</dt><dd>{selected.spaceId ?? "Workspace"}</dd></div>
                <div><dt>Audience</dt><dd>{selected.audience === "workspace" ? "Workspace" : "Personal"}</dd></div>
                <div><dt>Applicability</dt><dd>{memoryApplicabilityLabel(selected, projectNames)}</dd></div>
                <div><dt>Created</dt><dd>{formatDateTime(selected.createdAt)}</dd></div>
                <div><dt>Updated</dt><dd>{formatDateTime(selected.updatedAt)}</dd></div>
                <div><dt>Currentness</dt><dd>{selected.currentness?.status ?? "Unknown"}</dd></div>
                <div><dt>Creator</dt><dd>{selected.creatorId}</dd></div>
              </dl>
              {!mayEditMemory(access, selected) && <p className="evidence-note">Your current access permits inspection. Editing and review require the appropriate workspace or space permission.</p>}
              {(selected.currentness?.reasons.length ?? 0) > 0 && <p className="evidence-note evidence-note--review">Review needed: {selected.currentness!.reasons.map(currentnessReasonLabel).join("; ")}</p>}
              {selected.tags.length > 0 && <div className="tag-list" aria-label="Tags">{selected.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>}
              <MemoryContentView content={selected.content} />
              {selected.entities.length > 0 && (
                <section className="detail-section"><h3>Entities</h3><ul className="entity-list">{selected.entities.map((entity) => <li key={`${entity.type}:${entity.id}`}><strong>{entity.name}</strong><span>{entity.type}</span><code>{entity.id}</code></li>)}</ul></section>
              )}
              <MemoryFeedback key={`feedback:${selected.id}:${selected.revision}:${mutationPending}`} memoryId={selected.id} revision={selected.revision} api={api} />
              <MemoryEvidence key={selected.id} memory={selected} api={api} />
            </>
          )}
        </article>
      </section>
      </> : (
        <CandidateReview
          api={api}
          access={access}
          projectNames={projectNames}
          candidates={candidates}
          pending={mutationPending}
          onAccept={onAcceptCandidate}
          onReject={onRejectCandidate}
          onAcceptMany={onAcceptCandidates}
          total={candidatePage.total}
          hasMore={candidatePage.cursor !== undefined}
          loadingMore={candidatePage.loadingMore}
          loadError={candidatePage.loadError}
          onLoadMore={() => void candidatePage.loadMore()}
        />
      )}
    </div>
  );
}

type CandidateQualityFilter = "all" | "ready" | "unscoped" | "duplicates";

function candidateSummaryKey(candidate: MemoryCandidate): string {
  return candidate.summary.toLocaleLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function candidateKind(candidate: MemoryCandidate): string {
  if (candidate.content !== null && typeof candidate.content === "object" && !Array.isArray(candidate.content)) {
    const kind = candidate.content.kind;
    if (typeof kind === "string") return kind.replaceAll("-", " ");
  }
  return candidate.extractor.kind === "model" ? "model synthesis" : "session observation";
}

function candidateAssessment(candidate: MemoryCandidate, duplicate: boolean) {
  if (duplicate) return { kind: "warning", label: "Possible duplicate", detail: "Another loaded proposal has the same summary." } as const;
  if (effectiveMemoryApplicability(candidate) === "unresolved") return { kind: "warning", label: "Unresolved applicability", detail: "Applicability has not been established." } as const;
  if (candidate.confidence < 0.8) return { kind: "warning", label: "Hypothesis", detail: "Useful for review, but below the batch-review extractor estimate threshold." } as const;
  return { kind: "ready", label: "Ready to review", detail: "Established applicability with at least an 80% extractor estimate. Estimates are self-reported; review the source." } as const;
}

function CandidateReview({
  api, access, projectNames,
  candidates,
  pending,
  onAccept,
  onReject,
  onAcceptMany,
  total,
  hasMore,
  loadingMore,
  loadError,
  onLoadMore,
}: {
  readonly api: FoldApiClient;
  readonly access?: AuthorizedIdentity;
  readonly projectNames: ReadonlyMap<string, string>;
  readonly candidates: readonly MemoryCandidateView[];
  readonly pending: boolean;
  readonly onAccept: (candidate: MemoryCandidate) => Promise<void>;
  readonly onReject: (candidate: MemoryCandidate, reason: string) => Promise<void>;
  readonly onAcceptMany: (candidates: readonly MemoryCandidate[]) => Promise<void>;
  readonly total: number;
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  readonly loadError?: string;
  readonly onLoadMore: () => void;
}) {
  const [selectedId, setSelectedId] = useState<string>();
  const [reason, setReason] = useState("");
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("all");
  const [quality, setQuality] = useState<CandidateQualityFilter>("all");
  const sources = useMemo(() => uniqueSorted(candidates.map(({ candidate }) => candidate.source)), [candidates]);
  const duplicateIds = useMemo(() => {
    const firstByKey = new Map<string, string>();
    const duplicates = new Set<string>();
    for (const { candidate } of candidates) {
      const key = candidateSummaryKey(candidate);
      const first = firstByKey.get(key);
      if (first === undefined) firstByKey.set(key, candidate.id);
      else { duplicates.add(first); duplicates.add(candidate.id); }
    }
    return duplicates;
  }, [candidates]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return candidates.filter(({ candidate }) => {
      const assessment = candidateAssessment(candidate, duplicateIds.has(candidate.id));
      if (source !== "all" && candidate.source !== source) return false;
      if (quality === "ready" && assessment.kind !== "ready") return false;
      if (quality === "unscoped" && effectiveMemoryApplicability(candidate) !== "unresolved") return false;
      if (quality === "duplicates" && !duplicateIds.has(candidate.id)) return false;
      return !needle || [
        candidate.summary,
        readableMemoryContent(candidate.content),
        memorySourceLabel(candidate.source),
        ...candidate.projectIds.map((id) => projectNames.get(id) ?? id),
      ].join("\n").toLocaleLowerCase().includes(needle);
    });
  }, [candidates, duplicateIds, projectNames, quality, query, source]);
  const reviewable = candidates.filter(({ candidate }) => mayReviewCandidate(access, candidate));
  const ready = reviewable.filter(({ candidate }) => candidateAssessment(candidate, duplicateIds.has(candidate.id)).kind === "ready");
  const unscoped = candidates.filter(({ candidate }) => effectiveMemoryApplicability(candidate) === "unresolved").length;
  const selectedCandidates = reviewable.filter(({ candidate }) => selectedIds.has(candidate.id)).map(({ candidate }) => candidate);

  useEffect(() => {
    if (filtered.length === 0) setSelectedId(undefined);
    else if (!filtered.some(({ candidate }) => candidate.id === selectedId)) setSelectedId(filtered[0]!.candidate.id);
  }, [filtered, selectedId]);

  useEffect(() => setReason(""), [selectedId]);
  useEffect(() => {
    const available = new Set(candidates.map(({ candidate }) => candidate.id));
    setSelectedIds((current) => new Set([...current].filter((id) => available.has(id))));
  }, [candidates]);

  const toggleSelected = (candidateId: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(candidateId)) next.delete(candidateId);
      else if (next.size < 100) next.add(candidateId);
      return next;
    });
  };

  const acceptSelected = async () => {
    await onAcceptMany(selectedCandidates);
    setSelectedIds(new Set());
  };
  const selected = filtered.find(({ candidate }) => candidate.id === selectedId);

  return (
    <>
      <section className="candidate-summary" aria-label="Loaded proposal quality">
        <div><strong>{total.toLocaleString()}</strong><span>Awaiting review</span></div>
        <div><strong>{ready.length}</strong><span>Ready in loaded set</span></div>
        <div><strong>{unscoped}</strong><span>Unresolved applicability</span></div>
        <div><strong>{duplicateIds.size}</strong><span>Possible duplicates</span></div>
      </section>
      <div className="filter-bar candidate-filter-bar">
        <SearchField value={query} onChange={setQuery} placeholder="Search proposals" />
        <label className="compact-field"><span>Source</span><select value={source} onChange={(event) => setSource(event.target.value)}><option value="all">All sources</option>{sources.map((value) => <option key={value} value={value}>{memorySourceLabel(value)}</option>)}</select></label>
        <label className="compact-field"><span>Review state</span><select value={quality} onChange={(event) => setQuality(event.target.value as CandidateQualityFilter)}><option value="all">All proposals</option><option value="ready">Ready to review</option><option value="unscoped">Unresolved applicability</option><option value="duplicates">Possible duplicates</option></select></label>
        <span className="result-count">{filtered.length} shown · {candidates.length} loaded</span>
      </div>
      <div className="candidate-selection-bar">
        <button className="text-button" type="button" disabled={pending || ready.length === 0} onClick={() => setSelectedIds(new Set(ready.slice(0, 100).map(({ candidate }) => candidate.id)))}><CheckCheck aria-hidden="true" />Select ready</button>
        <span>{selectedIds.size === 0 ? "Select proposals to review together" : `${selectedIds.size} selected`}</span>
        <button className="button button--primary" type="button" disabled={pending || selectedCandidates.length === 0} onClick={() => void acceptSelected()}><Check aria-hidden="true" />Accept selected</button>
      </div>
      <section className="master-detail">
        <div className="master-list" aria-label="Memory proposals">
          {filtered.length === 0 ? <EmptyState title="No matching proposals" /> : filtered.map((view) => (
            <div className={`candidate-row${view.candidate.id === selectedId ? " candidate-row--selected" : ""}`} key={view.candidate.id}>
              <label className="candidate-row__check" title="Select proposal"><input type="checkbox" checked={selectedIds.has(view.candidate.id)} disabled={!mayReviewCandidate(access, view.candidate)} onChange={() => toggleSelected(view.candidate.id)} /><span className="sr-only">Select {view.candidate.summary}</span></label>
              <button type="button" className="memory-row" onClick={() => setSelectedId(view.candidate.id)}>
                <span className="memory-row__top"><strong>{view.candidate.summary}</strong><time>{formatDateTime(view.candidate.proposedAt)}</time></span>
                <span className="memory-row__excerpt">{readableMemoryContent(view.candidate.content) || "No content"}</span>
                <span className="memory-row__meta"><span>{memorySourceLabel(view.candidate.source)}</span><span>{candidateKind(view.candidate)}</span><span>{candidateAssessment(view.candidate, duplicateIds.has(view.candidate.id)).label}</span><span>{Math.round(view.candidate.confidence * 100)}% extractor estimate</span></span>
              </button>
            </div>
          ))}
          <LoadMore loaded={candidates.length} total={total} hasMore={hasMore} loading={loadingMore} error={loadError} onLoadMore={onLoadMore} />
        </div>
        <article className="detail-pane">
          {selected === undefined ? <EmptyState title="Select a proposal" /> : (
            <>
              <header className="detail-pane__header"><div><span className="eyebrow">{selected.status} proposal · {memorySourceLabel(selected.candidate.source)}</span><h2>{selected.candidate.summary}</h2></div></header>
              {(() => { const assessment = candidateAssessment(selected.candidate, duplicateIds.has(selected.candidate.id)); return <div className={`candidate-assessment candidate-assessment--${assessment.kind}`}><CircleAlert aria-hidden="true" /><span><strong>{assessment.label}</strong><small>{assessment.detail}</small></span></div>; })()}
              <dl className="metadata-grid">
                <div><dt>Audience</dt><dd>{selected.candidate.audience}</dd></div>
                <div><dt>Applicability</dt><dd>{memoryApplicabilityLabel(selected.candidate, projectNames)}</dd></div>
                <div><dt>Derivation</dt><dd>{candidateKind(selected.candidate)}</dd></div>
                <div><dt>Extractor</dt><dd>{selected.candidate.extractor.id} v{selected.candidate.extractor.version}</dd></div>
                <div><dt>Extractor estimate</dt><dd>{Math.round(selected.candidate.confidence * 100)}%</dd></div>
                <div><dt>Extractor salience</dt><dd>{Math.round(selected.candidate.salience * 100)}%</dd></div>
                <div><dt>Proposer</dt><dd>{selected.candidate.proposerId}</dd></div>
                <div><dt>Evidence</dt><dd>{selected.candidate.evidence.length} {selected.candidate.evidence.length === 1 ? "record" : "records"}</dd></div>
              </dl>
              {selected.candidate.tags.length > 0 && <div className="tag-list" aria-label="Tags">{selected.candidate.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>}
              <MemoryContentView content={selected.candidate.content} />
              <section className="detail-section"><h3>Proposal evidence <span>{selected.candidate.evidence.length}</span></h3><p className="evidence-note">Extractor estimates are self-reported. Review the source before accepting.</p><ul className="candidate-evidence">{selected.candidate.evidence.map((evidence, index) => <li key={`${evidence.eventId}:${index}`}><strong>{evidence.relation === "opposes" ? "Opposes" : "Supports"}</strong><EvidenceReference api={api} evidence={evidence} /></li>)}</ul></section>
              {!mayReviewCandidate(access, selected.candidate) && <p className="evidence-note">Shared proposal acceptance requires an owner or administrator with write access. This proposal remains pending.</p>}
              {selected.status === "proposed" && (
                <div className="candidate-actions">
                  <label className="field"><span>Rejection reason</span><input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Required to reject" maxLength={500} /></label>
                  <div><button className="button button--danger" type="button" disabled={pending || !reason.trim() || !mayReviewCandidate(access, selected.candidate)} onClick={() => void onReject(selected.candidate, reason.trim())}><X aria-hidden="true" />Reject</button><button className="button button--primary" type="button" disabled={pending || !mayReviewCandidate(access, selected.candidate)} onClick={() => void onAccept(selected.candidate)}><Check aria-hidden="true" />Accept</button></div>
                </div>
              )}
            </>
          )}
        </article>
      </section>
    </>
  );
}
