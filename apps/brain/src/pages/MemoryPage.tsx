import { Check, CheckCheck, CircleAlert, Edit3, ListFilter, Plus, Replace, Search, Sparkles, ThumbsDown, ThumbsUp, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { EmptyState, PageHeader, SearchField } from "../components/Common";
import { LoadMore } from "../components/LoadMore";
import type { FoldApiClient } from "../api";
import { formatDateTime, memoryContent, memorySourceLabel, readableMemoryContent, shortIdentifier, uniqueSorted } from "../format";
import type { FoldLogEntry, JsonValue, MemoryCandidate, MemoryCandidateView, MemoryScope, PersonalMemory, RankedMemoryRecallResult, RecalledMemory, TranscriptProjectSummary } from "../types";
import { useCursorList } from "../use-cursor-list";
import { effectiveMemoryApplicability, memoryApplicabilityLabel } from "../memory-applicability";

type RecallMode = "filter" | "ranked";

interface FeedbackStats {
  readonly recalled: number;
  readonly helpful: number;
  readonly unhelpful: number;
  readonly superseded: number;
  readonly latestAt?: number;
}

function MemoryContentView({ content }: { readonly content: JsonValue }) {
  const readable = readableMemoryContent(content);
  const raw = typeof content === "string" ? content : JSON.stringify(content, null, 2);
  return <div className="memory-content"><pre>{readable || "No content"}</pre>{raw !== readable && <details className="memory-content__raw"><summary>Complete record</summary><pre>{raw}</pre></details>}</div>;
}

function feedbackByMemory(events: readonly FoldLogEntry[]): ReadonlyMap<string, FeedbackStats> {
  const stats = new Map<string, FeedbackStats>();
  for (const { event } of events) {
    if (event.kind !== "memory.feedback-recorded") continue;
    for (const change of event.changes) {
      if (change.nodeKind !== "x.fold.memory-feedback" || change.after === null ||
        typeof change.after !== "object" || Array.isArray(change.after)) continue;
      const memoryId = typeof change.after.memoryId === "string" ? change.after.memoryId : undefined;
      const signal = change.after.signal;
      if (memoryId === undefined || !["recalled", "helpful", "unhelpful", "superseded"].includes(String(signal))) continue;
      const current = stats.get(memoryId) ?? { recalled: 0, helpful: 0, unhelpful: 0, superseded: 0 };
      stats.set(memoryId, {
        ...current,
        [signal as "recalled" | "helpful" | "unhelpful" | "superseded"]: current[signal as keyof FeedbackStats] as number + 1,
        latestAt: Math.max(current.latestAt ?? 0, event.at.t),
      });
    }
  }
  return stats;
}

export function MemoryPage({
  memories: initialMemories,
  memoryTotal,
  memoryCursor,
  candidates: initialCandidates,
  candidateTotal,
  candidateCursor,
  feedbackEvents,
  projects,
  api,
  onRank,
  onCreate,
  onEdit,
  onForget,
  onFeedback,
  onAcceptCandidate,
  onAcceptCandidates,
  onRejectCandidate,
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
  readonly onFeedback: (memory: PersonalMemory, signal: "helpful" | "unhelpful" | "superseded") => Promise<void>;
  readonly onAcceptCandidate: (candidate: MemoryCandidate) => Promise<void>;
  readonly onAcceptCandidates: (candidates: readonly MemoryCandidate[]) => Promise<void>;
  readonly onRejectCandidate: (candidate: MemoryCandidate, reason: string) => Promise<void>;
  readonly mutationPending: boolean;
}) {
  const memoryPage = useCursorList({
    initialItems: initialMemories,
    initialTotal: memoryTotal,
    initialCursor: memoryCursor,
    keyOf: ({ memory }) => memory.id,
    loadPage: (cursor) => api.recallMemoryPage({ scope: { kind: "all" }, limit: 100, cursor }),
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
  const feedback = useMemo(() => feedbackByMemory(feedbackEvents), [feedbackEvents]);
  const validatedMemories = useMemo(() => memories.filter(({ memory }) => {
    const item = feedback.get(memory.id);
    return item !== undefined && item.helpful + item.unhelpful + item.superseded > 0;
  }).length, [feedback, memories]);
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

  const selected = filtered.find(({ memory }) => memory.id === selectedId)?.memory;

  return (
    <div className="page page--memory">
      <PageHeader
        eyebrow="Project-aware recall"
        title="Memory"
        actions={<button className="button button--primary" type="button" onClick={onCreate} aria-label="New memory" title="New memory"><Plus aria-hidden="true" />New memory</button>}
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
        <span className="ranking-status">{validatedMemories}/{memories.length} reviewed in loaded feedback</span>
        {mode === "ranked" && rankedFingerprint === fingerprint && ranked !== undefined && <span className={`ranking-status ranking-status--${ranked.ranking.kind}`}>{ranked.ranking.kind} / {ranked.ranking.id} / {ranked.ranking.corpusSize} scanned</span>}
        {rankingError !== undefined && <span className="filter-error" role="alert">{rankingError}</span>}
      </form>

      <section className="master-detail">
        <div className="master-list" aria-label="Memories">
          {filtered.length === 0 ? (
            <EmptyState title={mode === "ranked" && rankedFingerprint !== fingerprint ? "Run ranked search" : "No matching memories"} />
          ) : filtered.map(({ memory, score }) => {
            const memoryFeedback = feedback.get(memory.id);
            const validationCount = memoryFeedback === undefined
              ? 0
              : memoryFeedback.helpful + memoryFeedback.unhelpful + memoryFeedback.superseded;
            return (
            <button
              type="button"
              className={`memory-row${memory.id === selectedId ? " memory-row--selected" : ""}`}
              key={memory.id}
              onClick={() => setSelectedId(memory.id)}
            >
              <span className="memory-row__top"><strong>{memory.summary || "Untitled memory"}</strong><time>{formatDateTime(memory.updatedAt)}</time></span>
              <span className="memory-row__excerpt">{readableMemoryContent(memory.content) || "No content"}</span>
              <span className="memory-row__meta"><span>{memorySourceLabel(memory.source)}</span><span>{memory.spaceId ?? "workspace"}</span><span>r{memory.revision}</span><span>{memoryFeedback?.recalled ?? 0} recalls</span><span>{validationCount === 0 ? "unvalidated" : `${validationCount} judgments`}</span>{score !== undefined && <span>{Math.round(score * 100)}%</span>}</span>
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
                  <button className="icon-button" type="button" disabled={mutationPending} title="Mark helpful" aria-label="Mark memory helpful" onClick={() => void onFeedback(selected, "helpful")}><ThumbsUp aria-hidden="true" /></button>
                  <button className="icon-button" type="button" disabled={mutationPending} title="Mark unhelpful" aria-label="Mark memory unhelpful" onClick={() => void onFeedback(selected, "unhelpful")}><ThumbsDown aria-hidden="true" /></button>
                  <button className="icon-button" type="button" disabled={mutationPending} title="Mark superseded" aria-label="Mark memory superseded" onClick={() => void onFeedback(selected, "superseded")}><Replace aria-hidden="true" /></button>
                  <button className="icon-button" type="button" title="Revise memory" aria-label="Revise memory" onClick={() => onEdit(selected)}><Edit3 aria-hidden="true" /></button>
                  <button className="icon-button icon-button--danger" type="button" title="Forget memory" aria-label="Forget memory" onClick={() => onForget(selected)}><Trash2 aria-hidden="true" /></button>
                </div>
              </header>
              <dl className="metadata-grid">
                <div><dt>Source</dt><dd>{memorySourceLabel(selected.source)}</dd></div>
                <div><dt>Scope</dt><dd>{selected.spaceId ?? "Workspace"}</dd></div>
                <div><dt>Audience</dt><dd>{selected.audience === "workspace" ? "Workspace" : "Personal"}</dd></div>
                <div><dt>Applicability</dt><dd>{memoryApplicabilityLabel(selected, projectNames)}</dd></div>
                <div><dt>Created</dt><dd>{formatDateTime(selected.createdAt)}</dd></div>
                <div><dt>Updated</dt><dd>{formatDateTime(selected.updatedAt)}</dd></div>
                <div><dt>Recall</dt><dd>{feedback.get(selected.id)?.recalled ?? 0}</dd></div>
                <div><dt>Validation</dt><dd>{(() => { const item = feedback.get(selected.id); return item === undefined || item.helpful + item.unhelpful + item.superseded === 0 ? "Unvalidated" : `${item.helpful} helpful / ${item.unhelpful} unhelpful / ${item.superseded} superseded`; })()}</dd></div>
                <div><dt>Last feedback</dt><dd>{feedback.get(selected.id)?.latestAt === undefined ? "Never" : formatDateTime(feedback.get(selected.id)!.latestAt!)}</dd></div>
              </dl>
              {selected.tags.length > 0 && <div className="tag-list" aria-label="Tags">{selected.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>}
              <MemoryContentView content={selected.content} />
              {selected.entities.length > 0 && (
                <section className="detail-section"><h3>Entities</h3><ul className="entity-list">{selected.entities.map((entity) => <li key={`${entity.type}:${entity.id}`}><strong>{entity.name}</strong><span>{entity.type}</span><code>{entity.id}</code></li>)}</ul></section>
              )}
              {(selected.evidence?.length ?? 0) > 0 && (
                <section className="detail-section"><h3>Evidence</h3><ul className="candidate-evidence">{selected.evidence!.map((evidence) => <li key={`${evidence.eventId}:${evidence.turnId ?? ""}`}><code>{evidence.eventId}</code>{evidence.projectId !== undefined && <span>{evidence.projectId}</span>}{evidence.runId !== undefined && <span>{evidence.runId}</span>}{evidence.turnId !== undefined && <span>{evidence.turnId}</span>}</li>)}</ul></section>
              )}
            </>
          )}
        </article>
      </section>
      </> : (
        <CandidateReview
          candidates={candidates}
          projectNames={projectNames}
          pending={mutationPending}
          onAccept={onAcceptCandidate}
          onAcceptMany={onAcceptCandidates}
          onReject={onRejectCandidate}
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
  if (candidate.confidence < 0.8) return { kind: "warning", label: "Hypothesis", detail: "Useful for review, but below the batch-review confidence threshold." } as const;
  return { kind: "ready", label: "Ready to review", detail: "Established applicability with at least 80% extractor confidence." } as const;
}

function CandidateReview({
  candidates,
  projectNames,
  pending,
  onAccept,
  onAcceptMany,
  onReject,
  total,
  hasMore,
  loadingMore,
  loadError,
  onLoadMore,
}: {
  readonly candidates: readonly MemoryCandidateView[];
  readonly projectNames: ReadonlyMap<string, string>;
  readonly pending: boolean;
  readonly onAccept: (candidate: MemoryCandidate) => Promise<void>;
  readonly onAcceptMany: (candidates: readonly MemoryCandidate[]) => Promise<void>;
  readonly onReject: (candidate: MemoryCandidate, reason: string) => Promise<void>;
  readonly total: number;
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  readonly loadError?: string;
  readonly onLoadMore: () => void;
}) {
  const [selectedId, setSelectedId] = useState<string>();
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [reason, setReason] = useState("");
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
  const ready = candidates.filter(({ candidate }) => candidateAssessment(candidate, duplicateIds.has(candidate.id)).kind === "ready");
  const unscoped = candidates.filter(({ candidate }) => effectiveMemoryApplicability(candidate) === "unresolved").length;
  const selectedCandidates = candidates.filter(({ candidate }) => selectedIds.has(candidate.id)).map(({ candidate }) => candidate);

  useEffect(() => {
    if (filtered.length === 0) setSelectedId(undefined);
    else if (!filtered.some(({ candidate }) => candidate.id === selectedId)) setSelectedId(filtered[0]!.candidate.id);
  }, [filtered, selectedId]);

  useEffect(() => setReason(""), [selectedId]);
  useEffect(() => {
    const available = new Set(candidates.map(({ candidate }) => candidate.id));
    setSelectedIds((current) => new Set([...current].filter((id) => available.has(id))));
  }, [candidates]);
  const selected = filtered.find(({ candidate }) => candidate.id === selectedId);

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
              <label className="candidate-row__check" title="Select proposal"><input type="checkbox" checked={selectedIds.has(view.candidate.id)} onChange={() => toggleSelected(view.candidate.id)} /><span className="sr-only">Select {view.candidate.summary}</span></label>
              <button type="button" className="memory-row" onClick={() => setSelectedId(view.candidate.id)}>
                <span className="memory-row__top"><strong>{view.candidate.summary}</strong><time>{formatDateTime(view.candidate.proposedAt)}</time></span>
                <span className="memory-row__excerpt">{readableMemoryContent(view.candidate.content) || "No content"}</span>
                <span className="memory-row__meta"><span>{memorySourceLabel(view.candidate.source)}</span><span>{candidateKind(view.candidate)}</span><span>{candidateAssessment(view.candidate, duplicateIds.has(view.candidate.id)).label}</span><span>{Math.round(view.candidate.confidence * 100)}% confidence</span></span>
              </button>
            </div>
          ))}
          <LoadMore loaded={candidates.length} total={total} hasMore={hasMore} loading={loadingMore} error={loadError} onLoadMore={onLoadMore} />
        </div>
        <article className="detail-pane">
          {selected === undefined ? <EmptyState title="Select a proposal" /> : (
            <>
              <header className="detail-pane__header"><div><span className="eyebrow">{memorySourceLabel(selected.candidate.source)}</span><h2>{selected.candidate.summary}</h2></div></header>
              {(() => { const assessment = candidateAssessment(selected.candidate, duplicateIds.has(selected.candidate.id)); return <div className={`candidate-assessment candidate-assessment--${assessment.kind}`}><CircleAlert aria-hidden="true" /><span><strong>{assessment.label}</strong><small>{assessment.detail}</small></span></div>; })()}
              <dl className="metadata-grid">
                <div><dt>Audience</dt><dd>{selected.candidate.audience}</dd></div>
                <div><dt>Applicability</dt><dd>{memoryApplicabilityLabel(selected.candidate, projectNames)}</dd></div>
                <div><dt>Derivation</dt><dd>{candidateKind(selected.candidate)}</dd></div>
                <div><dt>Confidence</dt><dd>{Math.round(selected.candidate.confidence * 100)}%</dd></div>
                <div><dt>Salience</dt><dd>{Math.round(selected.candidate.salience * 100)}%</dd></div>
                <div><dt>Evidence</dt><dd>{selected.candidate.evidence.length} {selected.candidate.evidence.length === 1 ? "record" : "records"}</dd></div>
                <div><dt>Extractor</dt><dd>{selected.candidate.extractor.id} v{selected.candidate.extractor.version}</dd></div>
              </dl>
              {selected.candidate.tags.length > 0 && <div className="tag-list" aria-label="Tags">{selected.candidate.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>}
              <MemoryContentView content={selected.candidate.content} />
              <section className="detail-section"><h3>Evidence <span>{selected.candidate.evidence.length}</span></h3><ul className="candidate-evidence">{selected.candidate.evidence.map((evidence) => <li key={`${evidence.eventId}:${evidence.turnId ?? ""}`}><strong>{evidence.projectId === undefined ? "Project not assigned" : projectNames.get(evidence.projectId) ?? evidence.projectId}</strong>{evidence.runId !== undefined && <span>Run {shortIdentifier(evidence.runId)}</span>}{evidence.turnId !== undefined && <span>Turn {shortIdentifier(evidence.turnId)}</span>}<code title={evidence.eventId}>{evidence.eventId}</code></li>)}</ul></section>
              {selected.status === "proposed" && (
                <div className="candidate-actions">
                  <label className="field"><span>Rejection reason</span><input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Required to reject" maxLength={500} /></label>
                  <div><button className="button button--danger" type="button" disabled={pending || !reason.trim()} onClick={() => void onReject(selected.candidate, reason.trim())}><X aria-hidden="true" />Reject</button><button className="button button--primary" type="button" disabled={pending} onClick={() => void onAccept(selected.candidate)}><Check aria-hidden="true" />Accept</button></div>
                </div>
              )}
            </>
          )}
        </article>
      </section>
    </>
  );
}
