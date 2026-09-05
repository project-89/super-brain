import { useEffect, useRef, useState } from "react";
import type { MemoryCandidateEvidence, PersonalMemory } from "@_89/fold-epistemic";
import type { FoldApiClient } from "../api";
import { formatDateTime } from "../format";
import { RequestScope } from "../request-scope";
import { EvidenceReference } from "./EvidenceReference";

export function MemoryEvidence({ memory, api }: { readonly memory: PersonalMemory; readonly api: FoldApiClient }) {
  const [revision, setRevision] = useState(memory.revision);
  const [items, setItems] = useState<readonly MemoryCandidateEvidence[]>([]);
  const [total, setTotal] = useState(0);
  const [contributors, setContributors] = useState<readonly { eventId: string; contributorId: string; contributedAt: number; evidenceCount: number }[]>([]);
  const [contributionOffset, setContributionOffset] = useState<number>();
  const [contributionTotal, setContributionTotal] = useState(0);
  const [offset, setOffset] = useState<number>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const requests = useRef(new RequestScope()).current;
  requests.select([api, memory.id, revision, memory.revision]);
  useEffect(() => { setRevision(memory.revision); }, [memory.id, memory.revision]);
  useEffect(() => {
    let active = true; const request = requests.capture();
    setItems([]); setContributors([]); setContributionOffset(undefined); setContributionTotal(0); setOffset(undefined); setTotal(0); setPending(true); setError(undefined);
    void api.memoryEvidencePage(memory.id, { revision, limit: 25 }).then((page) => {
      if (!active || !requests.current(request)) return;
      setItems(page.evidence); setContributors(page.contributions ?? []); setContributionOffset(page.nextContributionOffset); setContributionTotal(page.contributionTotal ?? 0); setTotal(page.total); setOffset(page.nextOffset); setPending(false);
    }, (caught) => { if (active && requests.current(request)) { setError(caught instanceof Error ? caught.message : "Evidence is unavailable"); setPending(false); } });
    return () => { active = false; requests.invalidate(); };
  }, [api, memory.id, revision, memory.revision, requests]);
  const loadMore = async () => {
    if (offset === undefined || pending) return;
    const request = requests.capture();
    setPending(true); setError(undefined);
    try {
      const page = await api.memoryEvidencePage(memory.id, { revision, limit: 25, offset });
      if (!requests.current(request)) return;
      setItems((current) => [...current, ...page.evidence]); setTotal(page.total); setOffset(page.nextOffset);
    } catch (caught) { if (requests.current(request)) setError(caught instanceof Error ? caught.message : "Evidence is unavailable"); }
    finally { if (requests.current(request)) setPending(false); }
  };
  const moreContributors = async () => {
    if (contributionOffset === undefined || pending) return;
    const request = requests.capture();
    setPending(true); setError(undefined);
    try { const page = await api.memoryEvidencePage(memory.id, { revision, limit: 25, contributionOffset }); if (!requests.current(request)) return; setContributors((current) => [...current, ...(page.contributions ?? [])]); setContributionOffset(page.nextContributionOffset); setContributionTotal(page.contributionTotal ?? 0); }
    catch (caught) { if (requests.current(request)) setError(caught instanceof Error ? caught.message : "Contributors are unavailable"); }
    finally { if (requests.current(request)) setPending(false); }
  };
  return <section className="detail-section evidence-section">
    <header className="evidence-heading"><h3>Evidence and contributors</h3><label className="compact-field"><span>Revision</span><input aria-label="Evidence revision" type="number" min={0} max={memory.revision} value={revision} disabled={pending} onChange={(event) => { const value = Number(event.target.value); if (Number.isSafeInteger(value) && value >= 0 && value <= memory.revision) setRevision(value); }} /></label></header>
    <p className="evidence-note">Creator: <code>{memory.creatorId}</code>. Contributions below belong to revision {revision}; they do not imply agreement.</p>
    {memory.sourceCandidate !== undefined && <p className="evidence-note">Accepted from proposal <code>{memory.sourceCandidate.candidateId}</code> revision {memory.sourceCandidate.revision}. Its acceptance-time evidence is included in this page.</p>}
    {items.length === 0 && !pending && error === undefined && <p className="evidence-note">No source evidence recorded for this revision.</p>}
    <ul className="candidate-evidence">{items.map((item, index) => <li key={`${item.eventId}:${item.turnId ?? ""}:${index}`}>
      <strong>{item.relation === "opposes" ? "Opposes" : "Supports"}</strong>
      <EvidenceReference evidence={item} api={api} />
    </li>)}</ul>
    {contributors.length > 0 && <ul className="evidence-contributors">{contributors.map((item) => <li key={item.eventId}>{item.contributorId} · {item.evidenceCount} references · {formatDateTime(item.contributedAt)}<code>{item.eventId}</code></li>)}</ul>}
    <div className="evidence-footer"><span>{contributors.length} of {contributionTotal} contribution records</span>{contributionOffset !== undefined && <button className="text-button" type="button" disabled={pending} onClick={() => void moreContributors()}>More contributors</button>}</div>
    {error !== undefined && <p className="field-error" role="alert">{error}</p>}
    <div className="evidence-footer"><span>{items.length} of {total} references · revision {revision}</span>{offset !== undefined && <button className="text-button" type="button" disabled={pending} onClick={() => void loadMore()}>{pending ? "Loading" : "More evidence"}</button>}</div>
  </section>;
}
