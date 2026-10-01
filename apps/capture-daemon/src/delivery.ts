import { stat } from "node:fs/promises";
import { createHash } from "node:crypto";

import { SuperBrainApiError, SuperBrainClient } from "@_89/super-brain-client";
import { mergeSharedDecisionTrees, ProjectionValidationError } from "@_89/fold-trace";
import {
  deliverTranscriptBundle,
  parseClaudeTranscript,
  parseCodexTranscript,
  storeRedactedArtifact,
  RecordAnonymizer,
  TranscriptDeliveryError,
} from "@_89/super-brain-importer";

import { DurableSpool, TranscriptSnapshotStore } from "./storage.js";
import type { CaptureConfig, SpoolJob } from "./types.js";

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_TRANSIENT_BACKOFF_MS = 5_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function permanentApiError(error: unknown): boolean {
  if (error instanceof ProjectionValidationError) return true;
  if (error instanceof SuperBrainApiError) return error.status >= 400 && error.status < 500 && error.status !== 429;
  if (error instanceof TranscriptDeliveryError && error.status !== undefined) {
    return error.status >= 400 && error.status < 500 && error.status !== 429;
  }
  return false;
}

function transientLocalTranscriptError(error: unknown): boolean {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
  return error instanceof Error && error.message.includes("changed while");
}

interface DeliveryJobMetadata {
  readonly fingerprint: string;
  readonly kind: SpoolJob["kind"];
  readonly createdAt?: string;
}

export interface DeliverySnapshot {
  readonly status: "idle" | "processing" | "retrying";
  readonly countersSinceStart: { readonly attempted: number; readonly delivered: number; readonly failures: number };
  readonly lastAttemptAt?: string;
  readonly lastDeliveredAt?: string;
  readonly currentJob?: DeliveryJobMetadata;
  readonly blockedJob?: DeliveryJobMetadata;
  readonly nextRetryAt?: string;
  readonly lastFailure?: {
    readonly at: string;
    readonly category: "stack_overflow" | "api_error" | "validation_error" | "missing_file" | "timeout" | "delivery_error";
    readonly stage: "queue" | "delivery";
    readonly disposition: "retry" | "deferred" | "failed";
    readonly httpStatus?: number;
    readonly job?: DeliveryJobMetadata;
  };
}

function jobMetadata(job: SpoolJob): DeliveryJobMetadata {
  const createdAt = Date.parse(job.createdAt);
  return {
    fingerprint: createHash("sha256").update(job.id).digest("hex"),
    kind: job.kind,
    ...(Number.isFinite(createdAt) ? { createdAt: new Date(createdAt).toISOString() } : {}),
  };
}

function failureCategory(error: unknown): NonNullable<DeliverySnapshot["lastFailure"]>["category"] {
  if (error instanceof RangeError && error.message.includes("call stack")) return "stack_overflow";
  if (error instanceof SuperBrainApiError || error instanceof TranscriptDeliveryError) return "api_error";
  if (error instanceof ProjectionValidationError) return "validation_error";
  if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return "missing_file";
  if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) return "timeout";
  return "delivery_error";
}

export class SpoolProcessor {
  private readonly client: SuperBrainClient;
  private timer: NodeJS.Timeout | undefined;
  private processing: Promise<void> | undefined;
  private readonly retryAt = new Map<string, number>();
  private readonly snapshots: TranscriptSnapshotStore;
  private readonly batchSize: number;
  private readonly transientBackoffMs: number;
  private nextFlushAt = 0;
  private attempted = 0;
  private delivered = 0;
  private failures = 0;
  private lastAttemptAt: string | undefined;
  private lastDeliveredAt: string | undefined;
  private currentJob: DeliveryJobMetadata | undefined;
  private blockedJob: DeliveryJobMetadata | undefined;
  private lastFailure: DeliverySnapshot["lastFailure"];

  constructor(
    private readonly config: CaptureConfig,
    private readonly spool: DurableSpool,
    private readonly vaultEncryptionKey?: Uint8Array,
    private readonly anonymizer = new RecordAnonymizer("none"),
    options: {
      readonly fetch?: typeof fetch;
      readonly batchSize?: number;
      readonly transientBackoffMs?: number;
    } = {},
  ) {
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.transientBackoffMs = options.transientBackoffMs ?? DEFAULT_TRANSIENT_BACKOFF_MS;
    if (!Number.isInteger(this.batchSize) || this.batchSize < 1) {
      throw new TypeError("spool batch size must be a positive integer");
    }
    if (!Number.isFinite(this.transientBackoffMs) || this.transientBackoffMs < 0) {
      throw new TypeError("spool transient backoff cannot be negative");
    }
    this.client = new SuperBrainClient({
      baseUrl: config.apiUrl,
      organizationId: config.organizationId,
      workspaceId: config.workspaceId,
      token: config.apiToken,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
    this.snapshots = new TranscriptSnapshotStore(config.stateRoot, {
      reasoningPolicy: config.reasoningPolicy,
      retainEncryptedReasoning: config.retainEncryptedReasoning,
    });
  }

  start(intervalMs = 500): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => void this.flush().catch(() => undefined), intervalMs);
    this.timer.unref();
    void this.flush().catch(() => undefined);
  }

  async stop(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    await this.processing;
  }

  flush(): Promise<void> {
    if (this.processing !== undefined) return this.processing;
    this.processing = this.processPending().catch((error: unknown) => {
      this.nextFlushAt = Date.now() + this.transientBackoffMs;
      this.recordFailure(error, "queue", "retry");
      throw error;
    }).finally(() => { this.processing = undefined; this.currentJob = undefined; });
    return this.processing;
  }

