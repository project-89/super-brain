import {
  AlertCircle,
  ArrowRight,
  Check,
  CircleHelp,
  CircleDot,
  GitBranch,
  Import,
  Route,
  X,
} from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";

import type { AuthorizedIdentity } from "@_89/super-brain-client";
import { hasCapability } from "../permissions";
import type { FoldApiClient } from "../api";
import { EmptyState, PageHeader, SearchField } from "../components/Common";
import { AttemptEvidence, RuntimeEvidence, TaskEvidenceTimeline } from "../components/TaskEvidence";
import { LoadMore } from "../components/LoadMore";
import { TrajectoryOutcomeReview } from "../components/TrajectoryOutcomeReview";
import { formatRelative, shortIdentifier } from "../format";
import type {
  ProjectedTrajectory,
  SharedTrajectoryNode,
  TrajectoryTaskReport,
  TrajectoryTaskSummary,
  TrajectoryOutcome,
  TranscriptProjectSummary,
} from "../types";
import { useCursorList } from "../use-cursor-list";

const TrajectoryGraph = lazy(async () => {
  const module = await import("../components/TrajectoryGraph");
  return { default: module.TrajectoryGraph };
});

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function nodeIndex(report: TrajectoryTaskReport): ReadonlyMap<string, SharedTrajectoryNode> {
  return new Map(report.tree.nodes.map((node) => [node.id, node]));
}

function projectionLabel(step: ProjectedTrajectory["steps"][number]): string {
  if (step.projection.kind === "mapped") return step.projection.nodeId;
  if (step.projection.kind === "ambiguous") return step.projection.candidates.join(" / ");
  return step.projection.reason;
}

function taskProjectId(taskId: string): string | undefined {
  return taskId.split(":").find((part) => part.startsWith("project-"));
}

function taskLabel(task: TrajectoryTaskSummary, projectNames: ReadonlyMap<string, string>): string {
  const decision = task.label ?? task.tree?.nodes.find(({ kind, label }) => kind === "decision" && label.trim().length > 0)?.label;
  if (decision !== undefined) return decision.replaceAll("**", "");
  const projectId = taskProjectId(task.taskId);
  return `${projectId === undefined ? "Project" : projectNames.get(projectId) ?? "Project"} agent run`;
}

