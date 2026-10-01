#!/usr/bin/env node
import { SuperBrainClient } from "@_89/super-brain-client";
import { readVaultKey } from "@_89/super-brain-importer";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { homedir } from "node:os";
import { createCapturedEventVerifier } from "./authority.js";
import { createCapturedTrajectoryVerifier } from "@_89/super-brain-capture-daemon";
import { readFile } from "node:fs/promises";
import { workerJobNamespace } from "./jobs.js";
import { migrateWorkerCursor, resetWorkerCursor } from "./cursor-migration.js";

import { installMemoryWorkerLaunchAgent } from "./install.js";
import { TranscriptMemoryWorker } from "./worker.js";
import type { ExtractedCandidate } from "./types.js";

const args = process.argv.slice(2).filter((argument) => argument !== "--");

function option(name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new TypeError(`${name} requires a value`);
  return value;
}

function required(value: string | undefined, label: string): string {
  if (value === undefined || value.trim().length === 0) throw new TypeError(`${label} is required`);
  return value;
}

async function main(): Promise<void> {
  const command = args[0] ?? "scan";
  if (command === "install-service") {
    const path = await installMemoryWorkerLaunchAgent(fileURLToPath(import.meta.url), {
      consumerId: option("--consumer") ?? "transcript-memory-extractor-v1",
      autoPromote: !args.includes("--no-auto-promote"),
      replayAll: args.includes("--replay-all"),
    });
    process.stdout.write(`${path}\n`);
    return;
  }
  const commands = ["scan", "backfill", "queue-backfill", "queue-episodes", "watch", "retry", "retry-jobs", "jobs", "repair-evidence", "migrate-cursor", "reset-cursor"];
  if (!commands.includes(command)) {
    throw new TypeError(`supported commands: ${commands.join(", ")}, install-service`);
  }
  if (command === "backfill" && !args.includes("--confirm")) {
    throw new TypeError("backfill requires --confirm; run scan first to review counts");
  }
  const baseUrl = required(option("--api-url") ?? process.env.SUPER_BRAIN_URL ?? process.env.FOLD_API_URL, "SUPER_BRAIN_URL");
  const organizationId = option("--organization") ?? process.env.SUPER_BRAIN_ORGANIZATION ?? process.env.FOLD_API_ORGANIZATION ?? "local";
  const workspaceId = required(option("--workspace") ?? process.env.SUPER_BRAIN_WORKSPACE ?? process.env.FOLD_API_WORKSPACE, "SUPER_BRAIN_WORKSPACE");
  const token = required(process.env.SUPER_BRAIN_TOKEN ?? process.env.FOLD_API_TOKEN, "SUPER_BRAIN_TOKEN");
  const client = new SuperBrainClient({ baseUrl, organizationId, workspaceId, token });
  const consumerId = option("--consumer") ?? "transcript-memory-extractor-v1";
  const stateRoot = option("--state-root") ?? option("--processing-root") ?? process.env.SUPER_BRAIN_WORKER_STATE_ROOT ?? process.env.FOLD_MEMORY_PROCESSING_ROOT;
  const resolvedStateRoot = stateRoot ?? join(homedir(), ".local", "state", "super-brain", "memory-worker", "jobs");
  const spaceId = option("--space") ?? process.env.SUPER_BRAIN_WORKER_SPACE;
  const audience = option("--audience") ?? "workspace";
  if (audience !== "personal" && audience !== "workspace") throw new TypeError("--audience must be personal or workspace");
  if (command === "migrate-cursor" || command === "reset-cursor") {
    // Confirmed cursor changes hold the watcher's own ledger lease, so they fail while it runs.
    const namespace = workerJobNamespace(await client.identity(), { audience, ...(spaceId === undefined ? {} : { spaceId }) });
    const common = { client, consumerId, organizationId, workspaceId, audience, stateRoot: resolvedStateRoot, namespace, confirm: args.includes("--confirm") } as const;
    const result = command === "migrate-cursor" ? await migrateWorkerCursor(common) : await resetWorkerCursor({ ...common,
      expectedSequence: required(option("--expected-sequence"), "--expected-sequence"), reason: required(option("--reason"), "--reason") });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const localOnly = ["queue-backfill", "queue-episodes", "jobs", "retry-jobs", "repair-evidence"].includes(command);
  const vaultRoot = localOnly ? option("--vault") ?? process.env.FOLD_TRANSCRIPT_VAULT ?? "" : required(option("--vault") ?? process.env.FOLD_TRANSCRIPT_VAULT, "FOLD_TRANSCRIPT_VAULT");
  const vaultKeyPath = option("--vault-key") ?? process.env.FOLD_TRANSCRIPT_VAULT_KEY_FILE;
  const vaultEncryptionKey = vaultKeyPath === undefined || localOnly ? undefined : await readVaultKey(vaultKeyPath);
  const maxValue = option("--max-per-run");
  const maxCandidatesPerRun = maxValue === undefined ? 25 : Number(maxValue);
  if (!Number.isInteger(maxCandidatesPerRun) || maxCandidatesPerRun < 1 || maxCandidatesPerRun > 500) throw new TypeError("--max-per-run must be a dispatch budget within [1, 500]");
  const limitValue = option("--limit");
  const limit = limitValue === undefined ? undefined : Number(limitValue);
  const sampleValue = option("--sample");
  const sample = sampleValue === undefined ? 0 : Number(sampleValue);
  const cognitionEveryValue = option("--cognition-every");
  const cognitionEveryEvents = cognitionEveryValue === undefined ? 25 : Number(cognitionEveryValue);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new TypeError("--limit must be a positive integer");
  if (!Number.isInteger(sample) || sample < 0 || sample > 100) throw new TypeError("--sample must be an integer within [0, 100]");
  if (!Number.isInteger(cognitionEveryEvents) || cognitionEveryEvents < 1 || cognitionEveryEvents > 100_000) {
    throw new TypeError("--cognition-every must be an integer within [1, 100000]");
  }
  const episodeEveryEvents = Number(option("--episode-every") ?? 25);
  const episodeElapsedMs = Number(option("--episode-elapsed-ms") ?? 300_000);
  if (!Number.isSafeInteger(episodeEveryEvents) || episodeEveryEvents < 1 || episodeEveryEvents > 100_000) throw new TypeError("--episode-every must be an integer within [1, 100000]");
  if (!Number.isSafeInteger(episodeElapsedMs) || episodeElapsedMs < 1 || episodeElapsedMs > 86_400_000) throw new TypeError("--episode-elapsed-ms must be an integer within [1, 86400000]");

  const autoPromote = args.includes("--auto-promote");
  const trustedSensorId = process.env.SUPER_BRAIN_TRUSTED_CAPTURE_SENSOR;
  const captureStateRoot = process.env.SUPER_BRAIN_TRUSTED_CAPTURE_STATE_ROOT;
  const captureVaultRoot = process.env.SUPER_BRAIN_TRUSTED_CAPTURE_VAULT_ROOT;
  const receiptKeyPath = process.env.SUPER_BRAIN_TRUSTED_CAPTURE_RECEIPT_KEY_FILE;
  const captureKeyPath = process.env.SUPER_BRAIN_TRUSTED_CAPTURE_VAULT_KEY_FILE;
  const captureReceiptKey = receiptKeyPath === undefined ? undefined : await readVaultKey(receiptKeyPath);
  const verifyCapturedEvent = trustedSensorId && captureStateRoot && captureVaultRoot && receiptKeyPath
    ? createCapturedEventVerifier({ organizationId, workspaceId, trustedSensorId, stateRoot: captureStateRoot, vaultRoot: captureVaultRoot,
      receiptEncryptionKey: captureReceiptKey!,
      ...(captureKeyPath === undefined ? {} : { vaultEncryptionKey: await readVaultKey(captureKeyPath) }) }) : undefined;
  const verifyCapturedTrajectory = trustedSensorId && captureStateRoot && captureReceiptKey
    ? createCapturedTrajectoryVerifier({ organizationId, workspaceId, trustedSensorId, stateRoot: captureStateRoot, receiptEncryptionKey: captureReceiptKey }) : undefined;
  if (autoPromote && verifyCapturedEvent === undefined) console.error("[memory-worker] Promotion is disabled until an explicit capture witness verifier is configured");
  const statusFile = process.env.SUPER_BRAIN_WORKER_STATUS_FILE ?? join(resolvedStateRoot, "processing-status.json");
  const worker = new TranscriptMemoryWorker({
    client,
    vaultRoot,
    maxCandidatesPerRun,
    audience,
    autoPromote,
    continuousCognition: (command === "watch" || command === "retry") && !args.includes("--no-continuous-cognition"),
    cognitionEveryEvents,
    episodeFormation: ["watch", "retry", "retry-jobs", "queue-episodes"].includes(command) && !args.includes("--no-episodes"),
    episodeEveryEvents,
    episodeElapsedMs,
    ...(stateRoot === undefined ? {} : { stateRoot }),
    statusFile,
    ...(spaceId === undefined ? {} : { spaceId }),
    ...(verifyCapturedEvent === undefined ? {} : { verifyCapturedEvent }),
    ...(verifyCapturedTrajectory === undefined ? {} : { verifyCapturedTrajectory }),
    ...(process.env.SUPER_BRAIN_COGNITION_PROVIDER === undefined ? {} : { cognitionProviderId: process.env.SUPER_BRAIN_COGNITION_PROVIDER }),
    reportWarning: (message) => console.error(`[memory-worker] ${message}`),
    ...(vaultEncryptionKey === undefined ? {} : { vaultEncryptionKey }),
  });
  if (command === "jobs") {
    try { process.stdout.write(`${JSON.stringify({ coverage: await worker.coverage(), scheduling: await worker.schedulingCoverage() }, null, 2)}\n`); }
    catch (error) {
      if (!(error instanceof Error) || !/owns this processing namespace|acquired the processing namespace/.test(error.message)) throw error;
      // A running watcher owns the ledger; report its last sanitized status publication instead.
      process.stdout.write(`${JSON.stringify({ source: "running-worker-status", status: JSON.parse(await readFile(statusFile, "utf8")) as unknown }, null, 2)}\n`);
    } finally { await worker.close(); }
    return;
  }
  if (command === "retry-jobs") {
    if (!args.includes("--confirm")) throw new TypeError("retry-jobs requires --confirm; inspect jobs first and stop the worker before retrying");
    try { process.stdout.write(`${JSON.stringify({ requeued: await worker.retryBlocked() })}\n`); }
    finally { await worker.close(); }
    return;
  }
  if (command === "repair-evidence") {
    const apply = args.includes("--confirm");
    try { process.stdout.write(`${JSON.stringify({ mode: apply ? "apply" : "dry-run", ...await worker.repairAcceptedEvidence(apply) }, null, 2)}\n`); }
    finally { await worker.close(); }
    return;
  }
  if (command === "queue-episodes") {
    const eventIds = args.flatMap((arg, index) => arg === "--event-id" ? [required(args[index + 1]?.startsWith("--") === true ? undefined : args[index + 1], "--event-id")] : []);
    const projectId = required(option("--project-id"), "--project-id");
    try { process.stdout.write(`${JSON.stringify(await worker.queueEpisodeSources(eventIds, projectId, args.includes("--confirm")), null, 2)}\n`); }
    finally { await worker.close(); }
    return;
  }
  if (command === "queue-backfill") {
    try { process.stdout.write(`${JSON.stringify(await worker.queueTranscriptBackfill(args.includes("--confirm"), limit), null, 2)}\n`); }
    finally { await worker.close(); }
    return;
  }
  if (command === "retry") {
    try { await worker.retryJob(required(option("--job"), "--job")); await worker.drainModelJobs(); await worker.drainJobs(); process.stdout.write(`${JSON.stringify(await worker.coverage())}\n`); }
    finally { await worker.close(); }
    return;
  }
  if (command === "watch") {
    const shutdown = new AbortController();
    const stop = () => shutdown.abort();
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    try { await worker.watch({
      signal: shutdown.signal,
      consumerId,
      ...(args.includes("--replay-all") ? { replay: "all" } : {}),
    }); } finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); await worker.close(); }
    return;
  }

  try {
  const archive = await worker.archiveRuns();
  const runs = limit === undefined ? archive.runs : archive.runs.slice(0, limit);
  const results = [];
  const samples: Array<{ readonly runId: string; readonly source: string; readonly summary: string; readonly confidence: number; readonly projectIds: readonly string[] }> = [];
  const extractedCandidates: ExtractedCandidate[] = [];
  for (const run of runs) {
    const runEventId = archive.eventIds.get(run.id);
    if (runEventId === undefined) {
      results.push({ runId: run.id, candidates: 0, proposed: 0, skippedReason: "run event unavailable" });
      continue;
    }
    const result = await worker.processRun(run, runEventId, command === "backfill");
    extractedCandidates.push(...result.candidates);
    for (const candidate of result.candidates) {
      if (samples.length >= sample) break;
      samples.push({ runId: run.id, source: candidate.source, summary: candidate.summary, confidence: candidate.confidence, projectIds: candidate.projectIds ?? [] });
    }
    results.push({ runId: run.id, candidates: result.candidates.length, proposed: result.proposed, ...(result.skippedReason === undefined ? {} : { skippedReason: result.skippedReason }) });
  }
  let proposed = results.reduce((total, result) => total + result.proposed, 0);
  let promoted = 0;
  if (command === "backfill") {
    // Finish runnable work; waiting artifacts and retryable failures remain durable for watch/retry.
    while (true) {
      const before = await worker.coverage();
      const more = await worker.drainJobs(); proposed += more.proposed; promoted += more.promoted;
      const after = await worker.coverage();
      if (after.pending === 0 || after.pending >= before.pending && after.completed === before.completed) break;
    }
  }
  const bySource = extractedCandidates.reduce<Record<string, number>>((counts, candidate) => {
    counts[candidate.source] = (counts[candidate.source] ?? 0) + 1;
    return counts;
  }, {});
  const projectScoped = extractedCandidates.filter((candidate) => (candidate.projectIds?.length ?? 0) > 0).length;
  process.stdout.write(`${JSON.stringify({
    mode: command,
    runs: results.length,
    candidates: results.reduce((total, result) => total + result.candidates, 0),
    proposed,
    promoted,
    skippedRuns: results.filter((result) => result.skippedReason !== undefined).length,
    bySource,
    projectScoped,
    unresolved: extractedCandidates.length - projectScoped,
    ...(samples.length === 0 ? {} : { samples }),
    results,
    ...(command === "backfill" ? { processing: await worker.coverage() } : {}),
  }, null, 2)}\n`);
  } finally { await worker.close(); }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
