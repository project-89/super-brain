import { Save } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";

import { memoryContent } from "../format";
import type { JsonValue, MemoryDraft, PersonalMemory } from "../types";
import { RequestScope } from "../request-scope";
import { Modal } from "./Modal";

const EMPTY_DRAFT: MemoryDraft = {
  audience: "personal",
  projectIds: [],
  applicability: { kind: "unresolved" },
  source: "conversation",
  summary: "",
  content: "",
  tags: [],
};

interface MemoryDialogProps {
  readonly memory?: PersonalMemory;
  readonly open: boolean;
  readonly pending: boolean;
  readonly error?: string;
  readonly onRefresh?: () => Promise<PersonalMemory | undefined>;
  readonly onClose: () => void;
  readonly onSave: (draft: MemoryDraft) => Promise<void>;
}

export function MemoryDialog({ memory, open, pending, error, onRefresh, onClose, onSave }: MemoryDialogProps) {
  const [draft, setDraft] = useState<MemoryDraft>(EMPTY_DRAFT);
  const [tags, setTags] = useState("");
  const [projects, setProjects] = useState("");
  const [contentText, setContentText] = useState("");
  const [contentMode, setContentMode] = useState<"text" | "json">("text");
  const requests = useRef(new RequestScope()).current; requests.select([memory?.id, open, onRefresh]);
  useEffect(() => () => requests.invalidate(), [memory?.id, open, onRefresh, requests]);
  const [refreshPending, setRefreshPending] = useState(false);
  const [latest, setLatest] = useState<PersonalMemory>();
  const [refreshError, setRefreshError] = useState<string>();
  const [contentError, setContentError] = useState<string>();

  useEffect(() => {
    const next = memory === undefined
      ? EMPTY_DRAFT
      : {
          source: memory.source,
          audience: memory.audience,
          projectIds: memory.projectIds,
          applicability: memory.applicability ?? { kind: "unresolved" as const },
          expectedRevision: memory.revision,
          summary: memory.summary,
          content: memoryContent(memory),
          tags: memory.tags,
          ...(memory.spaceId === undefined ? {} : { spaceId: memory.spaceId }),
        };
    setLatest(undefined); setRefreshError(undefined); setRefreshPending(false);
    setDraft(next);
    setTags(next.tags.join(", "));
    setProjects(next.projectIds.join(", "));
    setContentText(next.content as string);
    setContentMode(memory !== undefined && typeof memory.content !== "string" ? "json" : "text");
    setContentError(undefined);
  }, [memory, open]);

  const refreshLatest = async () => {
    if (onRefresh === undefined || refreshPending) return;
    const request = requests.capture(); setRefreshPending(true); setRefreshError(undefined);
    try { const value = await onRefresh(); if (!requests.current(request)) return; if (value === undefined) setRefreshError("This memory is no longer available"); else setLatest(value); }
    catch (caught) { if (requests.current(request)) setRefreshError(caught instanceof Error ? caught.message : "Latest revision is unavailable"); }
    finally { if (requests.current(request)) setRefreshPending(false); }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    let content: JsonValue = contentText;
    if (contentMode === "json") {
      try {
        content = JSON.parse(contentText) as JsonValue;
        setContentError(undefined);
      } catch {
        setContentError("Enter valid JSON");
        return;
      }
    }
    const parsedTags = tags
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean);
    const parsedProjects = projects
      .split(",")
      .map((project) => project.trim())
      .filter(Boolean);
    void onSave({
      ...draft,
      content,
      tags: [...new Set(parsedTags)],
      projectIds: [...new Set(parsedProjects)],
      applicability: draft.applicability?.kind === "projects" ? { kind: "projects", projectIds: [...new Set(parsedProjects)] } : draft.applicability,
    });
  };

  return (
    <Modal open={open} title={memory === undefined ? "New memory" : "Revise memory"} width="wide" onClose={onClose}>
      <form className="form-stack" onSubmit={submit}>
        {error !== undefined && <div className="evidence-note evidence-note--review" role="alert"><p>{error}</p>{memory !== undefined && onRefresh !== undefined && <button type="button" className="text-button" disabled={refreshPending} onClick={() => void refreshLatest()}>Review latest revision; keep my draft</button>}</div>}
        {refreshError !== undefined && <p className="field-error">{refreshError}</p>}
        {latest !== undefined && <section className="revision-conflict"><strong>Latest revision {latest.revision}</strong><pre className="evidence-preview">{latest.summary}{"\n"}{memoryContent(latest)}</pre><p className="evidence-note">Your draft below is unchanged. Review the current content before applying your correction.</p><button className="button button--secondary" type="button" disabled={draft.expectedRevision === latest.revision} onClick={() => setDraft({ ...draft, expectedRevision: latest.revision })}>Apply my draft to revision {latest.revision}</button></section>}
        {draft.expectedRevision !== undefined && <p className="evidence-note">This correction targets revision {draft.expectedRevision}.</p>}
        <div className="form-grid">
          <label className="field">
            <span>Audience</span>
            <select
              value={draft.audience}
              onChange={(event) => setDraft({ ...draft, audience: event.target.value as MemoryDraft["audience"] })}
              disabled={memory !== undefined}
            >
              <option value="personal">Personal</option>
              <option value="workspace">Workspace</option>
            </select>
          </label>
          <label className="field">
            <span>Source</span>
            <input
              value={draft.source}
              onChange={(event) => setDraft({ ...draft, source: event.target.value })}
              maxLength={200}
              required
            />
          </label>
          <label className="field">
            <span>Space</span>
            <input
              value={draft.spaceId ?? ""}
              onChange={(event) =>
                setDraft({ ...draft, ...(event.target.value ? { spaceId: event.target.value } : { spaceId: undefined }) })
              }
              disabled={memory !== undefined}
              placeholder="Workspace memory"
            />
          </label>
        </div>
        <label className="field"><span>Applies to</span><select value={draft.applicability?.kind ?? "unresolved"} onChange={(event) => setDraft({ ...draft, applicability: event.target.value === "projects" ? { kind: "projects", projectIds: [] } : { kind: event.target.value as "global" | "unresolved" } })}>
          <option value="unresolved">Needs project review</option><option value="projects">Specific projects</option><option value="global">All projects (explicit)</option>
        </select><small>Unresolved memories stay out of ordinary recall until their applicability is reviewed.</small></label>
        {draft.applicability?.kind === "projects" && <label className="field">
          <span>Projects</span>
          <input
            value={projects}
            onChange={(event) => setProjects(event.target.value)}
            placeholder="Project IDs, comma separated"
          />
        </label>}
        <label className="field">
          <span>Summary</span>
          <input
            value={draft.summary}
            onChange={(event) => setDraft({ ...draft, summary: event.target.value })}
            maxLength={500}
            autoFocus
          />
        </label>
        <label className="field field--format">
          <span>Content format</span>
          <select value={contentMode} onChange={(event) => { setContentMode(event.target.value as "text" | "json"); setContentError(undefined); }}>
            <option value="text">Text</option>
            <option value="json">JSON</option>
          </select>
        </label>
        <label className="field">
          <span>Content</span>
          <textarea
            value={contentText}
            onChange={(event) => { setContentText(event.target.value); setContentError(undefined); }}
            rows={9}
            aria-invalid={contentError !== undefined}
            aria-describedby={contentError === undefined ? undefined : "memory-content-error"}
          />
          {contentError !== undefined && <small className="field-error" id="memory-content-error">{contentError}</small>}
        </label>
        <label className="field">
          <span>Tags</span>
          <input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="decision, project" />
        </label>
        <footer className="modal__actions">
          <button className="button button--secondary" type="button" onClick={onClose} disabled={pending}>
            Cancel
          </button>
          <button className="button button--primary" type="submit" disabled={pending || !draft.source.trim() || (draft.applicability?.kind === "projects" && !projects.trim())}>
            <Save aria-hidden="true" />
            {pending ? "Saving" : "Save memory"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
