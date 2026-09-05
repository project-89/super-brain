import { atomicPrivateText } from "@_89/super-brain-capture-daemon";
import type { ProcessingCoverage } from "./jobs.js";

export interface WorkerProcessingStatus {
  readonly version: 1;
  readonly observedAt: string;
  readonly status: "running" | "stopped";
  readonly subject: { readonly organizationId: string; readonly workspaceId: string; readonly principalId: string };
  readonly coverage: ProcessingCoverage;
  readonly lagMs?: number;
}
/** Only sanitized aggregates leave the encrypted job store; the operator bridge decides freshness/access. */
export async function publishWorkerProcessingStatus(path: string, input: WorkerProcessingStatus): Promise<void> {
  const count = (value: number) => { if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("invalid processing count"); return value; };
  const { pending, waiting, retry, completed, excluded, exhausted, oldestPendingAt, byKind } = input.coverage;
  const observedAt = new Date(input.observedAt).toISOString();
  const payload: WorkerProcessingStatus = {
    version: 1, observedAt, status: input.status,
    subject: { organizationId: input.subject.organizationId, workspaceId: input.subject.workspaceId, principalId: input.subject.principalId },
    coverage: { pending: count(pending), waiting: count(waiting), retry: count(retry), completed: count(completed), excluded: count(excluded), exhausted: count(exhausted),
      ...(oldestPendingAt === undefined ? {} : { oldestPendingAt: count(oldestPendingAt) }),
      byKind: { "extract-run": count(byKind["extract-run"]), "extract-turn": count(byKind["extract-turn"]), propose: count(byKind.propose),
        "verify-trajectory": count(byKind["verify-trajectory"]), "cognition-plan": count(byKind["cognition-plan"]), synthesis: count(byKind.synthesis) },
    },
    ...(oldestPendingAt === undefined ? {} : { lagMs: Math.max(0, Date.parse(observedAt) - oldestPendingAt) }),
  };
  await atomicPrivateText(path, JSON.stringify(payload));
}
