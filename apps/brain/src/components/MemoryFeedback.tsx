import { useEffect, useState } from "react";
import type { MemoryFeedbackSummary } from "@_89/super-brain-client";
import type { FoldApiClient } from "../api";
export function MemoryFeedback({ api, memoryId, revision }: { readonly api: FoldApiClient; readonly memoryId: string; readonly revision: number }) {
  const [summary, setSummary] = useState<MemoryFeedbackSummary>(); const [error, setError] = useState<string>();
  useEffect(() => { let active = true; setSummary(undefined); setError(undefined); void api.memoryFeedbackSummary(memoryId, revision).then((value) => { if (active) setSummary(value); }, (caught) => { if (active) setError(caught instanceof Error ? caught.message : "Feedback summary unavailable"); }); return () => { active = false; }; }, [api, memoryId, revision]);
  return <section className="detail-section"><h3>Reported usefulness · revision {revision}</h3>
    {summary === undefined ? <p className="evidence-note">{error ?? "Loading feedback"}</p> : <><dl className="metadata-grid"><div><dt>Offered / injected</dt><dd>{summary.offered} / {summary.injected}</dd></div><div><dt>Reported use / outcomes</dt><dd>{summary.used} / {summary.outcomes}</dd></div><div><dt>Latest judgments per actor</dt><dd>{summary.helpful} helpful · {summary.unhelpful} unhelpful · {summary.superseded} reported superseded</dd></div><div><dt>People / agents reporting</dt><dd>{summary.distinctActors}</dd></div></dl><p className="evidence-note">Judgments do not certify accuracy or change memory currentness. {summary.legacyUnversioned} historical signals have no revision attribution.</p>{summary.reviewSuggested && <p className="evidence-note evidence-note--review">A usefulness report suggests reviewing this memory.</p>}</>}
  </section>;
}