  snapshot(): DeliverySnapshot {
    return {
      status: this.processing !== undefined ? "processing" : this.blockedJob !== undefined || this.nextFlushAt > Date.now() ? "retrying" : "idle",
      countersSinceStart: { attempted: this.attempted, delivered: this.delivered, failures: this.failures },
      ...(this.lastAttemptAt === undefined ? {} : { lastAttemptAt: this.lastAttemptAt }),
      ...(this.lastDeliveredAt === undefined ? {} : { lastDeliveredAt: this.lastDeliveredAt }),
      ...(this.currentJob === undefined ? {} : { currentJob: this.currentJob }),
      ...(this.blockedJob === undefined ? {} : { blockedJob: this.blockedJob }),
      ...(this.nextFlushAt <= Date.now() ? {} : { nextRetryAt: new Date(this.nextFlushAt).toISOString() }),
      ...(this.lastFailure === undefined ? {} : { lastFailure: this.lastFailure }),
    };
  }

  private recordFailure(
    error: unknown,
    stage: "queue" | "delivery",
    disposition: "retry" | "deferred" | "failed",
    job?: DeliveryJobMetadata,
  ): void {
    this.failures += 1;
    const status = error instanceof SuperBrainApiError || error instanceof TranscriptDeliveryError ? error.status : undefined;
    this.lastFailure = {
      at: new Date().toISOString(), category: failureCategory(error), stage, disposition,
      ...(Number.isInteger(status) && status! >= 100 && status! <= 599 ? { httpStatus: status! } : {}),
      ...(job === undefined ? {} : { job }),
    };
  }

  private async deliver(job: SpoolJob): Promise<void> {
    if (job.kind === "event") {
      await this.client.appendEvent(job.event);
      return;
    }
    if (job.kind === "trajectory" || job.kind === "trajectory-tree") {
      const options = { captureIdentity: job.captureIdentity };
      const existing = await this.client.trajectoryTree(job.tree.taskId);
      if (existing === undefined) {
        await this.client.recordTrajectoryTree(job.treeStamp, job.tree, options);
      } else {
        const merged = mergeSharedDecisionTrees(existing.tree, job.tree);
        if (JSON.stringify(merged) !== JSON.stringify(existing.tree)) {
          await this.client.recordTrajectoryTree(job.treeStamp, merged, options);
        }
      }
      if (job.kind === "trajectory") await this.client.recordTrajectory(job.runStamp, job.input, options);
      return;
    }
    await stat(job.path);
    const parsed = job.source === "claude-code"
      ? await parseClaudeTranscript(job.path)
      : job.source === "codex"
        ? await parseCodexTranscript(job.path)
        : undefined;
    if (parsed === undefined) throw new Error(`unsupported transcript source: ${job.source}`);
    const stored = await storeRedactedArtifact(parsed, this.config.vaultRoot, {
      reasoningPolicy: this.config.reasoningPolicy,
      retainEncryptedReasoning: this.config.retainEncryptedReasoning,
      anonymizer: this.anonymizer,
      ...(this.vaultEncryptionKey === undefined ? {} : { encryptionKey: this.vaultEncryptionKey }),
    });
    await deliverTranscriptBundle(stored.bundle, {
      apiUrl: this.config.apiUrl,
      organizationId: this.config.organizationId,
      workspaceId: this.config.workspaceId,
      bearerToken: this.config.apiToken,
      maxAttempts: 1,
    });
  }

  private async processPending(): Promise<void> {
    if (this.nextFlushAt > Date.now()) return;
    const pending = await this.spool.list();
    this.blockedJob = undefined;
    let attempted = 0;
    for (const entry of pending) {
      const { path } = entry;
      let { job } = entry;
      if (attempted >= this.batchSize) break;
      if (job.kind === "transcript" && Date.parse(job.notBefore) > Date.now()) continue;
      if ((this.retryAt.get(path) ?? 0) > Date.now()) continue;
      attempted += 1;
      this.attempted += 1;
      this.lastAttemptAt = new Date().toISOString();
      this.currentJob = jobMetadata(job);
      try {
        if (job.kind === "transcript" && job.ownedSnapshot !== true) {
          const snapshot = await this.snapshots.store(job.source, job.path, job.nativeSessionId);
          job = {
            ...job, path: snapshot, originalPath: job.originalPath ?? job.path, ownedSnapshot: true,
            deadlineAt: new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString(),
          };
          await this.spool.replacePending(path, job);
        }
        await this.deliver(job);
        if (job.kind === "transcript" && job.ownedSnapshot === true) {
          await this.snapshots.complete(job.path);
        }
        this.retryAt.delete(path);
        await this.spool.complete(path);
        this.delivered += 1;
        this.lastDeliveredAt = new Date().toISOString();
      } catch (error) {
        const expiredTranscript = job.kind === "transcript" && Date.parse(job.deadlineAt) <= Date.now();
        const unsupportedTranscript = job.kind === "transcript" && !["claude-code", "codex"].includes(job.source);
        if (permanentApiError(error) || expiredTranscript || unsupportedTranscript) {
          this.recordFailure(error, "delivery", "failed", this.currentJob);
          await this.spool.reject(path, errorMessage(error));
          continue;
        }
        if (job.kind === "transcript" && transientLocalTranscriptError(error)) {
          this.recordFailure(error, "delivery", "deferred", this.currentJob);
          this.retryAt.set(path, Date.now() + 5_000);
          continue;
        }
        this.nextFlushAt = Date.now() + this.transientBackoffMs;
        this.blockedJob = this.currentJob;
        this.recordFailure(error, "delivery", "retry", this.currentJob);
        break;
      }
    }
  }
}
