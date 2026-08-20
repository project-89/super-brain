import { Eye, EyeOff, PlugZap } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";

import type { ConnectionSettings } from "../types";
import { Modal } from "./Modal";

interface ConnectionDialogProps {
  readonly connection: ConnectionSettings;
  readonly open: boolean;
  readonly required: boolean;
  readonly onClose: () => void;
  readonly onSave: (settings: ConnectionSettings) => void;
}

export function ConnectionDialog({ connection, open, required, onClose, onSave }: ConnectionDialogProps) {
  const [draft, setDraft] = useState(connection);
  const [showToken, setShowToken] = useState(false);

  useEffect(() => setDraft(connection), [connection, open]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!draft.workspaceId.trim() || !draft.token.trim()) return;
    onSave(draft);
  };

  return (
    <Modal open={open} title="Connect workspace" onClose={required ? () => undefined : onClose}>
      <form className="form-stack" onSubmit={submit}>
        <label className="field">
          <span>API base URL</span>
          <input
            value={draft.baseUrl}
            onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
            placeholder="/api"
            autoComplete="url"
          />
        </label>
        <label className="field">
          <span>Workspace</span>
          <input
            value={draft.workspaceId}
            onChange={(event) => setDraft({ ...draft, workspaceId: event.target.value })}
            placeholder="local"
            autoComplete="organization"
            required
          />
        </label>
        <label className="field">
          <span>Bearer token</span>
          <span className="input-with-action">
            <input
              value={draft.token}
              onChange={(event) => setDraft({ ...draft, token: event.target.value })}
              type={showToken ? "text" : "password"}
              autoComplete="current-password"
              required
            />
            <button
              className="icon-button icon-button--inside"
              type="button"
              onClick={() => setShowToken((current) => !current)}
              aria-label={showToken ? "Hide token" : "Show token"}
              title={showToken ? "Hide token" : "Show token"}
            >
              {showToken ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
            </button>
          </span>
        </label>
        <footer className="modal__actions">
          {!required && (
            <button className="button button--secondary" type="button" onClick={onClose}>
              Cancel
            </button>
          )}
          <button className="button button--primary" type="submit">
            <PlugZap aria-hidden="true" />
            Connect
          </button>
        </footer>
      </form>
    </Modal>
  );
}
