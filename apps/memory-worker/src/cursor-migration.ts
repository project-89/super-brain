import type { SuperBrainClient } from "@_89/super-brain-client";
import { DurableWorkerJobs } from "./jobs.js";
import { MEMORY_WORKER_EVENT_KINDS } from "./subscription.js";

export async function migrateWorkerCursor(options: {
  readonly client: Pick<SuperBrainClient, "ingestionConsumerStatus" | "migrateConsumerCursor">;
  readonly consumerId: string;
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly audience: "workspace" | "personal";
  /** The worker's job-ledger root and namespace; a confirmed change holds the same lease as the watcher. */
  readonly stateRoot: string;
  readonly namespace: string;
  readonly confirm?: boolean;
}) {
  const selection = { kinds: MEMORY_WORKER_EVENT_KINDS };
  const store = options.confirm === true
    ? new DurableWorkerJobs(options.stateRoot, options.namespace)
    : undefined;
  if (store !== undefined) await store.open();
  try {
    const status = options.confirm === true
      ? await options.client.migrateConsumerCursor(options.consumerId, selection)
      : await options.client.ingestionConsumerStatus(options.consumerId, selection);
    return {
      mode: options.confirm === true ? "apply" : "dry-run",
      scope: { organizationId: options.organizationId, workspaceId: options.workspaceId, audience: options.audience },
      consumerId: options.consumerId,
      kinds: MEMORY_WORKER_EVENT_KINDS,
      ...status,
      reachedSampledHead: status.cursor !== null && BigInt(status.cursor.sequence) >= BigInt(status.headCursor.sequence),
      replay: "Watcher resumes from ingestion cursor; this command does not enqueue or process events. Sequence distance is not an event count or completed-processing measure.",
    };
  } finally {
    if (store !== undefined) await store.close();
  }
}

export async function resetWorkerCursor(options: Omit<Parameters<typeof migrateWorkerCursor>[0], "client"> & {
  readonly client: Pick<SuperBrainClient, "ingestionConsumerStatus" | "resetConsumerCursor">;
  readonly expectedSequence: string;
  readonly reason: string;
}) {
  if (!/^(?:0|[1-9][0-9]{0,18})$/.test(options.expectedSequence) || BigInt(options.expectedSequence) > 9223372036854775807n) {
    throw new TypeError("--expected-sequence must be a decimal PostgreSQL BIGINT within [0, 9223372036854775807]");
  }
  const reason = options.reason.trim();
  if (reason.length < 10 || reason.length > 2_000) throw new TypeError("--reason must contain 10 to 2000 characters");
  const expectedCursor = { kind: "ingestion" as const, sequence: options.expectedSequence };
  const selection = { kinds: MEMORY_WORKER_EVENT_KINDS };
  const store = options.confirm === true
    ? new DurableWorkerJobs(options.stateRoot, options.namespace)
    : undefined;
  if (store !== undefined) await store.open();
  try {
    const status = options.confirm === true
      ? await options.client.resetConsumerCursor(options.consumerId, expectedCursor, reason, selection)
      : await options.client.ingestionConsumerStatus(options.consumerId, selection);
    return {
      mode: options.confirm === true ? "apply" : "dry-run",
      scope: { organizationId: options.organizationId, workspaceId: options.workspaceId, audience: options.audience },
      consumerId: options.consumerId,
      kinds: MEMORY_WORKER_EVENT_KINDS,
      ...status,
      requestedReset: { expectedCursor, targetCursor: { kind: "ingestion", sequence: "0" }, reason },
      ...(options.confirm === true ? {} : { expectedMatches: status.cursor?.sequence === expectedCursor.sequence }),
      replay: "Explicit audited reset only; existing jobs and receipts are preserved. Restart the same watcher to replay. Cursor progress is not completed extraction.",
    };
  } finally {
    if (store !== undefined) await store.close();
  }
}
