import { Plus } from "lucide-react";
import { useEffect, useState } from "react";

import type { SteeringCandidateDraft, SurfacingTrigger } from "../types";
import { Modal } from "./Modal";

export function SteeringCandidateDialog({
  open,
  pending,
  actors,
  initialActor,
  onClose,
  onSurface,
}: {
  readonly open: boolean;
  readonly pending: boolean;
  readonly actors: readonly string[];
  readonly initialActor?: string;
  readonly onClose: () => void;
  readonly onSurface: (draft: SteeringCandidateDraft) => Promise<void>;
}) {
  const [actorId, setActorId] = useState("");
  const [sourceDriveId, setSourceDriveId] = useState("delivery");
  const [satisfierKind, setSatisfierKind] = useState("task");
  const [satisfierRef, setSatisfierRef] = useState("");
  const [aim, setAim] = useState("");
  const [triggerKind, setTriggerKind] = useState<SurfacingTrigger["kind"]>("threshold");
  const [triggerNote, setTriggerNote] = useState("");
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open) return;
    setActorId(initialActor ?? actors[0] ?? "");
    setError(undefined);
  }, [actors, initialActor, open]);

  const valid = [actorId, sourceDriveId, satisfierKind, satisfierRef, aim].every((value) => value.trim()) &&
    (triggerKind !== "coincidence" || triggerNote.trim().length > 0);

  const submit = async () => {
    if (!valid) return;
    try {
      setError(undefined);
      await onSurface({
        actorId: actorId.trim(),
        sourceDriveId: sourceDriveId.trim(),
        satisfierKind: satisfierKind.trim(),
        satisfierRef: satisfierRef.trim(),
        aim: aim.trim(),
        trigger: triggerKind === "coincidence"
          ? { kind: "coincidence", note: triggerNote.trim() }
          : { kind: triggerKind },
      });
      setSatisfierRef("");
      setAim("");
      setTriggerNote("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Candidate surfacing failed");
    }
  };

  return (
    <Modal open={open} title="Surface candidate" onClose={onClose}>
      <div className="form-stack">
        <label className="field"><span>Actor</span><input list="steering-actors" value={actorId} onChange={(event) => setActorId(event.target.value)} autoFocus /><datalist id="steering-actors">{actors.map((actor) => <option value={actor} key={actor} />)}</datalist></label>
        <label className="field"><span>Aim</span><textarea value={aim} onChange={(event) => setAim(event.target.value)} /></label>
        <div className="form-grid">
          <label className="field"><span>Source drive</span><input value={sourceDriveId} onChange={(event) => setSourceDriveId(event.target.value)} /></label>
          <label className="field"><span>Trigger</span><select value={triggerKind} onChange={(event) => setTriggerKind(event.target.value as SurfacingTrigger["kind"])}><option value="threshold">Threshold</option><option value="quiet">Quiet</option><option value="coincidence">Coincidence</option></select></label>
          <label className="field"><span>Satisfier kind</span><input value={satisfierKind} onChange={(event) => setSatisfierKind(event.target.value)} /></label>
          <label className="field"><span>Satisfier reference</span><input value={satisfierRef} onChange={(event) => setSatisfierRef(event.target.value)} /></label>
        </div>
        {triggerKind === "coincidence" && <label className="field"><span>Coincidence note</span><input value={triggerNote} onChange={(event) => setTriggerNote(event.target.value)} /></label>}
        {error !== undefined && <span className="field-error" role="alert">{error}</span>}
        <footer className="modal__actions"><button className="button button--secondary" type="button" onClick={onClose} disabled={pending}>Cancel</button><button className="button button--primary" type="button" onClick={() => void submit()} disabled={pending || !valid}><Plus aria-hidden="true" />{pending ? "Surfacing" : "Surface"}</button></footer>
      </div>
    </Modal>
  );
}
