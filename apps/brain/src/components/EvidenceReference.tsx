import { useEffect, useRef, useState } from "react";
import type { FoldApiClient } from "../api";
import type { MemoryCandidateEvidence } from "@_89/fold-epistemic";
import { RequestScope } from "../request-scope";
import { formatDateTime } from "../format";

export function EvidenceReference({ evidence, api }: { readonly evidence: Pick<MemoryCandidateEvidence, "eventId" | "projectId" | "runId" | "turnId">; readonly api: FoldApiClient }) {
  const [detail, setDetail] = useState<string>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const requests = useRef(new RequestScope()).current; requests.select([api, evidence.eventId, evidence.runId, evidence.turnId]);
  useEffect(() => { setDetail(undefined); setError(undefined); setPending(false); return () => requests.invalidate(); }, [api, evidence.eventId, evidence.runId, evidence.turnId, requests]);
  const inspect = async () => {
    const request = requests.capture();
    if (detail !== undefined) { setDetail(undefined); return; }
    setPending(true); setError(undefined);
    try {
      const entries = await api.eventsById([evidence.eventId]);
      if (!requests.current(request)) return;
      const source = entries.find(({ event }) => event.id === evidence.eventId)?.event;
      if (source === undefined) throw new Error("Source is unavailable under your current access");
      setDetail(`${source.title}\n${source.kind}\nRecorded by ${source.author.id} (${source.author.kind})\n${formatDateTime(source.at.t)}\nCanonical source found. Private bytes and human authority have not been verified here.`);
    } catch (caught) { if (requests.current(request)) setError(caught instanceof Error ? caught.message : "Source is unavailable"); }
    finally { if (requests.current(request)) setPending(false); }
  };
  return <div className="evidence-reference">
    <button className="text-button" type="button" disabled={pending} onClick={() => void inspect()} aria-expanded={detail !== undefined}>{pending ? "Checking source" : detail === undefined ? "Inspect source" : "Close source"}</button>
    <code>{evidence.eventId}</code>
    {evidence.runId !== undefined && <span>Run <code>{evidence.runId}</code></span>}
    {evidence.turnId !== undefined && <span>Turn <code>{evidence.turnId}</code></span>}
    {evidence.projectId !== undefined && <span>Project <code>{evidence.projectId}</code></span>}
    {detail !== undefined && <pre className="evidence-preview">{detail}</pre>}
    {error !== undefined && <span className="field-error" role="alert">{error}</span>}
  </div>;
}
