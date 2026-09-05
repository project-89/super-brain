import { readBoundedPrivateText } from "./storage.js";
import type { CaptureConfig } from "./types.js";

const states = ["pending", "waiting", "retry", "completed", "excluded", "exhausted"] as const;
type Counts = Record<(typeof states)[number], number>;
export type ProcessingStatus = { readonly available: false; readonly reason: "not-configured" | "missing-or-invalid" | "wrong-workspace" | "stale" | "stopped"; readonly observedAt?: string } | {
  readonly available: true; readonly version: 1; readonly observedAt: string; readonly status: "running";
  readonly coverage: Counts & { readonly oldestPendingAt?: number; readonly byKind: Readonly<Record<string, number>> };
  readonly lagMs?: number;
};
function record(value: unknown): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("Invalid processing status"); return value as Record<string, unknown>; }
function counts(value: unknown): Counts {
  const source = record(value);
  return Object.fromEntries(states.map((state) => { const count = source[state]; if (!Number.isSafeInteger(count) || (count as number) < 0) throw new TypeError("Invalid processing count"); return [state, count]; })) as Counts;
}
function timestamp(value: unknown): string { if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new TypeError("Invalid processing timestamp"); return new Date(value).toISOString(); }

/** Only a configured, bounded, owner-only local publication is eligible. Never return private payloads. */
export async function readProcessingStatus(config: Pick<CaptureConfig, "organizationId" | "workspaceId" | "processingStatusFile">, now = Date.now()): Promise<ProcessingStatus> {
  if (config.processingStatusFile === undefined) return { available: false, reason: "not-configured" };
  try {
    const source = record(JSON.parse(await readBoundedPrivateText(config.processingStatusFile, 64 * 1024, { requireOwnerOnly: true })));
    const subject = record(source.subject);
    if (subject.organizationId !== config.organizationId || subject.workspaceId !== config.workspaceId || typeof subject.principalId !== "string" || subject.principalId.length === 0) return { available: false, reason: "wrong-workspace" };
    if (source.version !== 1 || !["running", "stopped"].includes(String(source.status))) throw new TypeError("Invalid processing version");
    const observedAt = timestamp(source.observedAt);
    if (Date.parse(observedAt) > now + 5_000 || now - Date.parse(observedAt) > 60_000) return { available: false, reason: "stale", observedAt };
    if (source.status === "stopped") return { available: false, reason: "stopped", observedAt };
    const coverage = record(source.coverage);
    const sourceKinds = record(coverage.byKind);
    const allowedKinds = new Set(["extract-run", "extract-turn", "propose", "verify-trajectory", "cognition-plan", "synthesis"]);
    const byKind: Record<string, number> = {};
    for (const [kind, value] of Object.entries(sourceKinds)) { if (!allowedKinds.has(kind)) continue; if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError("Invalid processing kind count"); byKind[kind] = value as number; }
    const oldestPendingAt = coverage.oldestPendingAt as number | undefined;
    if (oldestPendingAt !== undefined && (!Number.isSafeInteger(oldestPendingAt) || oldestPendingAt < 0 || oldestPendingAt > now + 5_000)) throw new TypeError("Invalid pending time");
    const lagMs = source.lagMs;
    if (lagMs !== undefined && (!Number.isSafeInteger(lagMs) || (lagMs as number) < 0)) throw new TypeError("Invalid processing lag");
    return { available: true, version: 1, status: "running", observedAt, coverage: { ...counts(coverage), byKind, ...(oldestPendingAt === undefined ? {} : { oldestPendingAt }) }, ...(lagMs === undefined ? {} : { lagMs: lagMs as number }) };
  } catch { return { available: false, reason: "missing-or-invalid" }; }
}
