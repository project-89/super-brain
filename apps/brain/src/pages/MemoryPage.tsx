import { Check, Edit3, ListFilter, Plus, Search, Sparkles, ThumbsDown, ThumbsUp, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { EmptyState, PageHeader, SearchField } from "../components/Common";
import { formatDateTime, memoryContent, uniqueSorted } from "../format";
import type { FoldLogEntry, MemoryCandidate, MemoryCandidateView, MemoryScope, PersonalMemory, RankedMemoryRecallResult, RecalledMemory } from "../types";

type RecallMode = "filter" | "ranked";

interface FeedbackStats {
  readonly recalled: number;
  readonly helpful: number;
  readonly unhelpful: number;
  readonly superseded: number;
  readonly latestAt?: number;
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
  memories,
  candidates,
  feedbackEvents,
  onRank,
  onCreate,
  onEdit,
  onForget,
  onFeedback,
  onAcceptCandidate,
  onRejectCandidate,
  mutationPending,
}: {
  readonly memories: readonly RecalledMemory[];
  readonly candidates: readonly MemoryCandidateView[];
  readonly feedbackEvents: readonly FoldLogEntry[];
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
  readonly onFeedback: (memory: PersonalMemory, signal: "helpful" | "unhelpful") => Promise<void>;
  readonly onAcceptCandidate: (candidate: MemoryCandidate) => Promise<void>;
  readonly onRejectCandidate: (candidate: MemoryCandidate, reason: string) => Promise<void>;
  readonly mutationPending: boolean;
}) {
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
        <button type="button" aria-pressed={view === "candidates"} onClick={() => setView("candidates")}>Proposals <span>{candidates.filter(({ status }) => status === "proposed").length}</span></button>
      </div>
      {view === "memories" ? <>
      <form className="filter-bar memory-filter-bar" onSubmit={(event) => { event.preventDefault(); if (mode === "ranked") void runRankedSearch(); }}>
        <div className="segmented-control memory-mode" role="group" aria-label="Recall mode">
          <button type="button" aria-pressed={mode === "filter"} onClick={() => setMode("filter")}><ListFilter aria-hidden="true" />Filter</button>
          <button type="button" aria-pressed={mode === "ranked"} onClick={() => setMode("ranked")}><Sparkles aria-hidden="true" />Ranked</button>
        </div>
        <SearchField value={query} onChange={setQuery} placeholder="Search memory" />
        <label className="compact-field"><span>Source</span><select value={source} onChange={(event) => setSource(event.target.value)}><option value="all">All sources</option>{sources.map((value) => <option key={value}>{value}</option>)}</select></label>
        <label className="compact-field"><span>Scope</span><select value={scope} onChange={(event) => setScope(event.target.value)}><option value="all">All accessible</option><option value="workspace">Workspace only</option><option value="space">Space</option></select></label>
        {scope === "space" && <label className="compact-field compact-field--space"><span>Space</span><input value={spaceId} onChange={(event) => setSpaceId(event.target.value)} /></label>}
        {mode === "ranked" && <button className="icon-button memory-search-button" type="submit" disabled={rankingPending || !query.trim() || (scope === "space" && !spaceId.trim())} aria-label="Run ranked search" title="Run ranked search"><Search aria-hidden="true" /></button>}
        <span className="result-count">{filtered.length} {filtered.length === 1 ? "memory" : "memories"}</span>
        <span className="ranking-status">{validatedMemories}/{memories.length} validated · {feedbackEvents.length} feedback signals</span>
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
              <span className="memory-row__excerpt">{memoryContent(memory) || "No content"}</span>
              <span className="memory-row__meta"><span>{memory.source}</span><span>{memory.spaceId ?? "workspace"}</span><span>r{memory.revision}</span><span>{memoryFeedback?.recalled ?? 0} recalls</span><span>{validationCount === 0 ? "unvalidated" : `${validationCount} judgments`}</span>{score !== undefined && <span>{Math.round(score * 100)}%</span>}</span>
            </button>
            );
          })}
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
                  <button className="icon-button" type="button" title="Revise memory" aria-label="Revise memory" onClick={() => onEdit(selected)}><Edit3 aria-hidden="true" /></button>
                  <button className="icon-button icon-button--danger" type="button" title="Forget memory" aria-label="Forget memory" onClick={() => onForget(selected)}><Trash2 aria-hidden="true" /></button>
                </div>
              </header>
              <dl className="metadata-grid">
                <div><dt>Source</dt><dd>{selected.source}</dd></div>
                <div><dt>Scope</dt><dd>{selected.spaceId ?? "Workspace"}</dd></div>
                <div><dt>Audience</dt><dd>{selected.audience === "workspace" ? "Workspace" : "Personal"}</dd></div>
                <div><dt>Projects</dt><dd>{selected.projectIds.length > 0 ? selected.projectIds.join(", ") : "All projects"}</dd></div>
                <div><dt>Created</dt><dd>{formatDateTime(selected.createdAt)}</dd></div>
                <div><dt>Updated</dt><dd>{formatDateTime(selected.updatedAt)}</dd></div>
                <div><dt>Recall</dt><dd>{feedback.get(selected.id)?.recalled ?? 0}</dd></div>
                <div><dt>Validation</dt><dd>{(() => { const item = feedback.get(selected.id); return item === undefined || item.helpful + item.unhelpful + item.superseded === 0 ? "Unvalidated" : `${item.helpful} helpful / ${item.unhelpful} unhelpful / ${item.superseded} superseded`; })()}</dd></div>
                <div><dt>Last feedback</dt><dd>{feedback.get(selected.id)?.latestAt === undefined ? "Never" : formatDateTime(feedback.get(selected.id)!.latestAt!)}</dd></div>
              </dl>
              {selected.tags.length > 0 && <div className="tag-list" aria-label="Tags">{selected.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>}
              <div className="memory-content"><pre>{memoryContent(selected) || "No content"}</pre></div>
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
          pending={mutationPending}
          onAccept={onAcceptCandidate}
          onReject={onRejectCandidate}
        />
      )}
    </div>
  );
}

