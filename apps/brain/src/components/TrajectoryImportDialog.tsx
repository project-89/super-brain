import { FileUp, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { TrajectoryImportBundle } from "../types";
import { Modal } from "./Modal";

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseBundle(source: string): TrajectoryImportBundle {
  const parsed: unknown = JSON.parse(source);
  if (!isObject(parsed) || !isObject(parsed.tree) || !Array.isArray(parsed.trajectories)) {
    throw new TypeError("Bundle must contain a tree and trajectories array");
  }
  if (typeof parsed.tree.taskId !== "string" || !parsed.tree.taskId.trim()) {
    throw new TypeError("Tree taskId is required");
  }
  if (parsed.trajectories.length === 0) {
    throw new TypeError("Bundle must contain at least one trajectory");
  }
  for (const trajectory of parsed.trajectories) {
    if (!isObject(trajectory) || trajectory.taskId !== parsed.tree.taskId) {
      throw new TypeError("Every trajectory must reference the tree taskId");
    }
  }
  return parsed as unknown as TrajectoryImportBundle;
}

export function TrajectoryImportDialog({
  open,
  pending,
  onClose,
  onImport,
}: {
  readonly open: boolean;
  readonly pending: boolean;
  readonly onClose: () => void;
  readonly onImport: (bundle: TrajectoryImportBundle) => Promise<void>;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [source, setSource] = useState("");
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open) {
      setSource("");
      setError(undefined);
    }
  }, [open]);

  const readFile = async (file: File | undefined) => {
    if (file === undefined) return;
    try {
      setSource(await file.text());
      setError(undefined);
    } catch {
      setError("Unable to read JSON file");
    }
  };

  const submit = async () => {
    try {
      setError(undefined);
      await onImport(parseBundle(source));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Trajectory import failed");
    }
  };

  return (
    <Modal open={open} title="Import trajectories" width="wide" onClose={onClose}>
      <div className="form-stack">
        <input
          ref={input}
          className="sr-only"
          type="file"
          accept="application/json,.json"
          onChange={(event) => void readFile(event.target.files?.[0])}
        />
        <div className="import-source-header">
          <span>Trajectory bundle</span>
          <button className="button button--secondary" type="button" onClick={() => input.current?.click()} disabled={pending}>
            <FileUp aria-hidden="true" />Choose JSON
          </button>
        </div>
        <label className="field">
          <span>Bundle JSON</span>
          <textarea
            className="trajectory-import-source"
            value={source}
            onChange={(event) => setSource(event.target.value)}
            placeholder={'{"tree":{"taskId":"..."},"trajectories":[...]}' }
            spellCheck={false}
            autoFocus
          />
        </label>
        {error !== undefined && <span className="field-error" role="alert">{error}</span>}
        <footer className="modal__actions">
          <button className="button button--secondary" type="button" onClick={onClose} disabled={pending}>Cancel</button>
          <button className="button button--primary" type="button" onClick={() => void submit()} disabled={pending || !source.trim()}>
            <Upload aria-hidden="true" />{pending ? "Importing" : "Import"}
          </button>
        </footer>
      </div>
    </Modal>
  );
}
