import {
  AlertCircle,
  Bot,
  Clock3,
  Database,
  FileJson,
  FolderGit2,
  GitBranch,
  MessageSquare,
  ShieldCheck,
  Wrench,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { FoldApiClient } from "../api";
import { EmptyState, PageHeader, SearchField } from "../components/Common";
import { formatDateTime, formatRelative } from "../format";
import type {
  TranscriptProjectSummary,
  TranscriptRun,
  TranscriptRunDetail,
  TranscriptSource,
} from "../types";

type SourceFilter = "all" | TranscriptSource;

function pathName(value: string | undefined): string {
  if (value === undefined) return "Unassigned";
  return value.split(/[\\/]/).filter(Boolean).at(-1) ?? value;
}

function runTimestamp(run: TranscriptRun): number | undefined {
  const parsed = Date.parse(run.endedAt ?? run.startedAt ?? "");
  return Number.isFinite(parsed) ? parsed : undefined;
}

function runDate(run: TranscriptRun): string {
  const timestamp = runTimestamp(run);
  return timestamp === undefined ? "Unknown time" : formatDateTime(timestamp);
}

function sourceLabel(source: TranscriptSource): string {
  return source === "claude-code" ? "Claude Code" : "Codex";
}

function matchesProject(run: TranscriptRun, projectId: string): boolean {
  return run.projectId === projectId || run.segments.some((segment) => segment.projectId === projectId);
}

export function HistoryPage({
  projects,
  runs,
  api,
}: {
  readonly projects: readonly TranscriptProjectSummary[];
  readonly runs: readonly TranscriptRun[];
  readonly api: FoldApiClient;
}) {
  const [projectId, setProjectId] = useState("all");
  const [source, setSource] = useState<SourceFilter>("all");
  const [query, setQuery] = useState("");
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const [detail, setDetail] = useState<TranscriptRunDetail>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  const projectNames = useMemo(
    () => new Map(projects.map(({ project }) => [project.id, project.name])),
    [projects],
  );
  const filteredRuns = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return runs.filter((run) => {
      if (projectId !== "all" && !matchesProject(run, projectId)) return false;
      if (source !== "all" && run.source !== source) return false;
      if (normalizedQuery.length === 0) return true;
      const projectName = run.projectId === undefined ? "" : projectNames.get(run.projectId) ?? "";
      return [run.id, run.nativeId, run.cwd, run.branch, run.model, projectName]
        .some((value) => value?.toLowerCase().includes(normalizedQuery));
    });
  }, [projectId, projectNames, query, runs, source]);

  useEffect(() => {
    if (filteredRuns.length === 0) {
      setSelectedRunId(undefined);
      setDetail(undefined);
      return;
    }
    if (selectedRunId === undefined || !filteredRuns.some(({ id }) => id === selectedRunId)) {
      setSelectedRunId(filteredRuns[0]!.id);
    }
  }, [filteredRuns, selectedRunId]);

  useEffect(() => {
    if (selectedRunId === undefined) return;
    let active = true;
    setLoading(true);
    setError(undefined);
    void api.transcriptRun(selectedRunId).then(
      (next) => {
        if (!active) return;
        setDetail(next);
        setLoading(false);
      },
      (caught: unknown) => {
        if (!active) return;
        setDetail(undefined);
        setError(caught instanceof Error ? caught.message : "Run history unavailable");
        setLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [api, selectedRunId]);

  const totalTurns = runs.reduce((sum, run) => sum + run.counts.turns, 0);
  const totalActions = runs.reduce((sum, run) => sum + run.counts.actions, 0);
  const turns = detail?.chunks.flatMap((chunk) => chunk.turns) ?? [];
  const actions = detail?.chunks.flatMap((chunk) => chunk.actions) ?? [];
  const visibleTurns = turns.slice(-40).reverse();
  const visibleActions = actions.slice(-60).reverse();

  return (
    <div className="page page--history">
      <PageHeader eyebrow="Historical agent work" title="Run history" />

      <section className="history-metrics" aria-label="Transcript history totals">
        <div><FolderGit2 aria-hidden="true" /><span><strong>{projects.length}</strong><small>Projects</small></span></div>
        <div><Bot aria-hidden="true" /><span><strong>{runs.length}</strong><small>Runs</small></span></div>
        <div><MessageSquare aria-hidden="true" /><span><strong>{totalTurns}</strong><small>Turns</small></span></div>
        <div><Wrench aria-hidden="true" /><span><strong>{totalActions}</strong><small>Actions</small></span></div>
      </section>

      <div className="history-toolbar">
        <SearchField value={query} onChange={setQuery} placeholder="Search runs" />
        <div className="segmented-control segmented-control--mode" role="group" aria-label="Transcript source">
          {(["all", "claude-code", "codex"] as const).map((value) => (
            <button key={value} type="button" aria-pressed={source === value} onClick={() => setSource(value)}>
              {value === "all" ? "All" : sourceLabel(value)}
            </button>
          ))}
        </div>
        <span className="history-toolbar__count">{filteredRuns.length} runs</span>
      </div>

      <section className="history-workspace">
        <aside className="history-projects" aria-label="Transcript projects">
          <header><span className="eyebrow">Projects</span><strong>{projects.length}</strong></header>
          <button type="button" className={projectId === "all" ? "is-selected" : undefined} onClick={() => setProjectId("all")}>
            <span className="history-project-icon"><Database aria-hidden="true" /></span>
            <span><strong>All projects</strong><small>{runs.length} runs</small></span>
          </button>
          {projects.map((summary) => (
            <button key={summary.project.id} type="button" className={projectId === summary.project.id ? "is-selected" : undefined} onClick={() => setProjectId(summary.project.id)}>
              <span className="history-project-icon"><FolderGit2 aria-hidden="true" /></span>
              <span>
                <strong>{summary.project.name}</strong>
                <small>{pathName(summary.project.roots[0] ?? summary.project.remote)} · {summary.runCount} runs</small>
              </span>
              <i className={`history-resolution history-resolution--${summary.project.resolution}`}>{summary.project.resolution}</i>
            </button>
          ))}
        </aside>

        <div className="history-runs" aria-label="Transcript runs">
          <header><span className="eyebrow">Runs</span><strong>{filteredRuns.length}</strong></header>
          {filteredRuns.length === 0 ? <EmptyState title="No matching runs" /> : filteredRuns.map((run) => (
            <button key={run.id} type="button" className={selectedRunId === run.id ? "is-selected" : undefined} onClick={() => setSelectedRunId(run.id)}>
              <span className={`history-source history-source--${run.source}`}>{run.source === "claude-code" ? "C" : "X"}</span>
              <span>
                <strong>{run.model ?? sourceLabel(run.source)}</strong>
                <small>{run.projectId === undefined ? pathName(run.cwd) : projectNames.get(run.projectId) ?? pathName(run.cwd)}</small>
                <code>{run.nativeId}</code>
              </span>
              <time>{runDate(run)}</time>
              <span className="history-run-counts">{run.counts.turns}t · {run.counts.actions}a</span>
            </button>
          ))}
        </div>

        <article className="history-detail">
          {loading ? (
            <div className="history-loading"><span /><span /><span /></div>
          ) : error !== undefined ? (
            <div className="history-error"><AlertCircle aria-hidden="true" /><strong>Run unavailable</strong><span>{error}</span></div>
          ) : detail === undefined ? (
            <EmptyState title="No run selected" />
          ) : (
            <>
              <header className="history-detail__header">
                <span className={`history-source history-source--${detail.run.source}`}>{detail.run.source === "claude-code" ? "C" : "X"}</span>
                <span><span className="eyebrow">{sourceLabel(detail.run.source)}</span><h2>{detail.run.model ?? detail.run.nativeId}</h2><code>{detail.run.id}</code></span>
                <i className={`history-artifact history-artifact--${detail.artifact.contentPolicy}`}><ShieldCheck aria-hidden="true" />{detail.artifact.contentPolicy}</i>
              </header>

              <dl className="history-metadata">
                <div><dt>Project</dt><dd>{detail.projects.map(({ name }) => name).join(", ") || "Unassigned"}</dd></div>
                <div><dt>Working directory</dt><dd><code>{detail.run.cwd ?? "-"}</code></dd></div>
                <div><dt>Branch</dt><dd><GitBranch aria-hidden="true" />{detail.run.branch ?? "-"}</dd></div>
                <div><dt>Client</dt><dd>{detail.run.clientVersion ?? "-"}</dd></div>
                <div><dt>Started</dt><dd>{detail.run.startedAt === undefined ? "-" : formatDateTime(Date.parse(detail.run.startedAt))}</dd></div>
                <div><dt>Last activity</dt><dd>{runTimestamp(detail.run) === undefined ? "-" : formatRelative(runTimestamp(detail.run)!)}</dd></div>
                <div><dt>Artifact</dt><dd><FileJson aria-hidden="true" />{Math.ceil(detail.artifact.byteLength / 1024).toLocaleString()} KB</dd></div>
                <div><dt>Redactions</dt><dd>{detail.artifact.redactionCount.toLocaleString()}</dd></div>
              </dl>

              <section className="history-segments">
                <header><span className="eyebrow">Context segments</span><strong>{detail.run.segments.length}</strong></header>
                <div>
                  {detail.run.segments.map((segment) => (
                    <span key={segment.id}>
                      <GitBranch aria-hidden="true" />
                      <strong>{segment.branch ?? pathName(segment.cwd)}</strong>
                      <code>{segment.cwd ?? "unassigned"}</code>
                    </span>
                  ))}
                </div>
              </section>

              <div className="history-observations">
                <section>
                  <header><span className="eyebrow">Turns</span><strong>{turns.length}</strong></header>
                  {visibleTurns.length === 0 ? <EmptyState title="No captured turns" /> : (
                    <ol>{visibleTurns.map((turn) => (
                      <li key={turn.id}>
                        <Clock3 aria-hidden="true" />
                        <span><strong>Turn {turn.ordinal + 1}</strong><small>{turn.roles.join(" · ")}</small></span>
                        <i>{turn.messageCount}m · {turn.actionCount}a</i>
                      </li>
                    ))}</ol>
                  )}
                </section>
                <section>
                  <header><span className="eyebrow">Observable actions</span><strong>{actions.length}</strong></header>
                  {visibleActions.length === 0 ? <EmptyState title="No captured actions" /> : (
                    <ol>{visibleActions.map((action) => (
                      <li key={action.id}>
                        <Wrench aria-hidden="true" />
                        <span><strong>{action.name ?? action.kind}</strong><small>{action.kind}</small></span>
                        <i>{action.status ?? "observed"}</i>
                      </li>
                    ))}</ol>
                  )}
                </section>
              </div>
            </>
          )}
        </article>
      </section>
    </div>
  );
}
