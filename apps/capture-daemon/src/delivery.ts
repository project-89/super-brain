import { stat } from "node:fs/promises";

import { SuperBrainApiError, SuperBrainClient } from "@_89/super-brain-client";
import { mergeSharedDecisionTrees } from "@_89/fold-trace";
import {
  deliverTranscriptBundle,
  parseClaudeTranscript,
  parseCodexTranscript,
  storeRedactedArtifact,
  RecordAnonymizer,
  TranscriptDeliveryError,
} from "@_89/super-brain-importer";

import { DurableSpool } from "./storage.js";
import type { CaptureConfig, SpoolJob } from "./types.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function permanentApiError(error: unknown): boolean {
  if (error instanceof SuperBrainApiError) return error.status >= 400 && error.status < 500 && error.status !== 429;
  if (error instanceof TranscriptDeliveryError && error.status !== undefined) {
    return error.status >= 400 && error.status < 500 && error.status !== 429;
  }
  return false;
}

export class SpoolProcessor {
  private readonly client: SuperBrainClient;
  private timer: NodeJS.Timeout | undefined;
  private processing: Promise<void> | undefined;
  private readonly retryAt = new Map<string, number>();

  constructor(
    private readonly config: CaptureConfig,
    private readonly spool: DurableSpool,
    private readonly vaultEncryptionKey?: Uint8Array,
    private readonly anonymizer = new RecordAnonymizer("none"),
  ) {
    this.client = new SuperBrainClient({
      baseUrl: config.apiUrl,
      workspaceId: config.workspaceId,
      token: config.apiToken,
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
    this.processing = this.processPending().finally(() => { this.processing = undefined; });
    return this.processing;
  }

  private async deliver(job: SpoolJob): Promise<void> {
    if (job.kind === "event") {
      await this.client.appendEvent(job.event);
      return;
    }
    if (job.kind === "trajectory" || job.kind === "trajectory-tree") {
      const options = { captureIdentity: job.captureIdentity };
      const existing = (await this.client.trajectoryTasks()).find(({ taskId }) => taskId === job.tree.taskId);
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
      workspaceId: this.config.workspaceId,
      bearerToken: this.config.apiToken,
      maxAttempts: 1,
    });
  }

  private async processPending(): Promise<void> {
    const pending = await this.spool.list();
    for (const { path, job } of pending) {
      if (job.kind === "transcript" && Date.parse(job.notBefore) > Date.now()) continue;
      if ((this.retryAt.get(path) ?? 0) > Date.now()) continue;
      try {
        await this.deliver(job);
        this.retryAt.delete(path);
        await this.spool.complete(path);
      } catch (error) {
        const expiredTranscript = job.kind === "transcript" && Date.parse(job.deadlineAt) <= Date.now();
        const unsupportedTranscript = job.kind === "transcript" && !["claude-code", "codex"].includes(job.source);
        if (permanentApiError(error) || expiredTranscript || unsupportedTranscript) {
          await this.spool.reject(path, errorMessage(error));
          continue;
        }
        if (job.kind === "transcript") {
          this.retryAt.set(path, Date.now() + 5_000);
          continue;
        }
        break;
      }
    }
  }
}
