import { Play } from "lucide-react";
import { useEffect, useState } from "react";

import type { FleetSimulationDraft, FleetSimulationScenario } from "../types";
import { Modal } from "./Modal";

export function FleetSimulationDialog({
  open,
  pending,
  onClose,
  onSimulate,
}: {
  readonly open: boolean;
  readonly pending: boolean;
  readonly onClose: () => void;
  readonly onSimulate: (draft: FleetSimulationDraft) => Promise<void>;
}) {
  const [scenario, setScenario] = useState<FleetSimulationScenario>("active");
  const [agentId, setAgentId] = useState("sim-agent");
  const [taskId, setTaskId] = useState("local-fleet-check");
  const [repo, setRepo] = useState("super-brain");
  const [branch, setBranch] = useState("main");
  const [spaceId, setSpaceId] = useState("");
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open) setError(undefined);
  }, [open]);

  const submit = async () => {
    if (![agentId, taskId, repo, branch].every((value) => value.trim())) return;
    try {
      setError(undefined);
      await onSimulate({
        scenario,
        agentId: agentId.trim(),
        taskId: taskId.trim(),
        repo: repo.trim(),
        branch: branch.trim(),
        ...(spaceId.trim() ? { spaceId: spaceId.trim() } : {}),
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Fleet simulation failed");
    }
  };

  const valid = [agentId, taskId, repo, branch].every((value) => value.trim());

  return (
    <Modal open={open} title="Simulate fleet session" onClose={onClose}>
      <div className="form-stack">
        <label className="field">
          <span>Scenario</span>
          <select value={scenario} onChange={(event) => setScenario(event.target.value as FleetSimulationScenario)} autoFocus>
            <option value="active">Active</option>
            <option value="blocked">Blocked</option>
            <option value="degraded">Degraded sensor</option>
            <option value="orphaned">Orphaned</option>
            <option value="stopped">Stopped</option>
          </select>
        </label>
        <div className="form-grid">
          <label className="field"><span>Agent</span><input value={agentId} onChange={(event) => setAgentId(event.target.value)} /></label>
          <label className="field"><span>Task</span><input value={taskId} onChange={(event) => setTaskId(event.target.value)} /></label>
          <label className="field"><span>Repository</span><input value={repo} onChange={(event) => setRepo(event.target.value)} /></label>
          <label className="field"><span>Branch</span><input value={branch} onChange={(event) => setBranch(event.target.value)} /></label>
        </div>
        <label className="field"><span>Space (optional)</span><input value={spaceId} onChange={(event) => setSpaceId(event.target.value)} placeholder="space-id" /></label>
        {error !== undefined && <span className="field-error" role="alert">{error}</span>}
        <footer className="modal__actions">
          <button className="button button--secondary" type="button" onClick={onClose} disabled={pending}>Cancel</button>
          <button className="button button--primary" type="button" onClick={() => void submit()} disabled={pending || !valid}><Play aria-hidden="true" />{pending ? "Running" : "Run"}</button>
        </footer>
      </div>
    </Modal>
  );
}
