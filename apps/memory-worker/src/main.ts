#!/usr/bin/env node
import { SuperBrainClient } from "@_89/super-brain-client";
import { readVaultKey } from "@_89/super-brain-importer";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { join } from "node:path";
import { effectiveMemoryApplicability } from "@_89/fold-epistemic";
import { ProcessingJobStore, processingDigest, readProcessingCoverage } from "./jobs.js";
import { migrateWorkerCursor, resetWorkerCursor } from "./cursor-migration.js";
import { readSchedulingCoverage } from "./scheduler.js";

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
  if (!["scan", "backfill", "queue-backfill", "queue-episodes", "watch", "repair-evidence", "jobs", "retry-jobs", "migrate-cursor", "reset-cursor"].includes(command)) {
    throw new TypeError("supported commands: scan, backfill, queue-backfill, queue-episodes, watch, repair-evidence, jobs, retry-jobs, migrate-cursor, reset-cursor, install-service");
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
  const audience = option("--audience") ?? "workspace";
  if (audience !== "personal" && audience !== "workspace") throw new TypeError("--audience must be personal or workspace");
  const namespace = processingDigest([baseUrl.replace(/\/+$/, ""), organizationId, workspaceId, audience, consumerId]);
  const processingRoot = join(option("--processing-root") ?? process.env.FOLD_MEMORY_PROCESSING_ROOT ?? join(homedir(), ".local", "state", "super-brain", "memory-worker", "jobs"), namespace);
  const credentialFingerprint = processingDigest(token);
  if (command === "reset-cursor") {
    process.stdout.write(`${JSON.stringify(await resetWorkerCursor({
      client, consumerId, organizationId, workspaceId, audience, processingRoot, credentialFingerprint,
      expectedSequence: required(option("--expected-sequence"), "--expected-sequence"),
      reason: required(option("--reason"), "--reason"), confirm: args.includes("--confirm"),
    }), null, 2)}\n`);
    return;
  }
  if (command === "migrate-cursor") {
    process.stdout.write(`${JSON.stringify(await migrateWorkerCursor({
      client, consumerId, organizationId, workspaceId, audience, processingRoot, credentialFingerprint,
      confirm: args.includes("--confirm"),
    }), null, 2)}\n`);
    return;
  }
  if (command === "jobs") {
    process.stdout.write(`${JSON.stringify({ ...await readProcessingCoverage(processingRoot), scheduling: await readSchedulingCoverage(processingRoot) }, null, 2)}\n`);
    return;
  }
  if (command === "retry-jobs") {
    if (!args.includes("--confirm")) throw new TypeError("retry-jobs requires --confirm; inspect jobs first and stop the worker before retrying");
    const store = new ProcessingJobStore(processingRoot, credentialFingerprint);
    await store.open();
    try { process.stdout.write(`${JSON.stringify({ requeued: await store.retryBlocked() })}\n`); } finally { await store.close(); }
    return;
  }
  if (command === "repair-evidence") {
    const apply = args.includes("--confirm");
    const worker = new TranscriptMemoryWorker({ client, vaultRoot: "" });
    process.stdout.write(`${JSON.stringify({ mode: apply ? "apply" : "dry-run", ...await worker.repairAcceptedEvidence(apply) }, null, 2)}\n`);
    return;
  }
  const vaultRoot = command === "queue-episodes" ? "" : required(option("--vault") ?? process.env.FOLD_TRANSCRIPT_VAULT, "FOLD_TRANSCRIPT_VAULT");
  const vaultKeyPath = option("--vault-key") ?? process.env.FOLD_TRANSCRIPT_VAULT_KEY_FILE;
  const vaultEncryptionKey = vaultKeyPath === undefined || command === "queue-backfill" || command === "queue-episodes" ? undefined : await readVaultKey(vaultKeyPath);
  const maxValue = option("--max-per-run");
  const maxCandidatesPerRun = maxValue === undefined ? 25 : Number(maxValue);
  if (!Number.isInteger(maxCandidatesPerRun) || maxCandidatesPerRun < 1 || maxCandidatesPerRun > 500) throw new TypeError("--max-per-run must be a page size within [1, 500]");
  const limitValue = option("--limit");
  const limit = limitValue === undefined ? undefined : Number(limitValue);
  const sampleValue = option("--sample");
  const sample = sampleValue === undefined ? 0 : Number(sampleValue);
  const cognitionEveryValue = option("--cognition-every");
  const cognitionEveryEvents = cognitionEveryValue === undefined ? 25 : Number(cognitionEveryValue);
  const cognitionElapsedMs = Number(option("--cognition-elapsed-ms") ?? 300_000);
  if (!Number.isSafeInteger(cognitionElapsedMs) || cognitionElapsedMs < 1 || cognitionElapsedMs > 86_400_000) throw new TypeError("--cognition-elapsed-ms must be an integer within [1, 86400000]");
  const episodeEveryEvents = Number(option("--episode-every") ?? 25);
  const episodeElapsedMs = Number(option("--episode-elapsed-ms") ?? 300_000);
  if (!Number.isSafeInteger(episodeEveryEvents) || episodeEveryEvents < 1 || episodeEveryEvents > 100_000) throw new TypeError("--episode-every must be an integer within [1, 100000]");
  if (!Number.isSafeInteger(episodeElapsedMs) || episodeElapsedMs < 1 || episodeElapsedMs > 86_400_000) throw new TypeError("--episode-elapsed-ms must be an integer within [1, 86400000]");
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new TypeError("--limit must be a positive integer");
  if (!Number.isInteger(sample) || sample < 0 || sample > 100) throw new TypeError("--sample must be an integer within [0, 100]");
  if (!Number.isInteger(cognitionEveryEvents) || cognitionEveryEvents < 1 || cognitionEveryEvents > 100_000) {
    throw new TypeError("--cognition-every must be an integer within [1, 100000]");
  }

  const autoPromote = args.includes("--auto-promote");
  const worker = new TranscriptMemoryWorker({
    client,
    vaultRoot,
    maxCandidatesPerRun,
    audience,
    autoPromote,
    continuousCognition: command === "watch" && !args.includes("--no-continuous-cognition"),
    cognitionEveryEvents,
    cognitionElapsedMs,
    episodeFormation: ["watch", "queue-episodes"].includes(command) && !args.includes("--no-episodes"),
    episodeEveryEvents,
    episodeElapsedMs,
    reportWarning: (message) => console.error(`[memory-worker] ${message}`),
    processingRoot,
    credentialFingerprint,
    ...(vaultEncryptionKey === undefined ? {} : { vaultEncryptionKey }),
  });
  if (command === "queue-episodes") {
    const eventIds = args.flatMap((arg, index) => arg === "--event-id" ? [required(args[index + 1]?.startsWith("--") === true ? undefined : args[index + 1], "--event-id")] : []);
    const projectId = required(option("--project-id"), "--project-id");
    if (!args.includes("--confirm")) process.stdout.write(`${JSON.stringify(await worker.queueEpisodeSources(eventIds, projectId), null, 2)}\n`);
    else {
      const store = new ProcessingJobStore(processingRoot, credentialFingerprint); await store.open();
      try { process.stdout.write(`${JSON.stringify(await worker.queueEpisodeSources(eventIds, projectId, store), null, 2)}\n`); }
      finally { await store.close(); }
    }
    return;
  }
  if (command === "queue-backfill") {
    if (!args.includes("--confirm")) {
      process.stdout.write(`${JSON.stringify(await worker.queueTranscriptBackfill(undefined, limit), null, 2)}\n`);
      return;
    }
    const store = new ProcessingJobStore(processingRoot, credentialFingerprint);
    await store.open();
    try { process.stdout.write(`${JSON.stringify(await worker.queueTranscriptBackfill(store, limit), null, 2)}\n`); }
    finally { await store.close(); }
    return;
  }
  if (command === "watch") {
    await worker.watch({
      consumerId,
      ...(args.includes("--replay-all") ? { replay: "all" } : {}),
    });
    return;
  }

  const archive = await worker.archiveRuns();
  const runs = limit === undefined ? archive.runs : archive.runs.slice(0, limit);
  const results = [];
  const samples: Array<{ readonly runId: string; readonly source: string; readonly summary: string; readonly confidence: number; readonly projectIds: readonly string[] }> = [];
  const extractedCandidates: ExtractedCandidate[] = [];
  for (const run of runs) {
    const runEventId = archive.eventIds.get(run.id);
    if (runEventId === undefined) {
      results.push({ runId: run.id, candidates: 0, proposed: 0, promoted: 0, skippedReason: "run event unavailable" });
      continue;
    }
    const result = await worker.processRun(run, runEventId, command === "backfill");
    extractedCandidates.push(...result.candidates);
    for (const candidate of result.candidates) {
      if (samples.length >= sample) break;
      samples.push({ runId: run.id, source: candidate.source, summary: candidate.summary, confidence: candidate.confidence, projectIds: candidate.projectIds ?? [] });
    }
    results.push({ runId: run.id, candidates: result.candidates.length, proposed: result.proposed, promoted: result.promoted, ...(result.skippedReason === undefined ? {} : { skippedReason: result.skippedReason }) });
  }
  const proposed = results.reduce((total, result) => total + result.proposed, 0);
  const promoted = results.reduce((total, result) => total + result.promoted, 0);
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
    general: extractedCandidates.filter((candidate) => effectiveMemoryApplicability({ ...candidate, projectIds: candidate.projectIds ?? [] }) === "general").length,
    unresolved: extractedCandidates.filter((candidate) => effectiveMemoryApplicability({ ...candidate, projectIds: candidate.projectIds ?? [] }) === "unresolved").length,
    ...(samples.length === 0 ? {} : { samples }),
    results,
  }, null, 2)}\n`);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
