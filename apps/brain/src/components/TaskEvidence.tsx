import { useEffect, useRef, useState } from "react";
import type { AttemptRevisionRef, TraceRuntimeObservation, TrajectoryManifest } from "@_89/fold-trace";
import type { TaskEvidencePage } from "@_89/super-brain-client";
import type { FoldApiClient } from "../api";
import { RequestScope } from "../request-scope";
import { EvidenceReference } from "./EvidenceReference";
import { formatDateTime } from "../format";

function Revision({ label, value }: { readonly label: string; readonly value?: AttemptRevisionRef }) {
  return <div className="revision-evidence"><h4>{label}</h4><dl className="metadata-grid">
    <div><dt>Fingerprint</dt><dd>{value?.fingerprintStatus ?? "Unknown"}</dd></div>
    <div><dt>Revision</dt><dd><code>{value?.revisionId ?? "Not recorded"}</code></dd></div>
    <div><dt>Reconstruction</dt><dd>{value?.reconstruction ?? "Unknown"}{value?.reconstruction === "complete" ? " (declared)" : ""}</dd></div>
    <div><dt>Snapshot</dt><dd><code>{value?.snapshot?.artifactId ?? "Not recorded"}</code></dd></div>
  </dl>{value?.snapshot !== undefined && <p className="evidence-note">Private snapshot reference only. Restoring requires local encrypted bytes and the original base commit.</p>}</div>;
}
export function RuntimeEvidence({ runtime }: { readonly runtime: TraceRuntimeObservation }) {
  return <details className="runtime-evidence"><summary>Runtime · {runtime.provenance}{runtime.modelId === undefined ? "" : ` · ${runtime.modelId}`}</summary>
    <dl className="metadata-grid">
      <div><dt>Provider / model</dt><dd>{runtime.providerId ?? "Unknown"} / {runtime.modelId ?? "Unknown"}</dd></div>
      <div><dt>Harness</dt><dd>{runtime.harness === undefined ? "Unknown" : `${runtime.harness.id} ${runtime.harness.version ?? ""}`}</dd></div>
      <div><dt>Configuration</dt><dd>{runtime.configurationId ?? "Not recorded"}</dd></div>
      <div><dt>Permission</dt><dd>{runtime.permissionMode ?? "Not recorded"}</dd></div>
      {runtime.usage !== undefined && <><div><dt>Input / output tokens</dt><dd>{runtime.usage.inputTokens ?? "Unknown"} / {runtime.usage.outputTokens ?? "Unknown"}</dd></div><div><dt>Cached / reasoning tokens</dt><dd>{runtime.usage.cachedInputTokens ?? "Unknown"} / {runtime.usage.reasoningTokens ?? "Unknown"}</dd></div><div><dt>Reported cost</dt><dd>{runtime.usage.cost === undefined ? "Unknown" : `${runtime.usage.cost.amount} ${runtime.usage.cost.currency}`}</dd></div><div><dt>Usage meaning</dt><dd>{runtime.usageScope ?? "unknown"} · {runtime.usageInterpretation ?? "unknown"}</dd></div></>}
    </dl>
    {runtime.settings !== undefined && <pre className="evidence-preview">{JSON.stringify(runtime.settings, null, 2)}</pre>}
    {runtime.tools !== undefined && <p className="evidence-note">Tools: {runtime.tools.map((tool) => `${tool.name}${tool.version === undefined ? "" : ` ${tool.version}`}`).join(", ")}</p>}
    <p className="evidence-note">Reported observation. Unknown or cumulative usage is not summed into an attempt total.</p>
  </details>;
}
export function AttemptEvidence({ manifest, api }: { readonly manifest?: TrajectoryManifest; readonly api: FoldApiClient }) {
  if (manifest === undefined) return <section className="detail-section"><h3>Attempt evidence</h3><p className="evidence-note">This historical run has no task or attempt manifest. Starting revision, context and acceptance are unknown.</p></section>;
  const { task, attempt } = manifest;
  return <section className="detail-section attempt-evidence"><h3>Task and attempt</h3>
    <dl className="metadata-grid"><div><dt>Task version</dt><dd><code>{task.taskVersion}</code></dd></div><div><dt>Attempt</dt><dd><code>{attempt.attemptId}</code></dd></div><div><dt>Goal</dt><dd>{task.goal ?? "Private specification / not recorded"}</dd></div><div><dt>Started</dt><dd>{attempt.startedAt ?? "Unknown"}</dd></div></dl>
    {task.acceptanceCriteria !== undefined && <ul className="criteria-list">{task.acceptanceCriteria.map((item) => <li key={item.id}><code>{item.id}</code> {item.description ?? "Criterion description not recorded"}</li>)}</ul>}
    {task.specification !== undefined && <p className="evidence-note">Private specification reference: <code>{task.specification.artifactId}</code></p>}
    {(task.inputs?.length ?? 0) > 0 && <ul className="criteria-list">{task.inputs!.map((input) => <li key={input.artifactId}>Input reference <code>{input.artifactId}</code> · {input.byteLength === undefined ? "Size unknown" : `${input.byteLength} bytes`}</li>)}</ul>}
    <Revision label="Starting state" value={attempt.startRevision} /><Revision label="Final state" value={attempt.finalRevision} />
    {attempt.acceptance === undefined ? <p className="evidence-note">No exact acceptance reference is recorded for this attempt.</p> : <div className="acceptance-evidence"><strong>Recorded acceptance: {attempt.acceptance.verdict}</strong><p className="evidence-note">Source reference bound to revision <code>{attempt.acceptance.revisionId}</code>. Private authority verification is unavailable in this view.</p><EvidenceReference api={api} evidence={{ eventId: attempt.acceptance.eventId }} /></div>}
    <h4>Offered context</h4>{(attempt.context?.memoryRefs?.length ?? 0) === 0 ? <p className="evidence-note">No exact memory revisions recorded.</p> : <ul>{attempt.context!.memoryRefs!.map((ref) => <li key={`${ref.memoryId}:${ref.revision}`}><code>{ref.memoryId}</code> · revision {ref.revision}</li>)}</ul>}
    {(attempt.context?.lineage?.length ?? 0) > 0 && <ul>{attempt.context!.lineage!.map((ref) => <li key={ref.eventId}>{ref.kind}<EvidenceReference api={api} evidence={{ eventId: ref.eventId }} /></li>)}</ul>}
    <p className="evidence-note">Offered context does not prove it was used.</p>
  </section>;
}
export function TaskEvidenceTimeline({ taskId, api }: { readonly taskId: string; readonly api: FoldApiClient }) {
  const [page, setPage] = useState<TaskEvidencePage>(); const [error, setError] = useState<string>(); const [pending, setPending] = useState(false);
  const requests = useRef(new RequestScope()).current; requests.select([api, taskId]);
  useEffect(() => { let active = true; const request = requests.capture(); setPage(undefined); setError(undefined); setPending(true); void api.taskEvidencePage(taskId, { limit: 25 }).then((value) => { if (active && requests.current(request)) { setPage(value); setPending(false); } }, (caught) => { if (active && requests.current(request)) { setError(caught instanceof Error ? caught.message : "Task evidence unavailable"); setPending(false); } }); return () => { active = false; requests.invalidate(); }; }, [api, taskId, requests]);
  const more = async () => { if (page?.nextCursor === undefined || pending) return; const request = requests.capture(); setPending(true); try { const next = await api.taskEvidencePage(taskId, { limit: 25, cursor: page.nextCursor }); if (!requests.current(request)) return; setPage((current) => ({ ...next, items: [...(current?.items ?? []), ...next.items] })); } catch (caught) { if (requests.current(request)) setError(caught instanceof Error ? caught.message : "Task evidence unavailable"); } finally { if (requests.current(request)) setPending(false); } };
  return <section className="detail-section task-evidence-timeline"><h3>Interventions and later outcomes</h3><p className="evidence-note">These records preserve who reported a correction, approval or external result. They do not replace the original run.</p>
    {page?.items.filter((item) => item.kind === "evidence" && ["outcome", "intervention"].includes(item.record.recordType)).map((item) => {
      if (item.kind !== "evidence" || !("authority" in item.record)) return null;
      const record = item.record;
      return <article key={item.id} className="task-evidence-item"><strong>{record.recordType}: {record.input.kind}{"result" in record.input ? ` · ${record.input.result}` : ""}</strong><span>{record.authority.kind === "human" ? "Authenticated human report" : "Authenticated integration report"} · {record.actorId}</span><time>{formatDateTime(record.recordedAt)}</time><code>{record.input.attemptId} · {record.input.revisionId ?? "Revision unknown"}</code>{record.input.sourceEventId !== undefined && <EvidenceReference api={api} evidence={{ eventId: record.input.sourceEventId }} />}</article>;
    })}
    {page !== undefined && page.items.every((item) => item.kind !== "evidence" || !["outcome", "intervention"].includes(item.record.recordType)) && <p className="evidence-note">No interventions or later outcomes in this page.</p>}
    {error !== undefined && <p role="alert" className="field-error">{error}</p>}
    <div className="evidence-footer"><span>{page === undefined ? pending ? "Loading evidence" : "Evidence unavailable" : `${page.items.length} of ${page.total} task evidence records`}</span>{page?.nextCursor !== undefined && <button type="button" className="text-button" disabled={pending} onClick={() => void more()}>More task evidence</button>}</div>
  </section>;
}
