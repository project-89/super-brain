import { History, RefreshCw, Save } from "lucide-react";
import { useEffect, useState } from "react";
import type { FoldApiClient } from "../api";
import type { TrajectoryOutcome, TrajectoryOutcomeRecord, TrajectoryRunRecord } from "../types";
import { LoadMore } from "./LoadMore";

export function TrajectoryOutcomeReview({ record, api, onSaved }: {
  readonly record: TrajectoryRunRecord;
  readonly api: FoldApiClient;
  readonly onSaved: () => Promise<void>;
}) {
  const [outcome, setOutcome] = useState<TrajectoryOutcome>(record.trajectory.outcome);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const [previousEventId, setPreviousEventId] = useState(record.outcomeReview?.eventId ?? null);
  const [history, setHistory] = useState<readonly TrajectoryOutcomeRecord[]>();
  const [historyTotal, setHistoryTotal] = useState(0);
  const [cursor, setCursor] = useState<string>();
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [historyError, setHistoryError] = useState<string>();
  useEffect(() => { setPreviousEventId(record.outcomeReview?.eventId ?? null); }, [record.outcomeReview?.eventId]);

  const loadHistory = async (more = false) => {
    setLoadingHistory(true);
    setHistoryError(undefined);
    try {
      const page = await api.trajectoryOutcomes(record.trajectory.taskId, record.trajectory.id, more ? cursor : undefined);
      setHistory((current) => more ? [...(current ?? []), ...page.items] : page.items);
      setHistoryTotal(page.total);
      setCursor(page.nextCursor);
    } catch (caught) {
      setHistoryError(caught instanceof Error ? caught.message : "Unable to load verdict history");
    } finally {
      setLoadingHistory(false);
    }
  };

  const save = async () => {
    setSaving(true);
    setError(undefined);
    setSaved(false);
    try {
      const review = await api.recordTrajectoryOutcome({
        taskId: record.trajectory.taskId, trajectoryId: record.trajectory.id,
        outcome, reason: reason.trim(), previousEventId,
      });
      setPreviousEventId(review.eventId);
      setReason("");
      setSaved(true);
      setHistory(undefined);
      await onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to save verdict");
    } finally {
      setSaving(false);
    }
  };

  return <section className="trajectory-outcome-review" aria-label="Outcome review">
    {record.outcomeReview !== undefined && <div className="trajectory-outcome-current">
      <p>{record.outcomeReview.reason}</p>
      <small>{record.outcomeReview.actorId} / {new Date(record.outcomeReview.recordedAt).toLocaleString()} / Captured result: {record.recordedOutcome}</small>
    </div>}
    <details>
      <summary>Review outcome</summary>
      <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <label>Task result<select value={outcome} disabled={saving} onChange={(event) => setOutcome(event.target.value as TrajectoryOutcome)}>
          <option value="success">Successful</option><option value="failure">Failed</option><option value="unknown">Not verified</option>
        </select></label>
        <label>Evidence and reason<textarea value={reason} minLength={10} maxLength={4_000} required rows={3} disabled={saving} onChange={(event) => setReason(event.target.value)} /></label>
        <button type="submit" disabled={saving || reason.trim().length < 10}><Save aria-hidden="true" />{saving ? "Saving..." : "Save verdict"}</button>
        {saved && <p role="status">Verdict saved.</p>}
        {error !== undefined && <><p role="alert">{error}</p><button type="button" disabled={saving} onClick={() => void onSaved().catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Unable to reload outcome"))}><RefreshCw aria-hidden="true" />Reload outcome</button></>}
      </form>
    </details>
    <button type="button" disabled={loadingHistory} onClick={() => void loadHistory()}><History aria-hidden="true" />Verdict history</button>
    {history !== undefined && <>
      <ol>{history.map((review) => <li key={review.eventId}>
        <strong>{review.outcome}</strong><span>{review.actorId} / {new Date(review.recordedAt).toLocaleString()}</span>
        <p>{review.reason}</p><code>{review.eventId}</code>
      </li>)}</ol>
      {history.length === 0 && <p>No retrospective verdicts.</p>}
      <LoadMore loaded={history.length} total={historyTotal} hasMore={cursor !== undefined} loading={loadingHistory} error={historyError} onLoadMore={() => void loadHistory(true)} />
    </>}
    {history === undefined && historyError !== undefined && <p role="alert">{historyError}</p>}
  </section>;
}
