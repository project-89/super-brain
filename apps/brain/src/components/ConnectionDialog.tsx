import { Eye, EyeOff, PlugZap, RefreshCw, ShieldCheck } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";

import type { CapturePolicySettings, ConnectionSettings } from "../types";
import { localCaptureRequest } from "../local-capture";
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
  const [showCaptureToken, setShowCaptureToken] = useState(false);
  const [capturePolicy, setCapturePolicy] = useState<CapturePolicySettings>();
  const [capturePending, setCapturePending] = useState(false);
  const [captureError, setCaptureError] = useState<string>();

  useEffect(() => {
    setDraft(connection);
    setCapturePolicy(undefined);
    setCaptureError(undefined);
  }, [connection, open]);

  const captureRequest = async (method: "GET" | "PATCH", body?: CapturePolicySettings) => {
    if (!draft.captureBaseUrl.trim() || !draft.captureOperatorToken.trim()) {
      throw new Error("Capture URL and operator token are required");
    }
    const result = await localCaptureRequest<{ readonly policy?: CapturePolicySettings }>(draft, "/settings", { method, ...(body === undefined ? {} : { body }) });
    if (result.policy === undefined) throw new Error("Capture settings are unavailable");
    return result.policy;
  };

  const loadCapturePolicy = async () => {
    setCapturePending(true);
    setCaptureError(undefined);
    try {
      setCapturePolicy(await captureRequest("GET"));
    } catch (error) {
      setCaptureError(error instanceof Error ? error.message : "Capture settings unavailable");
    } finally {
      setCapturePending(false);
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft.organizationId.trim() || !draft.workspaceId.trim() || !draft.token.trim()) return;
    setCapturePending(true);
    setCaptureError(undefined);
    try {
      if (capturePolicy !== undefined) await captureRequest("PATCH", capturePolicy);
      onSave(draft);
    } catch (error) {
      setCaptureError(error instanceof Error ? error.message : "Settings update failed");
    } finally {
      setCapturePending(false);
    }
  };

  return (
    <Modal open={open} title="Workspace settings" width="wide" onClose={required ? () => undefined : onClose}>
      <form className="form-stack" onSubmit={(event) => void submit(event)}>
        <div className="settings-section-title"><PlugZap aria-hidden="true" /><span>Data service</span></div>
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
          <span>Organization</span>
          <input
            value={draft.organizationId}
            onChange={(event) => setDraft({ ...draft, organizationId: event.target.value })}
            placeholder="local"
            autoComplete="organization"
            required
          />
        </label>
        <label className="field">
          <span>Workspace</span>
          <input
            value={draft.workspaceId}
            onChange={(event) => setDraft({ ...draft, workspaceId: event.target.value })}
            placeholder="local"
            autoComplete="off"
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
        <div className="settings-section-title"><ShieldCheck aria-hidden="true" /><span>Local capture</span></div>
        <div className="form-grid">
          <label className="field">
            <span>Capture base URL</span>
            <input
              value={draft.captureBaseUrl}
              onChange={(event) => {
                setDraft({ ...draft, captureBaseUrl: event.target.value });
                setCapturePolicy(undefined);
              }}
              placeholder="/capture"
              autoComplete="url"
            />
          </label>
          <label className="field">
            <span>Operator token</span>
            <span className="input-with-action">
              <input
                value={draft.captureOperatorToken}
                onChange={(event) => {
                  setDraft({ ...draft, captureOperatorToken: event.target.value });
                  setCapturePolicy(undefined);
                }}
                type={showCaptureToken ? "text" : "password"}
                autoComplete="off"
              />
              <button
                className="icon-button icon-button--inside"
                type="button"
                onClick={() => setShowCaptureToken((current) => !current)}
                aria-label={showCaptureToken ? "Hide capture token" : "Show capture token"}
                title={showCaptureToken ? "Hide capture token" : "Show capture token"}
              >
                {showCaptureToken ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
              </button>
            </span>
          </label>
        </div>
        <button
          className="button button--secondary settings-load"
          type="button"
          onClick={() => void loadCapturePolicy()}
          disabled={capturePending || !draft.captureBaseUrl.trim() || !draft.captureOperatorToken.trim()}
        >
          <RefreshCw aria-hidden="true" />{capturePending ? "Loading" : "Load capture policy"}
        </button>
        {captureError !== undefined && <span className="field-error" role="alert">{captureError}</span>}
        {capturePolicy !== undefined && (
          <div className="capture-policy-grid">
            <label className="field">
              <span>Exposed reasoning</span>
              <select
                value={capturePolicy.reasoningPolicy}
                onChange={(event) => {
                  const include = event.target.value === "include";
                  setCapturePolicy({
                    ...capturePolicy,
                    reasoningPolicy: include ? "include" : "exclude",
                    ...(!include ? { reasoningTreePolicy: "exclude", retainEncryptedReasoning: false } : {}),
                  });
                }}
              >
                <option value="exclude">Exclude</option>
                <option value="include">Include</option>
              </select>
            </label>
            <label className="field">
              <span>Reasoning trees</span>
              <select
                value={capturePolicy.reasoningTreePolicy}
                disabled={capturePolicy.reasoningPolicy === "exclude"}
                onChange={(event) => setCapturePolicy({
                  ...capturePolicy,
                  reasoningTreePolicy: event.target.value as CapturePolicySettings["reasoningTreePolicy"],
                })}
              >
                <option value="exclude">Exclude</option>
                <option value="summaries">Include summaries</option>
              </select>
            </label>
            <label className="field">
              <span>Anonymization</span>
              <select
                value={capturePolicy.anonymizationPolicy}
                onChange={(event) => setCapturePolicy({
                  ...capturePolicy,
                  anonymizationPolicy: event.target.value as CapturePolicySettings["anonymizationPolicy"],
                })}
              >
                <option value="none">None</option>
                <option value="pseudonymous">Pseudonymous</option>
                <option value="strict">Strict</option>
              </select>
            </label>
            <label className="field">
              <span>Tree interval</span>
              <input
                type="number"
                min="0"
                max="10000"
                value={capturePolicy.treeSnapshotEveryEvents}
                onChange={(event) => setCapturePolicy({
                  ...capturePolicy,
                  treeSnapshotEveryEvents: Number(event.target.value),
                })}
              />
            </label>
            <label className="settings-toggle">
              <input
                type="checkbox"
                checked={capturePolicy.retainEncryptedReasoning}
                disabled={capturePolicy.reasoningPolicy === "exclude"}
                onChange={(event) => setCapturePolicy({
                  ...capturePolicy,
                  retainEncryptedReasoning: event.target.checked,
                })}
              />
              <span>Retain opaque reasoning</span>
            </label>
          </div>
        )}
        <footer className="modal__actions">
          {!required && (
            <button className="button button--secondary" type="button" onClick={onClose}>
              Cancel
            </button>
          )}
          <button className="button button--primary" type="submit" disabled={capturePending}>
            <PlugZap aria-hidden="true" />
            {capturePending ? "Saving" : "Save"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
