import { useEffect, useState } from "react";
import { decodeEpisodeEvidence, evidenceLabel, evidenceObject, recordMatchesCitation, sourceRecords } from "../episode-view";
import type { EpisodeCitation, EpisodeSourceRecord } from "../episode-types";

const labels: Record<string, string> = { "agent-message": "Agent message", "agent-link": "Agent communication", "tool-result": "Tool result", "web-search": "Web search", usage: "Token usage" };
function readableLabel(key: string) { return key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]/g, " "); }
// Retain every field. Nested data is rendered as labeled prose, with raw JSON secondary.
function EvidenceFields({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span>Not recorded</span>;
  if (Array.isArray(value)) return <div>{value.map((item, index) => <div className="episode-evidence-item" key={index}><EvidenceFields value={item} /></div>)}</div>;
  if (typeof value === "object") return <dl className="episode-evidence-fields">{Object.entries(value).map(([key, item]) => <div key={key}><dt>{readableLabel(key)}</dt><dd><EvidenceFields value={item} /></dd></div>)}</dl>;
  return <span className="episode-evidence-text">{String(value)}</span>;
}
function JsonDetails({ title, value }: { title: string; value: unknown }) {
  const [open, setOpen] = useState(false);
  return <details onToggle={event => setOpen(event.currentTarget.open)}><summary>{title}</summary>{open && <pre>{JSON.stringify(value, null, 2)}</pre>}</details>;
}
function TranscriptRecord({ record, focused, id }: { record: Record<string, unknown>; focused: boolean; id: string }) {
  const [open, setOpen] = useState(focused);
  useEffect(() => { if (focused) setOpen(true); }, [focused]);
  return <details className={`episode-transcript-record${focused ? " is-focused" : ""}`} id={id} open={open} onToggle={event => setOpen(event.currentTarget.open)}><summary>{labels[String(record.kind)] ?? String(record.kind ?? "Record")} · record {String(record.ordinal)} · retained line {String(record.line)}</summary>{open && <EvidenceFields value={record.data} />}</details>;
}
export function EpisodeEvidence({ source, citation }: { source: EpisodeSourceRecord; citation: EpisodeCitation | undefined }) {
  const [visible, setVisible] = useState(20);
  let content: unknown; let error: string | undefined;
  try { content = decodeEpisodeEvidence(source.event); } catch (caught) { error = caught instanceof Error ? caught.message : "Retained content is unavailable"; }
  const records = sourceRecords(content);
  const targetIndex = records.findIndex(record => recordMatchesCitation(record, citation));
  useEffect(() => { if (targetIndex >= 0) setVisible(current => Math.max(current, targetIndex + 1)); }, [targetIndex]);
  useEffect(() => { if (citation !== undefined) document.getElementById(targetIndex >= 0 ? `episode-record-${source.eventId}-${targetIndex}` : `episode-source-${source.eventId}`)?.scrollIntoView({ block: "nearest" }); }, [citation, source.eventId, targetIndex, visible]);
  const memory = evidenceObject(source.memory);
  const changes = evidenceObject(content)?.changes;
  const observations = Array.isArray(changes) ? changes.flatMap(change => { const after = evidenceObject(evidenceObject(change)?.after); return after === undefined ? [] : [after]; }) : [];
  return <article className={`episode-source${citation ? " is-focused" : ""}`} id={`episode-source-${source.eventId}`}>
    <h3>{evidenceLabel(source.quality)}</h3><code>{source.eventId}</code>
    {source.quality === "memory-derived" && <><p>Current secondary account, not an original transcript. Historical provenance anchor for memory <code>{source.memorySnapshot?.memoryId ?? "unavailable"}</code>, revision {source.memorySnapshot?.revision ?? "unavailable"}. Repeated anchors are correlated evidence.</p>{memory && <section><h4>{typeof memory.summary === "string" ? memory.summary : "Current memory"}</h4><EvidenceFields value={memory.content} /></section>}</>}
    {source.quality === "checkpoint" && observations.map((observation, index) => <section key={index}><h4>{readableLabel(String(observation.observation ?? "Recorded check"))}</h4><EvidenceFields value={observation.data ?? observation} /></section>)}
    {source.quality === "metadata-only" && <p>No supported task narrative was retained in this record. It remains ungrouped.</p>}
    {records.slice(0, visible).map((record, index) => <TranscriptRecord record={record} focused={recordMatchesCitation(record, citation)} key={index} id={`episode-record-${source.eventId}-${index}`} />)}
    {records.length > 0 && <div className="load-more"><span>{Math.min(visible, records.length)} of {records.length} retained records</span>{visible < records.length && <button className="button button--secondary" onClick={() => setVisible(current => current + 20)}>Load more records</button>}</div>}
    {error && <p role="alert">{error}</p>}
    {source.memory !== undefined && <JsonDetails title="Complete assembled memory JSON" value={source.memory} />}
    <JsonDetails title="Complete retained source JSON" value={content ?? source.event} />
    <details><summary>Source digests</summary><dl><dt>Canonical record</dt><dd><code>{source.sha256}</code></dd>{source.memorySnapshot && <><dt>Memory snapshot</dt><dd><code>{source.memorySnapshot.sha256}</code></dd></>}</dl></details>
  </article>;
}
