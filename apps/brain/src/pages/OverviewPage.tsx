import { Activity, ArrowRight, BookOpen, Bot, BrainCircuit, CheckCircle2, CircleAlert, Database, FolderGit2, RadioTower, Route, Sparkles, Wrench } from "lucide-react";
import { EmptyState, PageHeader } from "../components/Common";
import { formatRelative, memorySourceLabel } from "../format";
import type { BrainPage, BrainSnapshot } from "../types";

export function OverviewPage({
  snapshot,
  navigate,
}: {
  readonly snapshot: BrainSnapshot;
  readonly navigate: (page: BrainPage) => void;
}) {
  const quality = snapshot.dataQuality;
  const turns = quality?.transcripts.turns ?? snapshot.transcriptRuns.reduce((sum, run) => sum + run.counts.turns, 0);
  const actions = quality?.transcripts.actions ?? snapshot.transcriptRuns.reduce((sum, run) => sum + run.counts.actions, 0);
  const classifiedTrajectories = (quality?.trajectories.successful ?? 0) + (quality?.trajectories.failed ?? 0);
  const qualitySignals = quality === undefined ? [] : [
    {
      label: "Run attribution",
      value: `${quality.transcripts.resolvedRuns.toLocaleString()} / ${quality.transcripts.runs.toLocaleString()}`,
      detail: quality.transcripts.resolvedRuns === quality.transcripts.runs ? "Every archived run has a project." : "Some archived runs still need a project.",
      tone: quality.transcripts.resolvedRuns === quality.transcripts.runs ? "good" : "warning",
    },
    {
      label: "Transcript retention",
      value: `${quality.transcripts.storedArtifacts.toLocaleString()} / ${quality.transcripts.artifacts.toLocaleString()}`,
      detail: `${quality.transcripts.reasoningIncludedArtifacts.toLocaleString()} policy-declared artifacts include reasoning.`,
      tone: quality.transcripts.storedArtifacts === quality.transcripts.artifacts ? "good" : "warning",
    },
    {
      label: "Memory evidence",
      value: `${quality.memories.withEvidence.toLocaleString()} / ${quality.memories.total.toLocaleString()}`,
      detail: quality.memories.withEvidence === 0 ? "Accepted legacy memories do not carry evidence links yet." : "Memories retain direct links to their source records.",
      tone: quality.memories.withEvidence === quality.memories.total ? "good" : "warning",
    },
    {
      label: "Classified outcomes",
      value: `${classifiedTrajectories.toLocaleString()} / ${quality.trajectories.runs.toLocaleString()}`,
      detail: `${quality.trajectories.tasksWithDecisions.toLocaleString()} of ${quality.trajectories.tasks.toLocaleString()} paths include explicit decision points.`,
      tone: quality.trajectories.runs > 0 && classifiedTrajectories / quality.trajectories.runs >= 0.8 ? "good" : "warning",
    },
    {
      label: "Memory review",
      value: `${quality.memories.validated.toLocaleString()} / ${quality.memories.total.toLocaleString()}`,
      detail: quality.memories.validated === 0 ? "No usefulness judgments recorded yet." : `${quality.memories.feedback.helpful.toLocaleString()} helpful, ${quality.memories.feedback.unhelpful.toLocaleString()} unhelpful, ${quality.memories.feedback.superseded.toLocaleString()} superseded judgments.`,
      tone: quality.memories.validated > 0 ? "good" : "warning",
    },
  ] as const;

  return (
    <div className="page page--overview">
      <PageHeader eyebrow="Workspace pulse" title="Overview" />

      <section className="metrics-band" aria-label="Workspace totals">
        <div className="metric"><span className="metric__icon metric__icon--green"><FolderGit2 aria-hidden="true" /></span><div><strong>{(quality?.transcripts.projects ?? snapshot.transcriptProjects.length).toLocaleString()}</strong><span>Projects</span></div></div>
        <div className="metric"><span className="metric__icon metric__icon--coral"><Bot aria-hidden="true" /></span><div><strong>{(quality?.transcripts.runs ?? snapshot.transcriptRunTotal).toLocaleString()}</strong><span>Archived runs</span></div></div>
        <div className="metric"><span className="metric__icon metric__icon--blue"><BookOpen aria-hidden="true" /></span><div><strong>{turns.toLocaleString()}</strong><span>Captured turns</span></div></div>
        <div className="metric"><span className="metric__icon metric__icon--yellow"><Wrench aria-hidden="true" /></span><div><strong>{actions.toLocaleString()}</strong><span>Observable actions</span></div></div>
      </section>

      <section className="operations-band" aria-label="System operations">
        <button type="button" onClick={() => navigate("fleet")}><RadioTower aria-hidden="true" /><span><strong>{snapshot.captureHealth === undefined ? "Offline" : "Online"}</strong><small>Capture daemon</small></span></button>
        <button type="button" onClick={() => navigate("fleet")}><Activity aria-hidden="true" /><span><strong>{snapshot.captureHealth?.activeSessions ?? snapshot.fleet.fleet.sessions.filter(({ availability }) => availability === "available").length}</strong><small>Live sessions</small></span></button>
        <button type="button" onClick={() => navigate("memory")}><BrainCircuit aria-hidden="true" /><span><strong>{snapshot.memoryCandidateTotal}</strong><small>Memory proposals</small></span></button>
        <button type="button" onClick={() => navigate("trajectories")}><Route aria-hidden="true" /><span><strong>{snapshot.trajectoryTaskTotal}</strong><small>Decision trees</small></span></button>
        <button type="button" onClick={() => navigate("fleet")}><RadioTower aria-hidden="true" /><span><strong>{snapshot.fleet.fleet.recoveryActions.length}</strong><small>Recovery actions</small></span></button>
      </section>

      {quality !== undefined && <section className="learning-pipeline" aria-label="Knowledge pipeline">
        <header><div><span className="eyebrow">Knowledge pipeline</span><h2>From evidence to useful recall</h2></div><span>{quality.corpus.events.toLocaleString()} canonical events</span></header>
        <div className="learning-pipeline__stages">
          <button type="button" onClick={() => navigate("history")}><span><Database aria-hidden="true" /></span><strong>{quality.corpus.observations.toLocaleString()}</strong><small>Observed signals</small><em>Captured</em></button>
          <button type="button" onClick={() => navigate("memory")}><span><Sparkles aria-hidden="true" /></span><strong>{quality.memories.proposed.toLocaleString()}</strong><small>Memory proposals</small><em>{quality.memories.highConfidencePending.toLocaleString()} high confidence</em></button>
          <button type="button" onClick={() => navigate("memory")}><span><BrainCircuit aria-hidden="true" /></span><strong>{quality.memories.total.toLocaleString()}</strong><small>Available memories</small><em>{quality.memories.recalled.toLocaleString()} recalled</em></button>
          <button type="button" onClick={() => navigate("memory")} className={quality.memories.validated === 0 ? "is-unproven" : "is-proven"}><span>{quality.memories.validated === 0 ? <CircleAlert aria-hidden="true" /> : <CheckCircle2 aria-hidden="true" />}</span><strong>{quality.memories.validated.toLocaleString()}</strong><small>Reviewed memories</small><em>{quality.memories.validated === 0 ? "Not measured yet" : "Judgments recorded"}</em></button>
        </div>
      </section>}

      <section className="overview-grid">
        <div className="panel panel--activity">
          <header className="panel__header">
            <div><span className="eyebrow">Capture coverage</span><h2>Sources</h2></div>
            <button className="text-button" type="button" onClick={() => navigate("history")}>Run history <ArrowRight aria-hidden="true" /></button>
          </header>
          {quality === undefined ? <EmptyState title="Capture audit unavailable" /> : <div className="table-wrap"><table className="data-table">
            <thead><tr><th>Source</th><th>Runs</th><th>Turns</th><th>Actions</th><th>Unparsed</th></tr></thead>
            <tbody>{quality.transcripts.bySource.map((source) => <tr key={source.source}><td>{source.source === "claude-code" ? "Claude Code" : source.source === "codex" ? "Codex" : source.source}</td><td>{source.runs.toLocaleString()}</td><td>{source.turns.toLocaleString()}</td><td>{source.actions.toLocaleString()}</td><td>{source.unknownRecords.toLocaleString()}</td></tr>)}</tbody>
          </table></div>}
        </div>

        <div className="panel panel--memory-preview">
          <header className="panel__header">
            <div><span className="eyebrow">Knowledge readiness</span><h2>Memory status</h2></div>
            <button className="text-button" type="button" onClick={() => navigate("memory")}>Open memory <ArrowRight aria-hidden="true" /></button>
          </header>
          {quality === undefined ? <EmptyState title="Memory audit unavailable" /> : <ol className="memory-preview-list">
            <li><button type="button" onClick={() => navigate("memory")}><span className="memory-preview-list__summary">{quality.memories.total.toLocaleString()} available memories</span><span className="memory-preview-list__meta">Accepted knowledge available to retrieval</span></button></li>
            <li><button type="button" onClick={() => navigate("memory")}><span className="memory-preview-list__summary">{quality.memories.proposed.toLocaleString()} proposals need review</span><span className="memory-preview-list__meta">{quality.memories.highConfidencePending.toLocaleString()} meet the 80% confidence threshold</span></button></li>
            <li><button type="button" onClick={() => navigate("memory")}><span className="memory-preview-list__summary">{quality.memories.recalled.toLocaleString()} memories recalled</span><span className="memory-preview-list__meta">{quality.memories.validated.toLocaleString()} have a usefulness judgment</span></button></li>
          </ol>}
        </div>
      </section>

      {qualitySignals.length > 0 && <section className="quality-panel">
        <header><div><span className="eyebrow">Usefulness audit</span><h2>What the corpus can support today</h2></div><time>Scanned {formatRelative(quality!.generatedAt)}</time></header>
        <div>{qualitySignals.map((signal) => <article key={signal.label} className={`quality-signal quality-signal--${signal.tone}`}><span>{signal.tone === "good" ? <CheckCircle2 aria-hidden="true" /> : <CircleAlert aria-hidden="true" />}</span><div><strong>{signal.label}</strong><small>{signal.detail}</small></div><b>{signal.value}</b></article>)}</div>
      </section>}

      <section className="panel panel--events">
        <header className="panel__header">
          <div><span className="eyebrow">Derivation coverage</span><h2>Memory proposal origins</h2></div>
          <button className="text-button" type="button" onClick={() => navigate("memory")}>Review proposals <ArrowRight aria-hidden="true" /></button>
        </header>
        {quality === undefined ? <EmptyState title="Memory audit unavailable" /> : (
          <div className="table-wrap"><table className="data-table">
            <thead><tr><th>Source</th><th>Pending review</th><th>Accepted</th><th>Rejected</th></tr></thead>
            <tbody>{quality.memories.candidateSources.map((source) => (
              <tr key={source.source}><td>{memorySourceLabel(source.source)}</td><td>{source.proposed.toLocaleString()}</td><td>{source.accepted.toLocaleString()}</td><td>{source.rejected.toLocaleString()}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
    </div>
  );
}