function CandidateReview({
  candidates,
  pending,
  onAccept,
  onReject,
}: {
  readonly candidates: readonly MemoryCandidateView[];
  readonly pending: boolean;
  readonly onAccept: (candidate: MemoryCandidate) => Promise<void>;
  readonly onReject: (candidate: MemoryCandidate, reason: string) => Promise<void>;
}) {
  const [selectedId, setSelectedId] = useState<string>();
  const [reason, setReason] = useState("");
  const filtered = candidates;

  useEffect(() => {
    if (filtered.length === 0) setSelectedId(undefined);
    else if (!filtered.some(({ candidate }) => candidate.id === selectedId)) setSelectedId(filtered[0]!.candidate.id);
  }, [filtered, selectedId]);

  useEffect(() => setReason(""), [selectedId]);
  const selected = filtered.find(({ candidate }) => candidate.id === selectedId);

  return (
    <>
      <div className="filter-bar candidate-filter-bar">
        <span className="eyebrow">Pending review</span>
        <span className="result-count">{filtered.length} {filtered.length === 1 ? "proposal" : "proposals"}</span>
      </div>
      <section className="master-detail">
        <div className="master-list" aria-label="Memory proposals">
          {filtered.length === 0 ? <EmptyState title="No matching proposals" /> : filtered.map((view) => (
            <button type="button" className={`memory-row${view.candidate.id === selectedId ? " memory-row--selected" : ""}`} key={view.candidate.id} onClick={() => setSelectedId(view.candidate.id)}>
              <span className="memory-row__top"><strong>{view.candidate.summary}</strong><time>{formatDateTime(view.candidate.proposedAt)}</time></span>
              <span className="memory-row__excerpt">{typeof view.candidate.content === "string" ? view.candidate.content : JSON.stringify(view.candidate.content)}</span>
              <span className="memory-row__meta"><span>{view.status}</span><span>{view.candidate.audience}</span><span>{Math.round(view.candidate.confidence * 100)}% confidence</span></span>
            </button>
          ))}
        </div>
        <article className="detail-pane">
          {selected === undefined ? <EmptyState title="Select a proposal" /> : (
            <>
              <header className="detail-pane__header"><div><span className="eyebrow">{selected.status} proposal</span><h2>{selected.candidate.summary}</h2></div></header>
              <dl className="metadata-grid">
                <div><dt>Audience</dt><dd>{selected.candidate.audience}</dd></div>
                <div><dt>Projects</dt><dd>{selected.candidate.projectIds.length > 0 ? selected.candidate.projectIds.join(", ") : "All projects"}</dd></div>
                <div><dt>Extractor</dt><dd>{selected.candidate.extractor.id} v{selected.candidate.extractor.version}</dd></div>
                <div><dt>Confidence</dt><dd>{Math.round(selected.candidate.confidence * 100)}%</dd></div>
                <div><dt>Salience</dt><dd>{Math.round(selected.candidate.salience * 100)}%</dd></div>
                <div><dt>Proposer</dt><dd>{selected.candidate.proposerId}</dd></div>
              </dl>
              {selected.candidate.tags.length > 0 && <div className="tag-list" aria-label="Tags">{selected.candidate.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>}
              <div className="memory-content"><pre>{typeof selected.candidate.content === "string" ? selected.candidate.content : JSON.stringify(selected.candidate.content, null, 2)}</pre></div>
              <section className="detail-section"><h3>Evidence</h3><ul className="candidate-evidence">{selected.candidate.evidence.map((evidence) => <li key={`${evidence.eventId}:${evidence.turnId ?? ""}`}><code>{evidence.eventId}</code>{evidence.runId !== undefined && <span>{evidence.runId}</span>}{evidence.turnId !== undefined && <span>{evidence.turnId}</span>}</li>)}</ul></section>
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
