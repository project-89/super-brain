import {
  AlertCircle,
  ArrowRight,
  Check,
  CircleDot,
  GitBranch,
  Import,
  Route,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { FoldApiClient } from "../api";
import { EmptyState, PageHeader } from "../components/Common";
import { formatRelative } from "../format";
import type {
  ProjectedTrajectory,
  SharedTrajectoryNode,
  TrajectoryTaskReport,
  TrajectoryTaskSummary,
} from "../types";

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

export function TrajectoriesPage({
  tasks,
  api,
  onImport,
}: {
  readonly tasks: readonly TrajectoryTaskSummary[];
  readonly api: FoldApiClient;
  readonly onImport: () => void;
}) {
  const [selectedTaskId, setSelectedTaskId] = useState<string>();
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const [report, setReport] = useState<TrajectoryTaskReport>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (tasks.length === 0) {
      setSelectedTaskId(undefined);
      setReport(undefined);
      return;
    }
    if (selectedTaskId === undefined || !tasks.some(({ taskId }) => taskId === selectedTaskId)) {
      setSelectedTaskId(tasks[0]!.taskId);
    }
  }, [selectedTaskId, tasks]);

  useEffect(() => {
    if (selectedTaskId === undefined) return;
    let active = true;
    setLoading(true);
    setError(undefined);
    void api.trajectoryReport(selectedTaskId).then(
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
  }, [api, selectedTaskId, tasks]);

  const selectedRun = report?.projected.find(({ id }) => id === selectedRunId);
  const selectedRecord = report?.records.find(({ trajectory }) => trajectory.id === selectedRunId);
  const divergence = report?.divergences.find(({ trajectoryId }) => trajectoryId === selectedRunId)?.divergence;
  const evaluation = report?.evaluations.find(({ trajectoryId }) => trajectoryId === selectedRunId);
  const nodes = useMemo(() => report === undefined ? new Map() : nodeIndex(report), [report]);

  return (
    <div className="page page--trajectories">
      <PageHeader
        eyebrow="Decision evidence"
        title="Trajectories"
        actions={<button className="button button--primary" type="button" onClick={onImport}><Import aria-hidden="true" />Import</button>}
      />

      {tasks.length === 0 ? (
        <section className="panel trajectory-empty">
          <EmptyState title="No trajectory tasks" />
          <button className="button button--primary" type="button" onClick={onImport}><Import aria-hidden="true" />Import</button>
        </section>
      ) : (
        <section className="trajectory-workspace">
          <aside className="trajectory-task-list" aria-label="Trajectory tasks">
            <header><span className="eyebrow">Shared trees</span><strong>{tasks.length} tasks</strong></header>
            {tasks.map((task) => (
              <button
                key={task.taskId}
                type="button"
                className={task.taskId === selectedTaskId ? "is-selected" : undefined}
                onClick={() => setSelectedTaskId(task.taskId)}
              >
                <span><strong>{task.taskId}</strong><small>{task.tree.nodes.length} nodes · {task.tree.edges.length} edges</small></span>
                <span className="trajectory-task-list__counts"><b>{task.successCount}</b><i>{task.failureCount}</i></span>
                <time>{formatRelative(task.lastRecordedAt)}</time>
              </button>
            ))}
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
                  <div><span className="eyebrow">Task</span><h2>{report.taskId}</h2></div>
                  <span>{report.tree.nodes.length} nodes · {report.tree.edges.length} edges</span>
                </header>

                <div className="trajectory-metrics" aria-label="Trajectory analysis">
                  <div><CircleDot aria-hidden="true" /><span><strong>{report.analysis.traceCount}</strong><small>Runs</small></span></div>
                  <div><Check aria-hidden="true" /><span><strong>{percent(report.analysis.coverage.mappedRatio)}</strong><small>Mapped</small></span></div>
                  <div><Route aria-hidden="true" /><span><strong>{report.analysis.routeEligibleTraceCount}</strong><small>Complete routes</small></span></div>
                  <div><GitBranch aria-hidden="true" /><span><strong>{report.analysis.routes.length}</strong><small>Observed routes</small></span></div>
                </div>

                <section className="trajectory-consensus">
                  <header><span><span className="eyebrow">Observed evidence</span><h3>Highest-success path</h3></span><small>{report.analysis.incompleteTraceCount} incomplete</small></header>
                  {report.analysis.mostSuccessfulPath.length === 0 ? (
                    <EmptyState title="No complete route" />
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

                <section className="trajectory-run-layout">
                  <div className="trajectory-run-list">
                    <header><span className="eyebrow">Captured runs</span><strong>{report.records.length} records</strong></header>
                    {report.records.length === 0 ? <EmptyState title="No runs recorded" /> : report.records.map((record) => {
                      const runDivergence = report.divergences.find(({ trajectoryId }) => trajectoryId === record.trajectory.id)?.divergence;
                      return (
                        <button key={record.trajectory.id} type="button" className={record.trajectory.id === selectedRunId ? "is-selected" : undefined} onClick={() => setSelectedRunId(record.trajectory.id)}>
                          <span className={`outcome-mark outcome-mark--${record.trajectory.outcome}`}>{record.trajectory.outcome === "success" ? <Check aria-hidden="true" /> : <X aria-hidden="true" />}</span>
                          <span><strong>{record.trajectory.model.id}</strong><small>{record.trajectory.id}</small></span>
                          <span className={`divergence-badge divergence-badge--${runDivergence?.kind ?? "indeterminate"}`}>{runDivergence?.kind ?? "indeterminate"}</span>
                        </button>
                      );
                    })}
                  </div>

                  <article className="trajectory-run-inspector">
                    {selectedRun === undefined || selectedRecord === undefined ? (
                      <EmptyState title="No run selected" />
                    ) : (
                      <>
                        <header>
                          <div><span className="eyebrow">{selectedRun.outcome}</span><h3>{selectedRun.model.id}</h3><code>{selectedRun.id}</code></div>
                          <dl>
                            <div><dt>Projection</dt><dd>{divergence?.kind ?? "indeterminate"}</dd></div>
                            <div><dt>Review</dt><dd>{evaluation?.review.verdict ?? "unmarked"}</dd></div>
                            <div><dt>Confidence</dt><dd>{evaluation === undefined ? "-" : percent(evaluation.oracle.confidence)}</dd></div>
                          </dl>
                        </header>
                        <ol className="trajectory-steps">
                          {selectedRun.steps.map((step) => (
                            <li key={step.raw.id}>
                              <span className="trajectory-step-number">{step.raw.stepNumber}</span>
                              <div><span><b>{step.raw.role.replaceAll("_", " ")}</b><em className={`projection-badge projection-badge--${step.projection.kind}`}>{step.projection.kind}</em></span><p>{step.raw.content}</p><code>{projectionLabel(step)} · {step.projection.method.kind}:{step.projection.method.id}</code></div>
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
