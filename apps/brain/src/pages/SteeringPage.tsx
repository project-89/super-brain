import {
  Activity,
  Bot,
  Check,
  CircleStop,
  Lightbulb,
  MessageSquareText,
  Plus,
  Send,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { FoldApiClient } from "../api";
import { EmptyState, PageHeader } from "../components/Common";
import { Modal } from "../components/Modal";
import { SteeringCandidateDialog } from "../components/SteeringCandidateDialog";
import { formatDateTime, uniqueSorted } from "../format";
import type {
  FleetSession,
  ReasoningResponse,
  ReasoningProviderStatus,
  SteeringActorSnapshot,
  SteeringCandidate,
  SteeringCandidateDraft,
  SteeringIntention,
  SteeringIntentionEnd,
  SteeringResponse,
} from "../types";

type Resolution =
  | { readonly kind: "decline"; readonly actorId: string; readonly candidate: SteeringCandidate }
  | { readonly kind: "end"; readonly actorId: string; readonly intention: SteeringIntention };

function emptyActor(actorId: string): SteeringActorSnapshot {
  return { actorId, pendingCandidates: [], intentions: [], recentDeclines: [] };
}

export function SteeringPage({
  response,
  fleet,
  api,
  onRefresh,
}: {
  readonly response: SteeringResponse;
  readonly fleet: readonly FleetSession[];
  readonly api: FoldApiClient;
  readonly onRefresh: () => Promise<void>;
}) {
  const actorIds = useMemo(
    () => uniqueSorted([
      ...response.actors.map(({ actorId }) => actorId),
      ...fleet.map(({ agentId }) => agentId),
    ]),
    [fleet, response.actors],
  );
  const [selectedActorId, setSelectedActorId] = useState<string>();
  const [surfaceOpen, setSurfaceOpen] = useState(false);
  const [resolution, setResolution] = useState<Resolution>();
  const [resolutionKind, setResolutionKind] = useState<SteeringIntentionEnd["kind"]>("satisfied");
  const [resolutionDetail, setResolutionDetail] = useState("");
  const [mutationPending, setMutationPending] = useState(false);
  const [mutationError, setMutationError] = useState<string>();
  const [question, setQuestion] = useState("");
  const [questionActor, setQuestionActor] = useState("");
  const [reasoning, setReasoning] = useState<ReasoningResponse>();
  const [reasoningPending, setReasoningPending] = useState(false);
  const [reasoningError, setReasoningError] = useState<string>();
  const [providers, setProviders] = useState<readonly ReasoningProviderStatus[]>([]);
  const [providerId, setProviderId] = useState("");

  useEffect(() => {
    let active = true;
    void api.reasoningProviders().then(
      (next) => {
        if (!active) return;
        setProviders(next);
        setProviderId((current) => current || next.find(({ isDefault }) => isDefault)?.id || next.find(({ configured }) => configured)?.id || "");
      },
      (caught: unknown) => { if (active) setReasoningError(caught instanceof Error ? caught.message : "Reasoning providers unavailable"); },
    );
    return () => { active = false; };
  }, [api]);

  useEffect(() => {
    if (actorIds.length === 0) setSelectedActorId(undefined);
    else if (selectedActorId === undefined || !actorIds.includes(selectedActorId)) {
      const activeActor = response.actors.find(
        (actor) => actor.pendingCandidates.length > 0 || actor.intentions.length > 0,
      );
      setSelectedActorId(activeActor?.actorId ?? actorIds[0]);
    }
  }, [actorIds, response.actors, selectedActorId]);

  const selected = selectedActorId === undefined
    ? undefined
    : response.actors.find(({ actorId }) => actorId === selectedActorId) ?? emptyActor(selectedActorId);
  const totalPending = response.actors.reduce((sum, actor) => sum + actor.pendingCandidates.length, 0);
  const totalIntentions = response.actors.reduce((sum, actor) => sum + actor.intentions.length, 0);
  const totalDeclines = response.actors.reduce((sum, actor) => sum + actor.recentDeclines.length, 0);

  const mutate = async (operation: () => Promise<void>): Promise<boolean> => {
    setMutationPending(true);
    setMutationError(undefined);
    try {
      await operation();
      await onRefresh();
      return true;
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Steering mutation failed";
      setMutationError(message);
      return false;
    } finally {
      setMutationPending(false);
    }
  };

  const surface = async (draft: SteeringCandidateDraft) => {
    if (!await mutate(() => api.surfaceSteeringCandidate(draft))) {
      throw new Error("Candidate surfacing failed");
    }
    setSelectedActorId(draft.actorId);
    setSurfaceOpen(false);
  };

  const ask = async () => {
    if (!question.trim()) return;
    setReasoningPending(true);
    setReasoningError(undefined);
    try {
      setReasoning(await api.askReasoning(question.trim(), questionActor || undefined, providerId || undefined));
    } catch (caught) {
      setReasoning(undefined);
      setReasoningError(caught instanceof Error ? caught.message : "Reasoning request failed");
    } finally {
      setReasoningPending(false);
    }
  };

  const openResolution = (next: Resolution) => {
    setResolution(next);
    setResolutionKind(next.kind === "decline" ? "abandoned" : "satisfied");
    setResolutionDetail("");
    setMutationError(undefined);
  };

  const resolve = async () => {
    if (resolution === undefined) return;
    if (resolution.kind === "decline") {
      if (!resolutionDetail.trim()) return;
      if (!await mutate(() => api.declineSteeringCandidate(
        resolution.actorId,
        resolution.candidate.id,
        resolutionDetail.trim(),
      ))) return;
    } else {
      let end: SteeringIntentionEnd;
      if (resolutionKind === "abandoned") {
        if (!resolutionDetail.trim()) return;
        end = { kind: "abandoned", reason: resolutionDetail.trim() };
      } else if (resolutionKind === "superseded") {
        if (!resolutionDetail.trim()) return;
        end = { kind: "superseded", byIntentionId: resolutionDetail.trim() };
      } else {
        end = { kind: resolutionKind };
      }
      if (!await mutate(() => api.endSteeringIntention(
        resolution.actorId,
        resolution.intention.id,
        end,
      ))) return;
    }
    setResolution(undefined);
  };

  return (
    <div className="page page--steering">
      <PageHeader eyebrow="Reasoning and actuation" title="Human steering" actions={<button className="button button--primary" type="button" onClick={() => setSurfaceOpen(true)} disabled={!response.steeringEnabled}><Plus aria-hidden="true" />Surface candidate</button>} />

      <section className="reasoning-console" aria-label="Pull reasoning">
        <form className="reasoning-console__form" onSubmit={(event) => { event.preventDefault(); void ask(); }}>
          <MessageSquareText aria-hidden="true" />
          <label><span className="sr-only">Question</span><input value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="Ask across authorized memory" /></label>
          <label className="compact-field"><span>Actor context</span><select value={questionActor} onChange={(event) => setQuestionActor(event.target.value)}><option value="">No actor</option>{actorIds.map((actorId) => <option key={actorId}>{actorId}</option>)}</select></label>
          <label className="compact-field"><span>Provider</span><select value={providerId} onChange={(event) => setProviderId(event.target.value)}>{providers.map((provider) => <option key={provider.id} value={provider.id} disabled={provider.configured === false}>{provider.provider ?? provider.kind} · {provider.model ?? provider.id}{provider.configured === false ? " (not configured)" : ""}</option>)}</select></label>
          <button className="icon-button reasoning-console__send" type="submit" disabled={reasoningPending || !question.trim()} aria-label="Ask" title="Ask"><Send aria-hidden="true" /></button>
        </form>
        {reasoningError !== undefined && <span className="reasoning-error" role="alert">{reasoningError}</span>}
        {reasoning !== undefined && (
          <div className="reasoning-answer">
            <header><span className="eyebrow">{reasoning.provider.provider ?? reasoning.provider.kind} / {reasoning.provider.model ?? reasoning.provider.id}</span><span>{reasoning.ranking.kind} recall / {reasoning.ranking.corpusSize} scanned</span></header>
            <p>{reasoning.answer}</p>
            {reasoning.evidence.length > 0 && <ul>{reasoning.evidence.map((item) => <li key={item.memoryId}><Lightbulb aria-hidden="true" /><span><strong>{item.summary || "Untitled memory"}</strong><small>{item.source}{item.score === undefined ? "" : ` / ${Math.round(item.score * 100)}%`}</small></span></li>)}</ul>}
          </div>
        )}
      </section>

      <div className="steering-metrics">
        <div><Bot aria-hidden="true" /><span><strong>{actorIds.length}</strong>actors</span></div>
        <div><Lightbulb aria-hidden="true" /><span><strong>{totalPending}</strong>pending</span></div>
        <div><Activity aria-hidden="true" /><span><strong>{totalIntentions}</strong>active</span></div>
        <div><X aria-hidden="true" /><span><strong>{totalDeclines}</strong>declined</span></div>
      </div>

      <section className="steering-workspace">
        <div className="steering-actor-list" aria-label="Steering actors">
          {actorIds.length === 0 ? <EmptyState title="No steering actors" /> : actorIds.map((actorId) => {
            const actor = response.actors.find((item) => item.actorId === actorId) ?? emptyActor(actorId);
            const session = fleet.find(({ agentId }) => agentId === actorId);
            return <button type="button" key={actorId} className={actorId === selectedActorId ? "is-active" : undefined} onClick={() => setSelectedActorId(actorId)}><span><Bot aria-hidden="true" /><strong>{actorId}</strong></span><small>{actor.intentions.length} active / {actor.pendingCandidates.length} pending{session === undefined ? "" : ` / ${session.availability}`}</small></button>;
          })}
        </div>
        <div className="steering-inspector">
          {selected === undefined ? <EmptyState title="Select an actor" /> : (
            <>
              <header className="steering-inspector__header"><div><span className="eyebrow">Actor</span><h2>{selected.actorId}</h2></div>{selected.driveSample !== undefined && <span className="drive-sample-time">Sampled {formatDateTime(selected.driveSample.elapsedMs)}</span>}</header>
              {mutationError !== undefined && <span className="steering-error" role="alert">{mutationError}</span>}
              <section className="steering-section"><header><h3>Pending candidates</h3><span>{selected.pendingCandidates.length}</span></header>{selected.pendingCandidates.length === 0 ? <EmptyState title="No pending candidates" /> : <ul className="steering-item-list">{selected.pendingCandidates.map((candidate) => <li key={candidate.id}><div><strong>{candidate.aim}</strong><small>{candidate.sourceDriveId} / {candidate.trigger.kind} / {formatDateTime(candidate.surfacedAtMs)}</small><code>{candidate.satisfier.kind}:{candidate.satisfier.ref}</code></div><div><button className="button button--primary" type="button" disabled={mutationPending || !response.steeringEnabled} onClick={() => void mutate(() => api.commitSteeringCandidate(selected.actorId, candidate.id))}><Check aria-hidden="true" />Commit</button><button className="button button--secondary" type="button" disabled={mutationPending || !response.steeringEnabled} onClick={() => openResolution({ kind: "decline", actorId: selected.actorId, candidate })}><X aria-hidden="true" />Decline</button></div></li>)}</ul>}</section>
              <section className="steering-section"><header><h3>Active intentions</h3><span>{selected.intentions.length}</span></header>{selected.intentions.length === 0 ? <EmptyState title="No active intentions" /> : <ul className="steering-item-list">{selected.intentions.map((intention) => <li key={intention.id}><div><strong>{intention.aim}</strong><small>{intention.sourceDriveId} / {intention.attempts} {intention.attempts === 1 ? "action" : "actions"} / {formatDateTime(intention.formedAtMs)}</small><code>{intention.satisfier.kind}:{intention.satisfier.ref}</code></div><div><button className="button button--secondary" type="button" disabled={mutationPending || !response.steeringEnabled} onClick={() => void mutate(() => api.recordSteeringAction(selected.actorId, intention.id))}><Activity aria-hidden="true" />Action</button><button className="button button--secondary" type="button" disabled={mutationPending || !response.steeringEnabled} onClick={() => openResolution({ kind: "end", actorId: selected.actorId, intention })}><CircleStop aria-hidden="true" />End</button></div></li>)}</ul>}</section>
              {selected.recentDeclines.length > 0 && <section className="steering-section"><header><h3>Recent declines</h3><span>{selected.recentDeclines.length}</span></header><ul className="steering-declines">{selected.recentDeclines.map((decline) => <li key={`${decline.candidate.id}:${decline.atMs}`}><span><strong>{decline.candidate.aim}</strong><small>{formatDateTime(decline.atMs)}</small></span><p>{decline.reason}</p></li>)}</ul></section>}
            </>
          )}
        </div>
      </section>

      <SteeringCandidateDialog open={surfaceOpen} pending={mutationPending} actors={actorIds} initialActor={selectedActorId} onClose={() => setSurfaceOpen(false)} onSurface={surface} />
      <Modal open={resolution !== undefined} title={resolution?.kind === "decline" ? "Decline candidate" : "End intention"} onClose={() => setResolution(undefined)}>
        <div className="form-stack">
          <p className="confirm-copy">{resolution?.kind === "decline" ? resolution.candidate.aim : resolution?.intention.aim}</p>
          {resolution?.kind === "end" && <label className="field"><span>Outcome</span><select value={resolutionKind} onChange={(event) => setResolutionKind(event.target.value as SteeringIntentionEnd["kind"])}><option value="satisfied">Satisfied</option><option value="abandoned">Abandoned</option><option value="expired">Expired</option><option value="superseded">Superseded</option></select></label>}
          {(resolution?.kind === "decline" || resolutionKind === "abandoned" || resolutionKind === "superseded") && <label className="field"><span>{resolution?.kind === "decline" ? "Reason" : resolutionKind === "superseded" ? "Superseding intention" : "Reason"}</span><input value={resolutionDetail} onChange={(event) => setResolutionDetail(event.target.value)} autoFocus /></label>}
          {mutationError !== undefined && <span className="field-error" role="alert">{mutationError}</span>}
          <footer className="modal__actions"><button className="button button--secondary" type="button" onClick={() => setResolution(undefined)} disabled={mutationPending}>Cancel</button><button className="button button--primary" type="button" onClick={() => void resolve()} disabled={mutationPending || ((resolution?.kind === "decline" || resolutionKind === "abandoned" || resolutionKind === "superseded") && !resolutionDetail.trim())}>{resolution?.kind === "decline" ? <X aria-hidden="true" /> : <CircleStop aria-hidden="true" />}{mutationPending ? "Recording" : resolution?.kind === "decline" ? "Decline" : "End"}</button></footer>
        </div>
      </Modal>
    </div>
  );
}
