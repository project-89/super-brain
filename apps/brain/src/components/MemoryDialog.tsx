import { Save } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";

import { memoryContent } from "../format";
import type { JsonValue, MemoryDraft, PersonalMemory } from "../types";
import { Modal } from "./Modal";

const EMPTY_DRAFT: MemoryDraft = {
  source: "conversation",
  summary: "",
  content: "",
  tags: [],
};

interface MemoryDialogProps {
  readonly memory?: PersonalMemory;
  readonly open: boolean;
  readonly pending: boolean;
  readonly onClose: () => void;
  readonly onSave: (draft: MemoryDraft) => Promise<void>;
}

export function MemoryDialog({ memory, open, pending, onClose, onSave }: MemoryDialogProps) {
  const [draft, setDraft] = useState<MemoryDraft>(EMPTY_DRAFT);
  const [tags, setTags] = useState("");
  const [contentText, setContentText] = useState("");
  const [contentMode, setContentMode] = useState<"text" | "json">("text");
  const [contentError, setContentError] = useState<string>();

  useEffect(() => {
    const next = memory === undefined
      ? EMPTY_DRAFT
      : {
          source: memory.source,
          summary: memory.summary,
          content: memoryContent(memory),
          tags: memory.tags,
          ...(memory.spaceId === undefined ? {} : { spaceId: memory.spaceId }),
        };
    setDraft(next);
    setTags(next.tags.join(", "));
    setContentText(next.content as string);
    setContentMode(memory !== undefined && typeof memory.content !== "string" ? "json" : "text");
    setContentError(undefined);
  }, [memory, open]);

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
    void onSave({ ...draft, content, tags: [...new Set(parsedTags)] });
  };

  return (
    <Modal open={open} title={memory === undefined ? "New memory" : "Revise memory"} width="wide" onClose={onClose}>
      <form className="form-stack" onSubmit={submit}>
        <div className="form-grid">
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
          <button className="button button--primary" type="submit" disabled={pending || !draft.source.trim()}>
            <Save aria-hidden="true" />
            {pending ? "Saving" : "Save memory"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