export function TrajectoriesPage({
  tasks: initialTasks,
  total,
  cursor,
  projects,
  api,
  onImport,
}: {
  readonly tasks: readonly TrajectoryTaskSummary[];
  readonly total: number;
  readonly cursor?: string;
  readonly projects: readonly TranscriptProjectSummary[];
  readonly api: FoldApiClient;
  readonly onImport: () => void;
}) {
  const [access, setAccess] = useState<AuthorizedIdentity>();
  useEffect(() => { let active = true; setAccess(undefined); void api.identity().then((value) => { if (active) setAccess(value); }, () => undefined); return () => { active = false; }; }, [api]);
  const taskPage = useCursorList({
    initialItems: initialTasks,
    initialTotal: total,
    initialCursor: cursor,
    keyOf: (task) => task.taskId,
    loadPage: (nextCursor) => api.listTrajectoryTaskPage({ limit: 50, cursor: nextCursor }),
  });
  const [reviewedCounts, setReviewedCounts] = useState<ReadonlyMap<string, Readonly<Record<TrajectoryOutcome, number>>>>(new Map());
  const tasks = useMemo(() => taskPage.items.map((task) => {
    const counts = reviewedCounts.get(task.taskId);
    return counts === undefined ? task : { ...task, successCount: counts.success, failureCount: counts.failure, unknownCount: counts.unknown };
  }), [taskPage.items, reviewedCounts]);
  useEffect(() => { setReviewedCounts(new Map()); }, [initialTasks]);
  const projectNames = useMemo(() => new Map(projects.map(({ project }) => [project.id, project.name])), [projects]);
  const [selectedTaskId, setSelectedTaskId] = useState<string>();
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const [report, setReport] = useState<TrajectoryTaskReport>();
  const [loading, setLoading] = useState(false);
  const [loadingRuns, setLoadingRuns] = useState(false);
  const [runLoadError, setRunLoadError] = useState<string>();
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState("");
  const filteredTasks = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle.length === 0 ? tasks : tasks.filter((task) => `${task.taskId}\n${task.label ?? ""}\n${task.tree?.nodes.map(({ label }) => label).join("\n") ?? ""}`.toLowerCase().includes(needle));
  }, [query, tasks]);

  useEffect(() => {
    if (filteredTasks.length === 0) {
      setSelectedTaskId(undefined);
      setReport(undefined);
      return;
    }
    if (selectedTaskId === undefined || !filteredTasks.some(({ taskId }) => taskId === selectedTaskId)) {
      setSelectedTaskId(filteredTasks[0]!.taskId);
    }
  }, [filteredTasks, selectedTaskId]);

  useEffect(() => {
    if (selectedTaskId === undefined) return;
    let active = true;
    setLoading(true);
    setError(undefined);
    setRunLoadError(undefined);
    void api.trajectoryReport(selectedTaskId, { limit: 100 }).then(
      (next) => {
        if (!active) return;
        setReport(next);
        setSelectedRunId((current) =>
          next.records.some(({ trajectory }) => trajectory.id === current)
            ? current
            : next.records[0]?.trajectory.id,
        );
        setLoading(false);
      },
      (caught: unknown) => {
        if (!active) return;
        setReport(undefined);
        setError(caught instanceof Error ? caught.message : "Trajectory report failed");
        setLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [api, selectedTaskId]);

  const selectedRun = report?.projected.find(({ id }) => id === selectedRunId);
  const selectedRecord = report?.records.find(({ trajectory }) => trajectory.id === selectedRunId);
  const divergence = report?.divergences.find(({ trajectoryId }) => trajectoryId === selectedRunId)?.divergence;
  const evaluation = report?.evaluations.find(({ trajectoryId }) => trajectoryId === selectedRunId);
  const selectedTask = tasks.find(({ taskId }) => taskId === selectedTaskId);
  const classifiedRuns = (report?.outcomeCounts?.success ?? selectedTask?.successCount ?? 0) + (report?.outcomeCounts?.failure ?? selectedTask?.failureCount ?? 0);
  const unknownRuns = report?.outcomeCounts?.unknown ?? selectedTask?.unknownCount ?? 0;
  const nodes = useMemo(() => report === undefined ? new Map() : nodeIndex(report), [report]);

  const loadMoreRuns = async () => {
    if (selectedTaskId === undefined || report?.runCursor === undefined || loadingRuns) return;
    setLoadingRuns(true);
    setRunLoadError(undefined);
    try {
      const next = await api.trajectoryReport(selectedTaskId, { limit: 100, cursor: report.runCursor });
      setReport((current) => current === undefined ? next : {
        ...next,
        records: [...current.records, ...next.records],
        projected: [...current.projected, ...next.projected],
        divergences: [...current.divergences, ...next.divergences],
        evaluations: [...current.evaluations, ...next.evaluations],
      });
    } catch (caught) {
      setRunLoadError(caught instanceof Error ? caught.message : "Unable to load more runs");
    } finally {
      setLoadingRuns(false);
    }
  };

  const refreshReviewedRun = async () => {
    if (selectedTaskId === undefined || report === undefined) return;
    let next = await api.trajectoryReport(selectedTaskId, { limit: 100 });
    while (next.runCursor !== undefined && next.records.length < report.records.length) {
      const page = await api.trajectoryReport(selectedTaskId, { limit: 100, cursor: next.runCursor });
      next = { ...page, records: [...next.records, ...page.records], projected: [...next.projected, ...page.projected],
        divergences: [...next.divergences, ...page.divergences], evaluations: [...next.evaluations, ...page.evaluations] };
    }
    setReport((current) => current?.taskId === next.taskId ? next : current);
    if (next.outcomeCounts !== undefined) {
      const counts = next.outcomeCounts;
      setReviewedCounts((current) => new Map(current).set(next.taskId, counts));
    }
  };

  return (
    <div className="page page--trajectories">
      <PageHeader
        eyebrow="Observed reasoning and outcomes"
        title="Decision paths"
        actions={<button className="button button--primary" type="button" onClick={onImport} disabled={!hasCapability(access, "trajectories:write")}><Import aria-hidden="true" />Import</button>}
      />

      {tasks.length === 0 ? (
        <section className="panel trajectory-empty">
          <EmptyState title="No trajectory tasks" />
          <button className="button button--primary" type="button" onClick={onImport} disabled={!hasCapability(access, "trajectories:write")}><Import aria-hidden="true" />Import</button>
        </section>
      ) : (
        <section className="trajectory-workspace">
          <aside className="trajectory-task-list" aria-label="Trajectory tasks">
            <header><span className="eyebrow">Shared trees</span><strong>{filteredTasks.length} / {taskPage.total}</strong></header>
            <div className="trajectory-task-search"><SearchField value={query} onChange={setQuery} placeholder="Search trees" /></div>
            {filteredTasks.map((task) => (
              <button
                key={task.taskId}
                type="button"
                className={task.taskId === selectedTaskId ? "is-selected" : undefined}
                onClick={() => setSelectedTaskId(task.taskId)}
              >
                <span><strong>{taskLabel(task, projectNames)}</strong><small>{taskProjectId(task.taskId) === undefined ? "Unknown project" : projectNames.get(taskProjectId(task.taskId)!) ?? "Unknown project"}{task.nodeCount ?? task.tree?.nodes.length ? ` · ${task.nodeCount ?? task.tree!.nodes.length} steps` : " · Decision path"}</small><code title={task.taskId}>{shortIdentifier(task.taskId, 24, 12)}</code></span>
                <span className="trajectory-task-list__counts"><b>{task.successCount}</b><i>{task.failureCount}</i>{task.unknownCount > 0 && <small>{task.unknownCount}</small>}</span>
                <time>{formatRelative(task.lastRecordedAt)}</time>
              </button>
            ))}
            <LoadMore
              loaded={tasks.length}
              total={taskPage.total}
              hasMore={taskPage.cursor !== undefined}
              loading={taskPage.loadingMore}
              error={taskPage.loadError}
              onLoadMore={() => void taskPage.loadMore()}
            />
          </aside>

          <div className="trajectory-report">
            {loading ? (
              <div className="trajectory-loading"><span /><span /><span /></div>
            ) : error !== undefined ? (
              <div className="trajectory-error"><AlertCircle aria-hidden="true" /><strong>Report unavailable</strong><span>{error}</span></div>
            ) : report === undefined ? (
              <EmptyState title="No report selected" />
            ) : (
              <>
                <header className="trajectory-report__header">
                  <div><span className="eyebrow">{taskProjectId(report.taskId) === undefined ? "Decision task" : projectNames.get(taskProjectId(report.taskId)!) ?? "Decision task"}</span><h2>{report.records.find((record) => record.trajectory.manifest?.task.goal)?.trajectory.manifest?.task.goal ?? (selectedTask === undefined ? report.taskId : taskLabel(selectedTask, projectNames))}</h2><code title={report.taskId}>{shortIdentifier(report.taskId, 30, 14)}</code></div>
                  <span>{report.tree.nodes.length} nodes · {report.tree.edges.length} edges · {report.projectionBasis ?? "unspecified"} mapping · comparison {report.comparison?.status ?? "unspecified"}</span>
                </header>

                <div className="trajectory-metrics" aria-label="Trajectory analysis">
                  <div><CircleDot aria-hidden="true" /><span><strong>{report.analysis.traceCount}</strong><small>Runs</small></span></div>
                  <div><Check aria-hidden="true" /><span><strong>{percent(report.analysis.coverage.mappedRatio)}</strong><small>Mapped</small></span></div>
                  <div><Route aria-hidden="true" /><span><strong>{classifiedRuns}</strong><small>Classified / {unknownRuns} unknown</small></span></div>
                  <div><GitBranch aria-hidden="true" /><span><strong>{report.analysis.routes.length}</strong><small>Observed routes</small></span></div>
                </div>

                <section className="trajectory-consensus">
                  <header><span><span className="eyebrow">Observed evidence</span><h3>Highest-success path</h3></span><small>{report.analysis.incompleteTraceCount} incomplete</small></header>
                  {report.analysis.mostSuccessfulPath.length === 0 ? (
                    <EmptyState title={classifiedRuns === 0 ? "No classified outcome route" : "No complete route"} />
                  ) : (
                    <div className="trajectory-path">
                      {report.analysis.mostSuccessfulPath.map((nodeId, index) => {
                        const node = nodes.get(nodeId);
                        return (
                          <span className="trajectory-path__segment" key={nodeId}>
                            {index > 0 && <ArrowRight aria-hidden="true" />}
                            <span className={`trajectory-node trajectory-node--${node?.kind ?? "decision"}`}>
                              <small>{node?.kind ?? "node"}</small><strong>{node?.label ?? nodeId}</strong>
                            </span>
                          </span>
                        );
                      })}
                    </div>
                  )}
                </section>

                <Suspense fallback={<div className="tree-graph-loading"><span /><span /><span /></div>}>
                  <TrajectoryGraph tree={report.tree} successfulPath={report.analysis.mostSuccessfulPath} selectedRun={selectedRun} />
                </Suspense>

                <p className="evidence-note">Classified outcomes are recorded results. Structural mapping records sequence; it does not independently assess reasoning quality.</p>
                <TaskEvidenceTimeline key={report.taskId} taskId={report.taskId} api={api} />
                <section className="trajectory-run-layout">
                  <div className="trajectory-run-list">
                    <header><span className="eyebrow">Captured runs</span><strong>{report.records.length} records</strong></header>
                    {report.records.length === 0 ? <EmptyState title="No runs recorded" /> : report.records.map((record) => {
                      const runDivergence = report.divergences.find(({ trajectoryId }) => trajectoryId === record.trajectory.id)?.divergence;
                      return (
                        <button key={record.trajectory.id} type="button" className={record.trajectory.id === selectedRunId ? "is-selected" : undefined} onClick={() => setSelectedRunId(record.trajectory.id)}>
                          <span className={`outcome-mark outcome-mark--${record.trajectory.outcome}`}>{record.trajectory.outcome === "success" ? <Check aria-hidden="true" /> : record.trajectory.outcome === "failure" ? <X aria-hidden="true" /> : <CircleHelp aria-hidden="true" />}</span>
                          <span><strong>{record.trajectory.model.id}</strong><small>{record.trajectory.id}</small></span>
                          <span className={`divergence-badge divergence-badge--${runDivergence?.kind ?? "indeterminate"}`}>{runDivergence?.kind ?? "indeterminate"}</span>
                        </button>
                      );
                    })}
                    <LoadMore loaded={report.records.length} total={report.runTotal ?? report.records.length} hasMore={report.runCursor !== undefined} loading={loadingRuns} error={runLoadError} onLoadMore={() => void loadMoreRuns()} />
                  </div>

                  <article className="trajectory-run-inspector">
                    {selectedRun === undefined || selectedRecord === undefined ? (
                      <EmptyState title="No run selected" />
                    ) : (
                      <>
                        <header>
                          <div><span className="eyebrow">{selectedRun.outcome}</span><h3>{selectedRun.model.id}</h3><code>{selectedRun.id}</code><p>{selectedRecord.trajectory.outcomeEvidence?.kind === "operator-verdict" ? "Operator verdict" : selectedRecord.trajectory.outcomeEvidence?.kind === "harness-error" ? "Harness reported an error" : selectedRun.outcome === "unknown" ? "Task result not verified" : "Legacy result: verdict source unavailable"}</p>{selectedRecord.trajectory.outcomeEvidence !== undefined && <details><summary>Verdict evidence</summary><code>{selectedRecord.trajectory.outcomeEvidence.eventId}</code>{selectedRecord.trajectory.outcomeEvidence.artifactId !== undefined && <code>{selectedRecord.trajectory.outcomeEvidence.artifactId}</code>}</details>}</div>
                          <dl>
                            <div><dt>Projection</dt><dd>{divergence?.kind ?? "indeterminate"}</dd></div>
                            <div><dt>Review</dt><dd>{evaluation?.review.verdict ?? "unmarked"}</dd></div>
                            <div><dt>Evaluation score</dt><dd>{evaluation === undefined || evaluation.oracle.confidence === null ? "Unknown" : percent(evaluation.oracle.confidence)}</dd></div>
                          </dl>
                        </header>
                        <AttemptEvidence manifest={selectedRecord.trajectory.manifest} api={api} />
                        <TrajectoryOutcomeReview key={selectedRun.id} record={selectedRecord} api={api} onSaved={refreshReviewedRun} />
                        <ol className="trajectory-steps">
                          {selectedRun.steps.map((step) => (
                            <li key={step.raw.id}>
                              <span className="trajectory-step-number">{step.raw.stepNumber}</span>
                              <div><span><b>{step.raw.role.replaceAll("_", " ")}</b><em className={`projection-badge projection-badge--${step.projection.kind}`}>{step.projection.kind}</em></span><p>{step.raw.content}</p><code>{projectionLabel(step)} · {step.projection.method.basis ?? "basis unknown"} · {step.projection.method.kind}:{step.projection.method.id}</code>{(step.raw.eventId !== undefined || step.raw.artifactId !== undefined || step.raw.turnId !== undefined || step.raw.durationMs !== undefined) && <small className="trajectory-step-evidence">{[step.raw.eventId === undefined ? undefined : `event ${step.raw.eventId}`, step.raw.artifactId === undefined ? undefined : `artifact ${step.raw.artifactId}`, step.raw.turnId === undefined ? undefined : `turn ${step.raw.turnId}`, step.raw.durationMs === undefined ? undefined : `${step.raw.durationMs} ms`].filter(Boolean).join(" · ")}</small>}{step.raw.runtime !== undefined && <RuntimeEvidence runtime={step.raw.runtime} />}</div>
                            </li>
                          ))}
                        </ol>
                      </>
                    )}
                  </article>
                </section>
              </>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
